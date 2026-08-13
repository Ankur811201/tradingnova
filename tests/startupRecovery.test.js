'use strict';

/**
 * Startup recovery tests — the confirmed `liveInstances` bug: a Node.js
 * process restart never demotes a genuinely RUNNING BotInstance to
 * STOPPED (only a graceful stop does that), so without recovery, such a
 * bot's status field keeps reporting RUNNING while dispatchMarketData
 * silently never sees it again (it only ever iterates the in-memory
 * liveInstances Map, never queries MongoDB for "what should be running").
 *
 * These tests simulate a real process restart by clearing Node's require
 * cache for BotManager.js and re-requiring it — this produces a genuinely
 * fresh singleton with empty liveInstances/registeredModels/instanceLocks,
 * the same starting state a real new process would have. Models/DB
 * connections are shared (this is still one Node process), which is fine:
 * only BotManager's own in-memory state needs to be reset to faithfully
 * reproduce the bug this fix addresses.
 *
 * SKIPPED automatically if no MongoDB is reachable, same convention as
 * tests/part11.botManager.test.js / tests/multiTargetExits.test.js.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const TEST_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/nova_trade_test';
const BOT_MANAGER_PATH = require.resolve('../services/botManager/BotManager');

let dbAvailable = false;

before(async () => {
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 1500 });
    dbAvailable = true;
  } catch (err) {
    dbAvailable = false;
    console.log(`[startupRecovery tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

function createMockIo() {
  const emitted = [];
  return {
    emitted,
    to(room) {
      return { emit(event, payload) { emitted.push({ room, event, payload }); } };
    },
  };
}

/** Returns a genuinely fresh BotManager singleton — simulates a new process's empty runtime state. */
function freshBotManager() {
  delete require.cache[BOT_MANAGER_PATH];
  return require('../services/botManager/BotManager');
}

const MIN = 60000;

/** Inserts `count` real, distinct, closed Candle documents ending at `endTs`, flat (no touches). */
async function seedFlatCandles(Candle, symbol, timeframe, count, endTs, price) {
  const docs = [];
  for (let i = 0; i < count; i += 1) {
    const ts = endTs - (count - i) * MIN;
    docs.push({
      symbol, timeframe, timestamp: ts,
      open: price, high: price + 5, low: price - 5, close: price,
      volume: null, closed: true, source: 'delta',
    });
  }
  await Candle.insertMany(docs);
}

async function createModel002Instance(botManager, userId, overrides = {}) {
  return botManager.createInstance(Object.assign({
    name: `startup_recovery_${Date.now()}_${Math.random()}`,
    userId,
    modelId: 'MODEL_002',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: {
      timeframe: '1m', trend: 'BEARISH',
      support: [60000, 59000, 58000], resistance: [64950, 65000, 65100],
    },
    capitalAllocation: 10000,
    leverage: 1,
  }, overrides));
}

