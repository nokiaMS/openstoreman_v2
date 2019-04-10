"use strict";
const {
  getGlobalChain,
  sleep
} = require('../comm/lib');

const ModelOps = require('../db/modelOps');

const moduleConfig = require('../conf/moduleConfig.js');
const configJson = require('../conf/config.json');
const config = configJson.main;

const retryTimes = moduleConfig.retryTimes;
const retryWaitTime = moduleConfig.retryWaitTime;

var stateDict = {
  coinTransfer: {
    action: 'handleCoinTransfer',
    paras: [
        ['coinTransfer'],['coinTransferDone', 'debtOutOfTryTimes']]
  },
  debtTransfer: {
    action: 'handleDebtTransfer',
    paras: [
        ['approve'], ['debtApproved'], ['debtTransfer', 'debtOutOfTryTimes']
    ]
  },
    debtApproved: {
    action: 'handleDebtTransfer',
    paras: [
        ['debtLock'], ['debtWaitingWanInboundLock'], ['debtApproved', 'debtOutOfTryTimes']
    ]
  },
  debtWaitingWanInboundLock: {
    action: 'handleDebtTransfer',
    paras: [
        ['redeem'], ['debtTransferDone'], ['debtWaitingWanInboundLock', 'debtOutOfTryTimes']
    ]
  }
};

