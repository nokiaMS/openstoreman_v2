"use strict"

const Logger = require('comm/logger.js');

const mongoose = require('mongoose');
const ModelOps = require('db/modelOps');
const Erc20CrossAgent = require("agent/Erc20CrossAgent.js");
const EthCrossAgent = require("agent/EthCrossAgent.js");
const StateAction = require("monitor/monitor.js");

const moduleConfig = require('conf/moduleConfig.js');
const configJson = require('conf/config.json');
const config = moduleConfig.testnet?configJson.testnet:configJson.main;

const {
  initChain,
  initNonce,
  getGlobalChain,
  backupIssueFile,
  sleep
} = require('comm/lib');

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
          tokenList[crossChain][tokenType].smgAddr = moduleConfig.crossInfoDict[crossChain][tokenType].smgAddr;
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

async function getScEvents(logger, chain, scAddr, topics, fromBlk, toBlk) {
  let events;
  let cntPerTime = 50;
  try {
    events = await chain.getScEventSync(scAddr, topics, fromBlk, toBlk, moduleConfig.web3RetryTimes);
  } catch (err) {
    logger.error("getScEvents", err);
    return Promise.reject(err);
  }

  let i = 0;
  let end;
  logger.info("events length: ", events.length);
  while (i < events.length) {
    if ((i + cntPerTime) > events.length) {
      end = events.length;
    } else {
      end = i + cntPerTime;
    }
    let arr = events.slice(i, end);
    let multiEvents = [...arr].map((event) => {
      return new Promise((resolve, reject) => {
        if(event === null) {
          logger.debug("event is null")
          resolve();
        }
        chain.getBlockByNumber(event.blockNumber, function(err, block) {
          if (err) {
            reject(err);
          } else {
            event.timestamp = block.timestamp;
            resolve();
          }
        });
      });
    });

    try {
      await Promise.all(multiEvents);
    } catch (err) {
      logger.error("getScEvents", err);
      return Promise.reject(err);
    }
    i += cntPerTime;
  }
  return events;
}

