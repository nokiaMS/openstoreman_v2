"use strict"

const Logger = require('./comm/logger.js');

const Web3 = require("web3");
const web3 = new Web3();

const mongoose = require('mongoose');
const ModelOps = require('./db/modelOps');
const Erc20CrossAgent = require("./agent/Erc20CrossAgent.js");
const EthCrossAgent = require("./agent/EthCrossAgent.js");
const StateAction = require("./monitor/monitor.js");

const createKeccakHash = require('keccak');
const moduleConfig = require('./conf/moduleConfig.js');
const configJson = require('./conf/config.json');
const config = configJson.main;

const {
  initChain,
  initNonce,
  getGlobalChain,
  backupIssueFile,
  sleep
} = require('./comm/lib');

let handlingList = {};

let tokenList = {};

global.storemanRestart = false;

global.agentDict = {
  ETH: {
    COIN: EthCrossAgent,
    ERC20: Erc20CrossAgent
  }
}

global.syncLogger = new Logger("syncLogger", "log/storemanAgent.log", "log/storemanAgent_error.log", 'debug');
global.monitorLogger = new Logger("storemanAgent", "log/storemanAgent.log", "log/storemanAgent_error.log", 'debug');

async function init() {
  try {
    initChain('wan');
    await initNonce('wan');
    global.wanNonceRenew = false;
    global.wanNoncePending = false;

    global.storemanRestart = true;
    backupIssueFile();

    tokenList.supportTokenAddrs = [];
    tokenList.wanchainHtlcAddr = [];
    tokenList.originalChainHtlcAddr = [];
    for (let crossChain in moduleConfig.crossInfoDict) {

      global[crossChain + 'NonceRenew'] = false;
      global[crossChain + 'NoncePending'] = false;

      initChain(crossChain);
      await initNonce(crossChain);

      tokenList[crossChain] = {};

      tokenList[crossChain].supportTokens = {};

      for (let token in config["crossTokens"][crossChain]) {
        tokenList.supportTokenAddrs.push(token);
        tokenList[crossChain].supportTokens[token] = config["crossTokens"][crossChain][token].tokenSymbol;
      }

      for (let tokenType in moduleConfig.crossInfoDict[crossChain]) {
        tokenList[crossChain][tokenType] = {};

        tokenList[crossChain][tokenType].wanchainHtlcAddr = moduleConfig.crossInfoDict[crossChain][tokenType].wanchainHtlcAddr;
        tokenList[crossChain][tokenType].originalChainHtlcAddr = moduleConfig.crossInfoDict[crossChain][tokenType].originalChainHtlcAddr;

        tokenList.wanchainHtlcAddr.push(moduleConfig.crossInfoDict[crossChain][tokenType].wanchainHtlcAddr);
        tokenList.originalChainHtlcAddr.push(moduleConfig.crossInfoDict[crossChain][tokenType].originalChainHtlcAddr);

        tokenList[crossChain][tokenType].wanCrossAgent = new global.agentDict[crossChain][tokenType](crossChain, tokenType, 0);
        tokenList[crossChain][tokenType].originCrossAgent = new global.agentDict[crossChain][tokenType](crossChain, tokenType, 1);
        tokenList[crossChain][tokenType].lockedTime = await tokenList[crossChain][tokenType].wanCrossAgent.getLockedTime();
      }
    }
    monitorLogger.info(tokenList);

    for (let crossChain in moduleConfig.crossInfoDict) {
      syncLogger.debug("Nonce of chain:", crossChain, global[crossChain.toLowerCase() + 'LastNonce']);
    }
    syncLogger.debug("Nonce of chain:", 'WAN', global['wanLastNonce']);
  } catch (err) {
    console.log("init error ", err);
    process.exit();
  }
}

function splitData(string) {
  let index = 64;
  let arr = [];
  for (var i = 2; i < string.length;) {
    arr.push(string.substr(i, index));
    i = i + index;
  }
  return arr;
}

async function syncChain(chainType, crossChain, tokenType, scAddrList, logger, db) {
  logger.debug("====> syncChain:", chainType, crossChain, tokenType);
  let blockNumber = 0;
  try {
    blockNumber = await modelOps.getScannedBlockNumberSync(chainType);
    if (blockNumber > moduleConfig.SAFE_BLOCK_NUM) {
      blockNumber -= moduleConfig.SAFE_BLOCK_NUM;
    } else {
      blockNumber = moduleConfig.startSyncBlockNum[chainType.toUpperCase()];
    }
    logger.info("Current blockNumber in db is:", blockNumber, chainType);
  } catch (err) {
    logger.error(err);
    return;
  }

  let chain = getGlobalChain(chainType);
  let curBlock = 0;

  try {
    curBlock = await chain.getBlockNumberSync();
    logger.info("Current block is:", curBlock, chainType);
  } catch (err) {
    logger.error("getBlockNumberSync from :", chainType, err);
    return;
  }
}

async function syncMain(logger, db) {
  let ethBlockNumber, wanBlockNumber;

  while (1) {
    try {
      for (let crossChain in moduleConfig.crossInfoDict) {
        for (let tokenType in moduleConfig.crossInfoDict[crossChain]) {
          let scAddrList = {'htlcAddr':tokenList[crossChain][tokenType].originalChainHtlcAddr};
          syncChain(crossChain.toLowerCase(), crossChain, tokenType, scAddrList, logger, db);

          scAddrList = {'htlcAddr':tokenList[crossChain][tokenType].wanchainHtlcAddr};
          syncChain('wan', crossChain, tokenType, scAddrList, logger, db);
        }
      }
    } catch (err) {
      logger.error("syncMain failed:", err);
    }

    await sleep(moduleConfig.INTERVAL_TIME);
  }
}