module.exports = class stateAction {
  constructor(record, logger, db) {
    this.record = record;
    this.crossChain = record.crossChain;
    this.tokenType = record.tokenType;
    this.hashX = record.hashX;
    this.state = record.status;
    this.crossDirection = record.direction;
    this.logger = logger;
    this.db = db;
    this.modelOps = new ModelOps(logger, db);
    this.logger.debug("====>stateAction hashX:", this.hashX, "status:", this.state);
  }

  async updateRecord(content) {
    this.logger.debug("====>updateRecord hashX:", this.hashX, "content:", content);
    await this.modelOps.syncSave(this.hashX, content);
  }

  async updateState(state) {
    this.logger.debug("====> updateState hashX:", this.hashX, "status:", state);
    let content = {
      status: state,
    };
    this.state = state;
    await this.updateRecord(content);
  }

  async updateFailReason(action, err) {
    let error = (err.hasOwnProperty("message")) ? err.message : err;
    let failReason = action + ' ' + error;
    this.logger.debug("====>updateFailReason hashX:", this.hashX, "failReason:", failReason);
    let content = {
      failAction: action,
      failReason: failReason
    };
    await this.updateRecord(content);
  }

  takeAction() {
  	let self = this;
    return new Promise(async (resolve, reject) => {
      try {
        if (!await self.checkHashTimeout()) {
          if (stateDict[self.state].hasOwnProperty('action')) {
            let action = stateDict[self.state].action;
            if (typeof(self[action]) === "function") {
              let paras = stateDict[self.state].paras;
              self.logger.debug("====>takeAction hashX:", this.hashX, action, paras)
              await self[action](...paras);
            }
          }
          // resolve();
        }
        resolve();
      } catch (err) {
        self.logger.error("There is takeAction error", err);
        reject(err);
      }
    })
  }

  //add by lgj
  async hasStoremanLockEvent() {
    var blkTo = await global['wanChain'].getBlockNumberSync();
    var blkFrom = blkTo - 2000;
    if (blkTo < 2000) blkFrom = 0;
    console.log("BlockFromTo:", blkFrom, blkTo);
    var address = moduleConfig.crossInfoDict.ETH.ERC20.wanchainHtlcAddr;
    var topic = [null, null, null, this.hashX];
    console.log(address, topic, blkFrom, blkTo);

    var events = await getGlobalChain('wan').getScEventSync(address, topic, blkFrom, blkTo);
    console.log("hasStoremanLockEvent:", events);

    return (events.length > 0);
  }

  async handleCoinTransfer(actionArray, nextState) {
    this.logger.debug("====> handleCoinTransfer begin");

    /*
    this.logger.debug("******** handleCoinTransfer record info ********");
    this.logger.debug(this.record);
    this.logger.debug("******** handleCoinTransfer record info end ********");
    */

    let result = {};
    let newAgent;
    try {
      if (this.record.transRetried !== 0) {
        this.logger.debug("====> handleCoinTransfer asleep");
        await sleep(retryWaitTime);
        this.logger.debug("====> handleCoinTransfer asleep wake up");
      }
        for (var action of actionArray) {
          //console.log('hasStoremanLockEvent', action);
                if(this.record.coinTransferChain === 'wan') {
                    newAgent = new global.agentDict[this.crossChain.toUpperCase()][this.tokenType](this.crossChain, this.tokenType, this.crossDirection, this.record);
                } else if(this.record.coinTransferChain === 'eth'){
                    newAgent = new global.agentDict[this.crossChain.toUpperCase()][this.tokenType](this.crossChain, this.tokenType, this.crossDirection, this.record, 'handleDebtTransfer');
                }
                //let newAgent = new global.agentDict[this.crossChain.toUpperCase()][this.tokenType](this.crossChain, this.tokenType, this.crossDirection, this.record, 'handleDebtTransfer');
                this.logger.debug("====> handleCoinTransfer sendTrans begin, hashX:", this.hashX, "action:", action);
                await newAgent.initAgentTransInfo(action);

                /*Change source address.*/
                if(action === 'coinTransfer') {
                  if(this.record.coinTransferChain === 'wan') {
                      newAgent.trans.txParams.from = config.storemanWan;
                  } else {
                      newAgent.trans.txParams.from = config.storemanEth;
                  }
                  newAgent.trans.txParams.to = this.record.toHtlcAddr;
                  newAgent.trans.txParams.value = this.record.value;
                }
                newAgent.createTrans('coinTransfer');
                newAgent.trans.txParams.data = '';

                /*
                this.logger.debug("******** handleCoinTransfer transaction info ********");
                this.logger.debug(newAgent.trans);
                this.logger.debug("******** handleCoinTransfer transaction info end ********");
                */

                if (config.isLeader || !(moduleConfig.mpcSignature)) {
                    let content = await newAgent.sendTransSync();
                    this.logger.debug("====> handleCoinTransfer sendTransSync done, hashX:", this.hashX, "action:", action);
                    //this.logger.debug("====> sendTrans result is ", content);
                    Object.assign(result, content);
                } else {
                    await newAgent.validateTrans();
                    this.logger.debug("====> handleCoinTransfer validateTrans done, hashX:", this.hashX, "action:", action);
                }

                result.transRetried = 0;
                result.status = nextState[0];
                await this.updateRecord(result);
            }
        } catch (err) {
            this.logger.error("====> handleCoinTransfer sendTransaction faild, action:", action, ", and record.hashX:", this.hashX);
            this.logger.error("====> handleCoinTransfer sendTransaction faild err is", err);
            if (this.record.transRetried < retryTimes) {
                result.transRetried = this.record.transRetried + 1;
            } else {
                result.transRetried = 0;
                result.status = rollState[1];
                await this.updateFailReason(action, err);
            }
            await this.updateRecord(result);
            this.logger.debug(result);
        }
    }

  async handleDebtTransfer(actionArray, nextState, rollState) {
    this.logger.debug("====> handleDebtTransfer begin");

    /*
    this.logger.debug("******** handleDebtTransfer record info ********");
    this.logger.debug(this.record);
    this.logger.debug("******** handleDebtTransfer record info end ********");
    */

    let result = {};
    let newAgent;
    try {
      if (this.record.transRetried !== 0) {
        this.logger.debug("====> handleDebtTransfer asleep");
        await sleep(retryWaitTime);
        this.logger.debug("====> handleDebtTransfer asleep wake up");
      }
      for (var action of actionArray) {
        //console.log('hasStoremanLockEvent', action);
        if((action === 'redeem') && (!(await this.hasStoremanLockEvent()))) {
            console.log("====>Action:", action,"Not receive inboundLock event from target smg.");
            return;
        }

        if(action === 'redeem') {
            newAgent = new global.agentDict[this.crossChain.toUpperCase()][this.tokenType](this.crossChain, this.tokenType, this.crossDirection, this.record);
        } else {
            newAgent = new global.agentDict[this.crossChain.toUpperCase()][this.tokenType](this.crossChain, this.tokenType, this.crossDirection, this.record, 'handleDebtTransfer');
        }
        //let newAgent = new global.agentDict[this.crossChain.toUpperCase()][this.tokenType](this.crossChain, this.tokenType, this.crossDirection, this.record, 'handleDebtTransfer');
        this.logger.debug("====> handleDebtTransfer sendTrans begin, hashX:", this.hashX, "action:", action);
        await newAgent.initAgentTransInfo(action);

        /*Change redeem source address.*/
        if(action === 'redeem') {
          newAgent.trans.txParams.from = config.storemanWan;
        }
        newAgent.createTrans(action);

        /*
        this.logger.debug("******** handleDebtTransfer transaction info ********");
        this.logger.debug(newAgent.trans);
        this.logger.debug("******** handleDebtTransfer transaction info end ********");
        */

        if (config.isLeader || !(moduleConfig.mpcSignature)) {
          let content = await newAgent.sendTransSync();
          this.logger.debug("====> handleDebtTransfer sendTransSync done, hashX:", this.hashX, "action:", action);
          //this.logger.debug("sendTrans result is ", content);
          Object.assign(result, content);
        } else {
          await newAgent.validateTrans();
          this.logger.debug("====> handleDebtTransfer validateTrans done, hashX:", this.hashX, "action:", action);
        }

        result.transRetried = 0;
        result.status = nextState[0];
        await this.updateRecord(result);
      }
    } catch (err) {
      this.logger.error("====> handleDebtTransfer sendTransaction faild, action:", action, ", and record.hashX:", this.hashX);
      this.logger.error("====> handleDebtTransfersendTransaction faild err is", err);
      if (this.record.transRetried < retryTimes) {
        result.transRetried = this.record.transRetried + 1;
      } else {
        result.transRetried = 0;
        result.status = rollState[1];
        await this.updateFailReason(action, err);
      }
      await this.updateRecord(result);
      this.logger.debug(result);
    }
  }

  async checkHashTimeout() {
    return false;
  }
}