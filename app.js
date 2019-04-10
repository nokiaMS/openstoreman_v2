"use strict"

const Logger = require('./comm/logger.js');

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

async function splitEvent(chainType, crossChain, tokenType, events) {
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

        let decodeEvent = crossAgent.contract.parseEvent(event);

        let content;
        if (decodeEvent === null) {
          resolve();
          return;
        } else {
          content = crossAgent.getDecodeEventDbData(chainType, crossChain, tokenType, decodeEvent, event, lockedTime);
        }

        if (content !== null) {
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
    syncLogger.debug("====> splitEvent done");
  } catch (err) {
    global.syncLogger.error("splitEvent", err);
    return Promise.reject(err);
  }
}

async function syncChain(chainType, crossChain, tokenType, scAddrList, logger, db) {
  logger.debug("====> syncChain:", chainType, crossChain, tokenType);
  let scAddr = scAddrList['htlcAddr'];
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
      }
      if (events.length > 0) {
        await splitEvent(chainType, crossChain, tokenType, events);
      }
      modelOps.saveScannedBlockNumber(chainType, to);
      logger.info("====> saveState:", chainType, crossChain, tokenType);
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
          $in: ['debtTransfer', 'coinTransfer', 'debtWaitingWanInboundLock', 'debtApproved']
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
    console.log('input key:', key);
    console.log('input hash key:', hashKey);
    return hashKey;
}

async function updateDebtOptionsToDb() {
    //1. get configuration.
    let debtOperationsConfig = require('./conf/debtOpts.json');
    let debtOperations = debtOperationsConfig.debtOperations;
    let coinOperations = debtOperationsConfig.coinOperations;
    let lockedTime = tokenList.ETH.ERC20.lockedTime;

    //2. make db content and save to db.
    debtOperations.forEach(function (item, index, array) {
        //2.1 get parameters
        let hashX = getHashKey(item.x);
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
            HTLCtime: (1000 * 2 * lockedTime + Date.now()).toString(),    //2 htlc time.
            status: 'debtTransfer'
        };
        //save content to db.
        let dbContent = [hashX, content];
        modelOps.saveScannedEvent(...dbContent);
    });

    //3. make db content and save to db.
    coinOperations.forEach(function (item, index, array) {
        //3.1 get parameters
        let content = {
            hashX: item.index,
            direction: 0,
            crossChain: 'eth',
            tokenType: 'ERC20',
            toHtlcAddr: item.targetAddr,      //address of the target storeman group.
            value: item.value,               //value for cross-transfer.
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
  handlerMain(global.monitorLogger, db);
}
main();