/* When storeman restart, change all waitingIntervention state to interventionPending, to auto retry the test*/
async function updateRecordAfterRestart(logger) {
    let option = {
        status: {
            $in: ['debtOutOfTryTimes']
        }
    }
    let changeList = await modelOps.getEventHistory(option);
    logger.debug('changeList length is ', changeList.length);
    for (let i = 0; i < changeList.length; i++) {
        let content = {
            status: 'stateChange'
        }
        let record = changeList[i];
        await modelOps.syncSave(record.hashX, content);
    }
    logger.debug('updateRecordAfterRestart finished!');
}

function monitorRecord(record) {
  let stateAction = new StateAction(record, global.monitorLogger, db);
  stateAction.takeAction()
    .then(result => {
      if (handlingList[record.hashX]) {
        monitorLogger.debug("handlingList delete already handled hashX", record.hashX);
        delete handlingList[record.hashX];
      }
    })
    .catch(err => global.monitorLogger.error(err));
}

async function handlerMain(logger, db) {
  while (1) {
    logger.info("====> handlerMain start");

    try {
      /* get debtTransfer event from db.*/
      let debtOption = {
        status: {
          $in: ['debtTransfer', 'coinTransfer', 'debtWaitingWanInboundLock','debtSendingRedeem','debtSendingRevoke', 'debtApproved', 'stateChange']
        }
      }

      let debtHistory = await modelOps.getEventHistory(debtOption);
      logger.debug('debt transfer history length is ', debtHistory.length);

      for (let i = 0; i < debtHistory.length; i++) {
        let record = debtHistory[i];

        let cur = Date.now();
        if (handlingList[record.hashX]) {
          continue;
        }
        handlingList[record.hashX] = cur;

        try {
          monitorRecord(record);
        } catch (error) {
          logger.error("debt transfer monitorRecord error:", error);
        }
      }
    } catch (err) {
      logger.error("debt transfer handler error:", error);
    }
    await sleep(moduleConfig.INTERVAL_TIME);
  }
}

let db = mongoose.createConnection(moduleConfig.crossEthDbUrl, {
  useNewUrlParser: true
});
db.on('connected', function(err) {
  if (err) {
    global.syncLogger.error('Unable to connect to database(' + dbUrl + ')：' + err);
    global.syncLogger.error('Aborting');
    process.exit();
  } else {
    global.syncLogger.info('Connecting to database is successful!');
  }
});

let modelOps = new ModelOps(global.syncLogger, db);

function getHashKey(key){
    let kBuf = new Buffer(key.slice(2), 'hex');
    let h = createKeccakHash('keccak256');
    h.update(kBuf);
    let hashKey = '0x' + h.digest('hex');
    global.monitorLogger.info("====> getHashKey, key:", key, "hash:",hashKey);
    return hashKey;
}

async function updateDebtOptionsToDb() {
    //1. get configuration.
    let debtOperationsConfig = require('./conf/debtOpts.json');
    let debtOperations = debtOperationsConfig.debtOperations;
    let coinOperations = debtOperationsConfig.coinOperations;
    let lockedTime = tokenList.ETH.ERC20.lockedTime;

    //2. make db content and save to db.
    debtOperations.forEach(async function (item, index, array) {
        //2.1 get parameters
        let hashX = getHashKey(item.x);
        global.monitorLogger.info("====> Get task from configuration file:", item);

        //2.2 check whether hash has been dealed with.
        let option = {
            hashX: {
                $in: [hashX]
            }
        };
        let result = await modelOps.getEventHistory(option);
        if(result.length > 0) {
            global.monitorLogger.info("====> Task x:", item.x, "exists, so ignore it.");
            return;
        }

        let content = {
            hashX: hashX,
            x: item.x,
            direction: 0,
            crossChain: 'eth',
            tokenType: 'ERC20',
            tokenAddr: item.tokenAddr,       //token address.
            crossAddress: item.wanAddr,   //wan address of the stopping storeman group.
            toHtlcAddr: item.targetSmgAddr,      //address of the target storeman group.
            value: item.value,               //value for cross-transfer.
            HTLCtime: (1000 * lockedTime + Date.now()).toString(),    //htlc time.
            status: 'debtTransfer'
        };
        //save content to db.
        let dbContent = [hashX, content];
        modelOps.saveScannedEvent(...dbContent);
    });

    //3. make db content and save to db.
    coinOperations.forEach(async function (item, index, array) {
        //1. check whether hash has been dealed with.
        let option = {
            hashX: {
                $in: [item.hashX]
            }
        };
        let result = await modelOps.getEventHistory(option);
        if(result.length > 0) {
            global.monitorLogger.info("====> Task x:", item.index, "exists, so ignore it.");
            return;
        }

        //2. get parameters
        let content = {
            hashX: item.hashX,
            direction: 0,
            crossChain: 'eth',
            tokenType: 'ERC20',
            toHtlcAddr: item.targetAddr,      //address of the target storeman group.
            value: web3.toHex(item.value),                //value for cross-transfer.
            status: 'coinTransfer',
            coinTransferChain: item.targetChain //target chain
        };
        //save content to db.
        let dbContent = [item.id, content];
        modelOps.saveScannedEvent(...dbContent);
    });
}

async function main() {
  global.syncLogger.info("start storeman agent");
  await init();

  //Get debt transaction configurations from configuration file.
  updateDebtOptionsToDb();
  syncMain(global.syncLogger, db);
  await updateRecordAfterRestart(global.monitorLogger);
  handlerMain(global.monitorLogger, db);
}
main();