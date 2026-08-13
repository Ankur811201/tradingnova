'use strict';

/**
 * Editable Support/Resistance/Trend tests — Part 14 A-J.
 *
 * SKIPPED automatically if no MongoDB is reachable, same convention as
 * tests/newBotHistoryBaseline.test.js / tests/chartCandleBaseline.test.js.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const TEST_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/nova_trade_test';

let dbAvailable = false;

before(async () => {
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 1500 });
    dbAvailable = true;
  } catch (err) {
    dbAvailable = false;
    console.log(`[model002LevelsEditing tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

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
    name: `levels_edit_${Date.now()}_${Math.random()}`,
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

// --- A/B: new bot startup — 3 new candles, old touches don't create Candle 1 ---

test('A: MODEL_002 becomes ready after exactly 3 NEW closed candles since createdAt, old pre-creation candles never counted', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `levels_a_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const base = Math.floor(Date.now() / MIN) * MIN - 20 * MIN;
  const oldCandle = base; // T0 - old, pre-creation
  await seedFlatCandles(Candle, 'BTCUSD', '1m', [oldCandle], 64800);

  const instance = await createModel002Instance(botManager, user._id);
  await BotInstance.updateOne({ instanceId: instance.instanceId }, { $set: { createdAt: new Date(base + MIN) } }); // createdAt = T0+1min

  const newCandles = [base + MIN, base + 2 * MIN, base + 3 * MIN]; // T0+1, T0+2, T0+3
  await seedFlatCandles(Candle, 'BTCUSD', '1m', newCandles, 64800);

  await botManager.startInstance(instance.instanceId);
  const live = botManager.liveInstances.get(instance.instanceId);

  const readiness = live.modelInstance.getReadiness();
  assert.equal(readiness.have, 3, 'exactly the 3 new candles, old candle excluded');
  assert.equal(readiness.ready, true);
});

test('B: old candles that touch R1/S1 do NOT create Candle 1 for a brand-new bot', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `levels_b_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const base = Math.floor(Date.now() / MIN) * MIN - 20 * MIN;
  // Old candle touches resistance 64950, but predates the bot entirely.
  await Candle.insertMany([{
    symbol: 'BTCUSD', timeframe: '1m', timestamp: base,
    open: 64900, high: 64960, low: 64890, close: 64920, volume: null, closed: true, source: 'delta',
  }]);

  const instance = await createModel002Instance(botManager, user._id, {
    parameters: { timeframe: '1m', trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] },
  });
  await BotInstance.updateOne({ instanceId: instance.instanceId }, { $set: { createdAt: new Date(base + MIN) } });

  await botManager.startInstance(instance.instanceId);
  const live = botManager.liveInstances.get(instance.instanceId);
  assert.equal(live.modelInstance.patternCandidate, null, 'the old touch must never create Candle 1 for this new bot');
});

// --- C/D: level change — old candles must not create Candle 1, new candle must ---

test('C/D: changing R1 does not let OLD candles create Candle 1, but a NEW candle touching the new R1 does', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `levels_cd_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const base = Math.floor(Date.now() / MIN) * MIN - 30 * MIN;
  const instance = await createModel002Instance(botManager, user._id, {
    parameters: { timeframe: '1m', trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [65000, 65100, 65200] }, // old R1=65000
  });
  await BotInstance.updateOne({ instanceId: instance.instanceId }, { $set: { createdAt: new Date(base) } });

  // OLD candles (before the config change) that happen to touch the NEW
  // R1 value (65500) we're about to set.
  const oldTouchesNewLevel = base + 5 * MIN;
  await Candle.insertMany([{
    symbol: 'BTCUSD', timeframe: '1m', timestamp: oldTouchesNewLevel,
    open: 65490, high: 65510, low: 65480, close: 65500, volume: null, closed: true, source: 'delta',
  }]);
  const filler = [];
  for (let i = 1; i <= 15; i += 1) filler.push(base + i * MIN);
  await seedFlatCandles(Candle, 'BTCUSD', '1m', filler.filter((t) => t !== oldTouchesNewLevel), 64000);

  // Change R1 -> 65500.
  await botManager.updateConfiguration(instance.instanceId, { resistance: [65500, 65100, 65200] });
  const afterUpdate = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(afterUpdate.parameters.resistance[0], 65500);
  assert.ok(typeof afterUpdate.parameters.levelsUpdatedAt === 'number', 'levelsUpdatedAt must be set when a level genuinely changed');

  // Start AFTER the config change — old candle (even though it touches
  // the NEW R1=65500) must not create Candle 1.
  await botManager.startInstance(instance.instanceId);
  let live = botManager.liveInstances.get(instance.instanceId);
  assert.equal(live.modelInstance.patternCandidate, null, 'an OLD candle touching the NEW R1 must never create a fake Candle 1');

  // A genuinely NEW closed candle (after levelsUpdatedAt) touching 65500 MUST create Candle 1.
  const newTouch = { timestamp: base + 20 * MIN, open: 65490, high: 65510, low: 65480, close: 65500, volume: null, closed: true };
  await botManager.dispatchMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: newTouch.timestamp, data: newTouch });
  live = botManager.liveInstances.get(instance.instanceId);
  assert.ok(live.modelInstance.patternCandidate, 'a genuinely NEW candle touching the new R1 must create Candle 1 normally');
  assert.equal(live.modelInstance.patternCandidate.direction, 'SELL');
});

// --- E: configuration persistence across restart ---

test('E: new Support/Resistance/Trend persist after restart', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `levels_e_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const instance = await createModel002Instance(botManager, user._id);
  await botManager.updateConfiguration(instance.instanceId, {
    trend: 'BULLISH', support: [1000, 900, 800], resistance: [2000, 2100, 2200],
  });

  await botManager.startInstance(instance.instanceId);
  await botManager.restartInstance(instance.instanceId);

  const dbInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(dbInstance.parameters.trend, 'BULLISH');
  assert.deepEqual(dbInstance.parameters.support, [1000, 900, 800]);
  assert.deepEqual(dbInstance.parameters.resistance, [2000, 2100, 2200]);
});

// --- F: pattern state resets after level change ---

test('F: an active Candle 1 is cleared after a level change + restart', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `levels_f_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const base = Math.floor(Date.now() / MIN) * MIN - 10 * MIN;
  const instance = await createModel002Instance(botManager, user._id, {
    parameters: { timeframe: '1m', trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] },
  });
  await BotInstance.updateOne({ instanceId: instance.instanceId }, { $set: { createdAt: new Date(base) } });
  const filler = [];
  for (let i = 0; i < 5; i += 1) filler.push(base + i * MIN);
  await seedFlatCandles(Candle, 'BTCUSD', '1m', filler, 64800);

  await botManager.startInstance(instance.instanceId);
  const touch = { timestamp: base + 5 * MIN, open: 64900, high: 64960, low: 64890, close: 64920, volume: null, closed: true };
  await botManager.dispatchMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch });
  let live = botManager.liveInstances.get(instance.instanceId);
  assert.ok(live.modelInstance.patternCandidate, 'sanity: Candle 1 exists before the config change');

  await botManager.stopInstance(instance.instanceId);
  await botManager.updateConfiguration(instance.instanceId, { resistance: [70000, 70100, 70200] });
  await botManager.startInstance(instance.instanceId);

  live = botManager.liveInstances.get(instance.instanceId);
  assert.equal(live.modelInstance.patternCandidate, null, 'the old Candle 1 state must be gone after the level change + restart');
});

// --- G: other bot isolation ---

test('G: Bot A changing R1 does not affect Bot B\'s R1', { skip: () => !dbAvailable }, async () => {
  const User = require('../models/User');
  const BotInstance = require('../models/BotInstance');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `levels_g_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const botA = await createModel002Instance(botManager, user._id, {
    parameters: { timeframe: '1m', trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [65000, 65100, 65200] },
  });
  const botB = await createModel002Instance(botManager, user._id, {
    parameters: { timeframe: '1m', trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [65000, 65100, 65200] },
  });

  await botManager.updateConfiguration(botA.instanceId, { resistance: [99000, 99100, 99200] });

  const dbA = await BotInstance.findOne({ instanceId: botA.instanceId });
  const dbB = await BotInstance.findOne({ instanceId: botB.instanceId });
  assert.deepEqual(dbA.parameters.resistance, [99000, 99100, 99200]);
  assert.deepEqual(dbB.parameters.resistance, [65000, 65100, 65200], 'Bot B must retain its original R1 — unaffected by Bot A\'s change');
});

// --- H: existing bot restart without config change ---

test('H: a bot whose configuration was NEVER changed continues normal post-creation history recovery on restart', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `levels_h_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const base = Math.floor(Date.now() / MIN) * MIN - 20 * MIN;
  const instance = await createModel002Instance(botManager, user._id);
  await BotInstance.updateOne({ instanceId: instance.instanceId }, { $set: { createdAt: new Date(base) } });
  const timestamps = [];
  for (let i = 0; i < 15; i += 1) timestamps.push(base + i * MIN);
  await seedFlatCandles(Candle, 'BTCUSD', '1m', timestamps, 64800);

  await botManager.startInstance(instance.instanceId);
  await botManager.restartInstance(instance.instanceId);

  const live = botManager.liveInstances.get(instance.instanceId);
  assert.equal(live.modelInstance.candles.length, 15, 'no configuration change -> full post-creation history recovered normally, unaffected by the levelsUpdatedAt mechanism');

  const dbInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(dbInstance.parameters.levelsUpdatedAt, undefined, 'levelsUpdatedAt must never be set unless a level genuinely changed');
});

// --- Backend safety: RUNNING guard, MODEL_002-only, validation ---

test('SAFETY: cannot change trend/support/resistance while RUNNING', { skip: () => !dbAvailable }, async () => {
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `levels_safety_running_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const instance = await createModel002Instance(botManager, user._id);
  await botManager.startInstance(instance.instanceId);

  await assert.rejects(
    () => botManager.updateConfiguration(instance.instanceId, { resistance: [1, 2, 3] }),
    /RUNNING/
  );
});

test('SAFETY: rejects a support/resistance array that is not exactly 3 values', { skip: () => !dbAvailable }, async () => {
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `levels_safety_count_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const instance = await createModel002Instance(botManager, user._id);
  await assert.rejects(
    () => botManager.updateConfiguration(instance.instanceId, { resistance: [1, 2] }),
    /exactly 3/
  );
});

test('SAFETY: rejects a non-positive or non-numeric level value', { skip: () => !dbAvailable }, async () => {
  const User = require('../models/User');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `levels_safety_numeric_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const instance = await createModel002Instance(botManager, user._id);
  await assert.rejects(
    () => botManager.updateConfiguration(instance.instanceId, { resistance: [1, -5, 3] }),
    /invalid level/
  );
});