test('startup recovery: a fresh process recovers a bot that was genuinely RUNNING before an ungraceful restart', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  // --- "Old process": create and genuinely start an instance. ---
  const oldBotManager = freshBotManager();
  oldBotManager.attachSocketServer(createMockIo());
  await oldBotManager.discoverModels();

  const user = await User.create({ username: `startup_recovery_user_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const now = Date.now();
  const endTs = Math.floor(now / MIN) * MIN;
  await seedFlatCandles(Candle, 'BTCUSD', '1m', 25, endTs, 64000);

  const instance = await createModel002Instance(oldBotManager, user._id);
  await oldBotManager.startInstance(instance.instanceId);

  const dbInstanceAfterStart = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(dbInstanceAfterStart.status, 'RUNNING');
  assert.ok(oldBotManager.liveInstances.has(instance.instanceId), 'sanity: the old process genuinely has this instance live');

  // --- Simulate an ungraceful restart: a BRAND NEW process, never calling
  //     stopInstance (which is the only thing that would have set STOPPED). ---
  const newBotManager = freshBotManager();
  assert.equal(newBotManager.liveInstances.has(instance.instanceId), false, 'sanity: the new process genuinely starts with an empty liveInstances Map');
  newBotManager.attachSocketServer(createMockIo());
  await newBotManager.discoverModels();

  // Confirm the exact bug WITHOUT the fix: MongoDB still says RUNNING.
  const dbInstanceBeforeRecovery = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(dbInstanceBeforeRecovery.status, 'RUNNING', 'MongoDB status was never demoted by the ungraceful restart');

  const results = await newBotManager.recoverRunningInstances();
  const thisResult = results.find((r) => r.instanceId === instance.instanceId);
  assert.ok(thisResult, 'recovery must have attempted this instance');
  assert.equal(thisResult.recovered, true);

  assert.ok(newBotManager.liveInstances.has(instance.instanceId), 'the instance must now be live in the NEW process');
});

test('startup recovery: a genuinely STOPPED bot is never recovered/restarted', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const botManager1 = freshBotManager();
  botManager1.attachSocketServer(createMockIo());
  await botManager1.discoverModels();

  const user = await User.create({ username: `startup_recovery_stopped_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const now = Date.now();
  const endTs = Math.floor(now / MIN) * MIN;
  await seedFlatCandles(Candle, 'BTCUSD', '1m', 25, endTs, 64000);

  const instance = await createModel002Instance(botManager1, user._id);
  await botManager1.startInstance(instance.instanceId);
  await botManager1.stopInstance(instance.instanceId); // the ONLY path that sets STOPPED

  const dbInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(dbInstance.status, 'STOPPED');

  const botManager2 = freshBotManager();
  botManager2.attachSocketServer(createMockIo());
  await botManager2.discoverModels();

  const results = await botManager2.recoverRunningInstances();
  assert.equal(results.find((r) => r.instanceId === instance.instanceId), undefined, 'a STOPPED instance must never even be considered by recovery — recoverRunningInstances only queries status:RUNNING');
  assert.equal(botManager2.liveInstances.has(instance.instanceId), false, 'a STOPPED bot must remain absent from liveInstances after recovery runs');

  const dbInstanceAfter = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(dbInstanceAfter.status, 'STOPPED', 'status must remain STOPPED — recovery must never resurrect a graceful stop');
});

test('startup recovery: an instance already live in THIS process is never re-initialized (no duplicate model instance/hydration)', { skip: () => !dbAvailable }, async () => {
  const User = require('../models/User');
  const Candle = require('../models/Candle');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const botManager = freshBotManager();
  botManager.attachSocketServer(createMockIo());
  await botManager.discoverModels();

  const user = await User.create({ username: `startup_recovery_dup_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const now = Date.now();
  const endTs = Math.floor(now / MIN) * MIN;
  await seedFlatCandles(Candle, 'BTCUSD', '1m', 25, endTs, 64000);

  const instance = await createModel002Instance(botManager, user._id);
  await botManager.startInstance(instance.instanceId);

  const liveEntryBefore = botManager.liveInstances.get(instance.instanceId);
  assert.ok(liveEntryBefore);

  // Calling recovery again in the SAME process (already live) must be a
  // pure no-op for this instance — never create a second model instance.
  const results = await botManager.recoverRunningInstances();
  const thisResult = results.find((r) => r.instanceId === instance.instanceId);
  assert.equal(thisResult.recovered, false);
  assert.equal(thisResult.reason, 'already live in this process');

  const liveEntryAfter = botManager.liveInstances.get(instance.instanceId);
  assert.equal(liveEntryAfter, liveEntryBefore, 'the exact same in-memory runtime object must still be registered — never replaced/duplicated');
  assert.equal(liveEntryAfter.modelInstance, liveEntryBefore.modelInstance, 'the exact same model instance — never a second one created');
});

test('startup recovery: hydration completes before the recovered instance can receive live dispatch, and the first subsequent closed candle produces exactly one MODEL_002 DECISION', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const StrategyEvent = require('../models/StrategyEvent');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const oldBotManager = freshBotManager();
  oldBotManager.attachSocketServer(createMockIo());
  await oldBotManager.discoverModels();

  const user = await User.create({ username: `startup_recovery_decision_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const now = Date.now();
  const endTs = Math.floor(now / MIN) * MIN;
  await seedFlatCandles(Candle, 'BTCUSD', '1m', 25, endTs, 64000);

  const instance = await createModel002Instance(oldBotManager, user._id);
  await oldBotManager.startInstance(instance.instanceId);

  // Simulate the restart.
  const newBotManager = freshBotManager();
  newBotManager.attachSocketServer(createMockIo());
  await newBotManager.discoverModels();
  await newBotManager.recoverRunningInstances();

  const live = newBotManager.liveInstances.get(instance.instanceId);
  assert.ok(live, 'must be recovered');
  // Hydration must have already populated the model's candle buffer BEFORE
  // any live dispatch — verified directly on the recovered model instance,
  // not inferred.
  assert.ok(live.modelInstance.candles && live.modelInstance.candles.length > 0, 'hydration must have completed as part of recovery, before this assertion (which runs after recoverRunningInstances resolved, matching the real server.js ordering)');

  const beforeCount = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).countDocuments();

  // First live candle after recovery — flat, does not touch any level.
  const liveCandle = {
    timestamp: endTs + MIN, open: 64000, high: 64005, low: 63995, close: 64000, volume: null, closed: true,
  };
  await newBotManager.dispatchMarketData({
    type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: liveCandle.timestamp, data: liveCandle,
  });

  const afterCount = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).countDocuments();
  assert.equal(afterCount - beforeCount, 1, 'exactly one new MODEL_002 DECISION must be produced by the first closed candle dispatched after recovery — proving the recovered instance is genuinely live and dispatching correctly, not silently stalled');

  const dbInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(dbInstance.status, 'RUNNING');
});
