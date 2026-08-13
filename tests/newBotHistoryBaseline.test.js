'use strict';

/**
 * New-bot candle-history baseline tests — the confirmed rule:
 *
 *   candle.timestamp >= dbInstance.createdAt
 *
 * applies uniformly to both a brand-new bot (nothing has happened since
 * createdAt yet -> correctly starts with insufficient_history) AND an
 * existing bot's restart/recovery (everything it ever legitimately
 * processed happened after its own createdAt -> full history correctly
 * recovered) — no "is this new vs. restart" branching anywhere.
 *
 * SKIPPED automatically if no MongoDB is reachable, same convention as
 * tests/startupRecovery.test.js / tests/part11.botManager.test.js.
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
    console.log(`[newBotHistoryBaseline tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
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

function freshBotManager() {
  delete require.cache[BOT_MANAGER_PATH];
  return require('../services/botManager/BotManager');
}

const MIN = 60000;

async function seedFlatCandles(Candle, symbol, timeframe, timestamps, price) {
  const docs = timestamps.map((ts) => ({
    symbol, timeframe, timestamp: ts,
    open: price, high: price + 5, low: price - 5, close: price,
    volume: null, closed: true, source: 'delta',
  }));
  await Candle.insertMany(docs);
}

async function createModel002Instance(botManager, userId, overrides = {}) {
  return botManager.createInstance(Object.assign({
    name: `baseline_${Date.now()}_${Math.random()}`,
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

test('BASELINE: exact confirmed scenario — createdAt=10:00:30, candle 10:00:00 excluded, 10:01:00/10:02:00 included', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const botManager = freshBotManager();
  botManager.attachSocketServer(createMockIo());
  await botManager.discoverModels();

  const user = await User.create({ username: `baseline_exact_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  // Anchor "now" at a real, recent minute boundary so seeded candles are
  // genuinely "recent" per getUsableRecentHistory's contiguity window.
  const base = Math.floor(Date.now() / MIN) * MIN - 10 * MIN;
  const t1000 = base;              // 10:00:00 equivalent
  const t1001 = base + 1 * MIN;    // 10:01:00
  const t1002 = base + 2 * MIN;    // 10:02:00
  await seedFlatCandles(Candle, 'BTCUSD', '1m', [t1000, t1001, t1002], 64000);

  const instance = await createModel002Instance(botManager, user._id);
  // Force createdAt to the exact confirmed scenario: 10:00:30 equivalent —
  // 30 seconds after the 10:00 candle's period start, before the 10:01 one.
  await BotInstance.updateOne({ instanceId: instance.instanceId }, { $set: { createdAt: new Date(t1000 + 30000) } });

  await botManager.startInstance(instance.instanceId);

  const live = botManager.liveInstances.get(instance.instanceId);
  const hydratedTimestamps = live.modelInstance.candles.map((c) => c.timestamp);

  assert.equal(hydratedTimestamps.includes(t1000), false, '10:00:00 candle must be EXCLUDED — its period started before createdAt (10:00:30)');
  assert.equal(hydratedTimestamps.includes(t1001), true, '10:01:00 candle must be INCLUDED — entirely after createdAt');
  assert.equal(hydratedTimestamps.includes(t1002), true, '10:02:00 candle must be INCLUDED');
});

test('BASELINE: a genuinely new bot with only pre-creation candles available starts with insufficient_history, never treats old candles as its own', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const botManager = freshBotManager();
  botManager.attachSocketServer(createMockIo());
  await botManager.discoverModels();

  const user = await User.create({ username: `baseline_new_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const base = Math.floor(Date.now() / MIN) * MIN - 30 * MIN;
  const oldTimestamps = [];
  for (let i = 0; i < 25; i += 1) oldTimestamps.push(base + i * MIN); // all 30-6 minutes old
  await seedFlatCandles(Candle, 'BTCUSD', '1m', oldTimestamps, 64000);

  const instance = await createModel002Instance(botManager, user._id);
  // createdAt is Mongoose-automatic (right now) — AFTER every seeded candle.
  await botManager.startInstance(instance.instanceId);

  const live = botManager.liveInstances.get(instance.instanceId);
  assert.equal(live.modelInstance.candles.length, 0, 'none of the pre-creation candles may enter this new bot\'s history');

  const readiness = botManager.getReadiness(instance.instanceId);
  assert.equal(readiness.state, 'INSUFFICIENT_HISTORY', 'a new bot with only old candles available must honestly report insufficient history, never fabricate readiness from history that predates it');
});

test('BASELINE: the first eligible closed candle after creation is processed exactly once — no duplicate DECISION StrategyEvent', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const StrategyEvent = require('../models/StrategyEvent');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const botManager = freshBotManager();
  botManager.attachSocketServer(createMockIo());
  await botManager.discoverModels();

  const user = await User.create({ username: `baseline_once_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const base = Math.floor(Date.now() / MIN) * MIN - 25 * MIN;
  const timestamps = [];
  for (let i = 0; i < 25; i += 1) timestamps.push(base + i * MIN); // enough to satisfy MODEL_002's historySize
  await seedFlatCandles(Candle, 'BTCUSD', '1m', timestamps, 64000);

  const instance = await createModel002Instance(botManager, user._id);
  // createdAt = right before the LAST seeded candle, so most of history is
  // "new" and the bot has enough for readiness, but this test focuses on
  // exactly-once processing of the live candle dispatched after start.
  await botManager.startInstance(instance.instanceId);

  const beforeCount = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).countDocuments();

  const liveTs = base + 25 * MIN;
  const liveCandle = { timestamp: liveTs, open: 64000, high: 64005, low: 63995, close: 64000, volume: null, closed: true };
  await botManager.dispatchMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: liveTs, data: liveCandle });

  const afterFirst = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).countDocuments();
  assert.equal(afterFirst - beforeCount, 1, 'exactly one new DECISION for the first live candle');

  // Re-dispatch the SAME candle timestamp again (simulating a duplicate
  // tick/replay) — existing lastProcessedTs dedup must still reject it.
  await botManager.dispatchMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: liveTs, data: liveCandle });
  const afterDuplicate = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).countDocuments();
  assert.equal(afterDuplicate, afterFirst, 'a re-dispatched duplicate of the same candle must not produce a second DECISION — existing lastProcessedTs dedup must remain correct');
});

test('BASELINE: an EXISTING bot restart correctly recovers its full accumulated history (unaffected by restart time, still bounded by its ORIGINAL createdAt)', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const botManager = freshBotManager();
  botManager.attachSocketServer(createMockIo());
  await botManager.discoverModels();

  const user = await User.create({ username: `baseline_restart_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const base = Math.floor(Date.now() / MIN) * MIN - 40 * MIN;
  const preCreationTimestamps = [base, base + MIN, base + 2 * MIN]; // 3 candles BEFORE this bot ever existed
  const postCreationTimestamps = [];
  for (let i = 10; i < 35; i += 1) postCreationTimestamps.push(base + i * MIN); // 25 candles AFTER creation

  await seedFlatCandles(Candle, 'BTCUSD', '1m', preCreationTimestamps, 64000);

  const instance = await createModel002Instance(botManager, user._id);
  await BotInstance.updateOne({ instanceId: instance.instanceId }, { $set: { createdAt: new Date(base + 9 * MIN + 30000) } }); // createdAt = 10:09:30 equivalent

  await seedFlatCandles(Candle, 'BTCUSD', '1m', postCreationTimestamps, 64000); // these arrive "live" after creation, seeded directly for test simplicity

  // Original start — confirm pre-creation candles excluded, post-creation included.
  await botManager.startInstance(instance.instanceId);
  const liveBefore = botManager.liveInstances.get(instance.instanceId);
  const tsBefore = liveBefore.modelInstance.candles.map((c) => c.timestamp);
  assert.equal(preCreationTimestamps.some((t) => tsBefore.includes(t)), false, 'pre-creation candles must never appear, even on the original start');
  assert.equal(postCreationTimestamps.every((t) => tsBefore.includes(t)), true);

  // Restart — the SAME original createdAt (never changes) must still be
  // used; the bot's full accumulated (post-creation) history must be
  // recovered, and pre-creation candles must STILL never leak in.
  await botManager.restartInstance(instance.instanceId);
  const liveAfter = botManager.liveInstances.get(instance.instanceId);
  const tsAfter = liveAfter.modelInstance.candles.map((c) => c.timestamp);
  assert.equal(preCreationTimestamps.some((t) => tsAfter.includes(t)), false, 'pre-creation candles must still never appear after restart');
  assert.equal(postCreationTimestamps.every((t) => tsAfter.includes(t)), true, 'the bot\'s own full accumulated history must be recovered on restart');

  const dbInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(dbInstance.createdAt.getTime(), base + 9 * MIN + 30000, 'createdAt must never change across a restart');
});

test('BASELINE: startup recovery (process restart) preserves the bot\'s original baseline — never treats an existing bot as new', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const StrategyEvent = require('../models/StrategyEvent');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const oldBotManager = freshBotManager();
  oldBotManager.attachSocketServer(createMockIo());
  await oldBotManager.discoverModels();

  const user = await User.create({ username: `baseline_recovery_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const base = Math.floor(Date.now() / MIN) * MIN - 40 * MIN;
  const preCreationTimestamps = [base, base + MIN];
  const postCreationTimestamps = [];
  for (let i = 5; i < 30; i += 1) postCreationTimestamps.push(base + i * MIN);

  await seedFlatCandles(Candle, 'BTCUSD', '1m', preCreationTimestamps, 64000);
  const instance = await createModel002Instance(oldBotManager, user._id);
  await BotInstance.updateOne({ instanceId: instance.instanceId }, { $set: { createdAt: new Date(base + 4 * MIN + 30000) } });
  await seedFlatCandles(Candle, 'BTCUSD', '1m', postCreationTimestamps, 64000);

  await oldBotManager.startInstance(instance.instanceId);
  const decisionCountBeforeCrash = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).countDocuments();

  // Simulate an ungraceful process restart (no stopInstance call).
  const newBotManager = freshBotManager();
  newBotManager.attachSocketServer(createMockIo());
  await newBotManager.discoverModels();
  await newBotManager.recoverRunningInstances();

  const live = newBotManager.liveInstances.get(instance.instanceId);
  assert.ok(live, 'the bot must be recovered');
  const recoveredTimestamps = live.modelInstance.candles.map((c) => c.timestamp);
  assert.equal(preCreationTimestamps.some((t) => recoveredTimestamps.includes(t)), false, 'startup recovery must NOT suddenly load pre-creation candles — the bot must not become a "new bot"');
  assert.equal(postCreationTimestamps.every((t) => recoveredTimestamps.includes(t)), true, 'startup recovery must correctly recover the bot\'s own full accumulated history');

  const decisionCountAfterRecovery = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).countDocuments();
  assert.equal(decisionCountAfterRecovery, decisionCountBeforeCrash, 'recovery (hydration/replay) must never itself emit a DECISION — no duplicate StrategyEvent from the recovery process itself');

  const dbInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(dbInstance.createdAt.getTime(), base + 4 * MIN + 30000, 'the original baseline must be exactly preserved through recovery');
});

test('BASELINE: backward compatibility — a missing/invalid createdAt falls back to unfiltered (existing pre-fix) behavior rather than stalling a real bot', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const botManager = freshBotManager();
  botManager.attachSocketServer(createMockIo());
  await botManager.discoverModels();

  const user = await User.create({ username: `baseline_compat_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const base = Math.floor(Date.now() / MIN) * MIN - 25 * MIN;
  const timestamps = [];
  for (let i = 0; i < 25; i += 1) timestamps.push(base + i * MIN);
  await seedFlatCandles(Candle, 'BTCUSD', '1m', timestamps, 64000);

  const instance = await createModel002Instance(botManager, user._id);
  // Simulate a malformed/legacy document missing createdAt entirely —
  // bypassing normal Mongoose timestamp assignment via a raw update.
  await BotInstance.collection.updateOne({ instanceId: instance.instanceId }, { $unset: { createdAt: '' } });

  await botManager.startInstance(instance.instanceId);
  const live = botManager.liveInstances.get(instance.instanceId);
  assert.ok(live.modelInstance.candles.length > 0, 'with no valid createdAt to filter by, existing (unfiltered) behavior must be preserved — never wrongly stall a real bot');
});

test('BASELINE: live dispatch defensively ignores a candle whose timestamp predates the bot\'s creation', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const StrategyEvent = require('../models/StrategyEvent');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const botManager = freshBotManager();
  botManager.attachSocketServer(createMockIo());
  await botManager.discoverModels();

  const user = await User.create({ username: `baseline_livecheck_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const base = Math.floor(Date.now() / MIN) * MIN - 25 * MIN;
  const timestamps = [];
  for (let i = 0; i < 25; i += 1) timestamps.push(base + i * MIN);
  await seedFlatCandles(Candle, 'BTCUSD', '1m', timestamps, 64000);

  const instance = await createModel002Instance(botManager, user._id);
  await botManager.startInstance(instance.instanceId);

  const beforeCount = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).countDocuments();

  // A candle whose timestamp is BEFORE createdAt, dispatched directly
  // (simulating a stale/out-of-order delivery).
  const dbInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
  const staleTs = dbInstance.createdAt.getTime() - 10 * MIN;
  const staleCandle = { timestamp: staleTs, open: 64000, high: 64005, low: 63995, close: 64000, volume: null, closed: true };
  await botManager.dispatchMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: staleTs, data: staleCandle });

  const afterStale = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).countDocuments();
  assert.equal(afterStale, beforeCount, 'a stale, pre-creation-timestamped candle must never reach onMarketData at all');
});