async function splitEvent(chainType, crossChain, tokenType, events, forSmg = false) {
  let multiEvents =  [...events].map((event) => {
    return new Promise(async (resolve, reject) => {
      try {
        let tokenTypeHandler = tokenList[crossChain][tokenType];
        let lockedTime = tokenList[crossChain][tokenType].lockedTime; 
        let crossAgent;
        if (chainType === 'wan') {
          crossAgent = tokenTypeHandler.wanCrossAgent;
        } else {
          crossAgent = tokenTypeHandler.originCrossAgent;
        }

        let decodeEvent;
        if(forSmg !== true) {
          decodeEvent = crossAgent.contract.parseEvent(event);
        } else {
          decodeEvent = crossAgent.smgContract.parseEvent(event);
        }

        let content;
        if (decodeEvent === null) {
          resolve();
          return;
        } else {
          if((forSmg === false) || ((forSmg === true) && (decodeEvent.event === 'StoremanGroupDebtTransferLogger'))) {
            content = crossAgent.getDecodeEventDbData(chainType, crossChain, tokenType, decodeEvent, event, lockedTime);
          }
        }

        /*Check debt transfer event.*/
        if((decodeEvent.event === 'StoremanGroupDebtTransferLogger') && (content !== null)) {
          let option = {hashX: {$in: [content[0]]}};
          let history = await modelOps.getEventHistory(option);
          if(history.length > 0) {
              resolve();
              return; //the event had been handled,so ignore the current one.
          }
        }

        if (content !== null) {
          if(content[1].hasOwnProperty("walletRevokeEvent")) {
            let option = {
              hashX : content[0]
            };
            let result = await modelOps.getEventHistory(option);
            if (result.length === 0) {
              resolve();
              return;
            }
          }
          modelOps.saveScannedEvent(...content);
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });

  try {
    await Promise.all(multiEvents);
    syncLogger.debug("********************************** splitEvent done **********************************");
  } catch (err) {
    global.syncLogger.error("splitEvent", err);
    return Promise.reject(err);
  }
}

async function syncChain(chainType, crossChain, tokenType, scAddrList, logger, db) {
  logger.debug("********************************** syncChain **********************************", chainType, crossChain, tokenType);
  let scAddr = scAddrList['htlcAddr'];
  let smgAddr = scAddrList['smgAddr'];
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
  let from = blockNumber;
  let curBlock = 0;
  let topics = [];
  let events = [];
  let smgEvents = [];

  try {
    curBlock = await chain.getBlockNumberSync();
    logger.info("Current block is:", curBlock, chainType);
  } catch (err) {
    logger.error("getBlockNumberSync from :", chainType, err);
    return;
  }
  if (curBlock > moduleConfig.CONFIRM_BLOCK_NUM) {
    let to = curBlock - moduleConfig.CONFIRM_BLOCK_NUM;
    try {
      if (from <= to) {
        events = await getScEvents(logger, chain, scAddr, topics, from, to);
        logger.info("events: ", chainType, events.length);

        if((tokenType === 'ERC20') && (smgAddr !== 'undefined') && (chainType === 'wan')) {
          smgEvents = await getScEvents(logger, chain, smgAddr, topics, from, to);
          logger.info("storemanGroup contract events: ", chainType, smgEvents.length);
        }
      }
      if (events.length > 0) {
        await splitEvent(chainType, crossChain, tokenType, events);
      }
      if ((tokenType === 'ERC20') && (smgEvents.length > 0) && (chainType === 'wan')) {
        await splitEvent(chainType, crossChain, tokenType, smgEvents, true);
      }
      modelOps.saveScannedBlockNumber(chainType, to);
      logger.info("********************************** saveState **********************************", chainType, crossChain, tokenType);
    } catch (err) {
      logger.error("getScEvents from :", chainType, err);
      return;
    }
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

          scAddrList = {'htlcAddr':tokenList[crossChain][tokenType].wanchainHtlcAddr, 'smgAddr': tokenList[crossChain][tokenType].smgAddr};
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
      $in: ['waitingIntervention']
    }
  }
  let changeList = await modelOps.getEventHistory(option);
  let content = {
    status: 'interventionPending'
  }
  logger.debug('changeList length is ', changeList.length);
  for (let i = 0; i < changeList.length; i++) {
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
    logger.info("********************************** handlerMain start **********************************");

    try {
      let htlcAddrFilter = tokenList.wanchainHtlcAddr.concat(tokenList.originalChainHtlcAddr);
      let option = {
        tokenAddr: {
          $in: [...tokenList.supportTokenAddrs]
        },
        toHtlcAddr: {
          $in: [...htlcAddrFilter]
        },
        storeman: {
          $in: [config.storemanEth, config.storemanWan]
        }
      }
      if (global.storemanRestart) {
        option.status = {
          $nin: ['redeemFinished', 'revokeFinished', 'transIgnored', 'fundLostFinished','debtTransfer', 'debtApproved', 'debtWaitingWanInboundLock', 'debtTransferDone']
        }
        global.storemanRestart = false;
      } else {
        option.status = {
          $nin: ['redeemFinished', 'revokeFinished', 'transIgnored', 'fundLostFinished', 'interventionPending','debtTransfer', 'debtApproved', 'debtWaitingWanInboundLock', 'debtTransferDone']
        }
      }
      let history = await modelOps.getEventHistory(option);
      logger.debug('history length is ', history.length);
      logger.debug('handlingList length is ', Object.keys(handlingList).length);

      for (let i = 0; i < history.length; i++) {
        let record = history[i];

        let cur = Date.now();
        if (handlingList[record.hashX]) {
          continue;
        }
        handlingList[record.hashX] = cur;

        try {
          monitorRecord(record);
        } catch (error) {
          logger.error("monitorRecord error:", error);
        }
      }

      /* get debtTransfer event from db.*/
      let debtOption = {
        status: {
          $in: ['debtTransfer', 'debtWaitingWanInboundLock', 'debtApproved']
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

async function main() {
  global.syncLogger.info("start storeman agent");
  if (Object.keys(config["crossTokens"]).length === 0) {
    global.syncLogger.error("./init.sh storemanWanAddr storemanEthAddr");
    global.syncLogger.error("To start storeman agent at the first time, you need to run init.sh with storemanWanAddr storemanEthAddr as paras!");
    process.exit();
  }
  await init();

  syncMain(global.syncLogger, db);
  await updateRecordAfterRestart(global.monitorLogger);
  handlerMain(global.monitorLogger, db);
}
main();