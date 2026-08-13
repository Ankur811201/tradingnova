'use strict';

/**
 * Chart candle-baseline tests — the confirmed rule the /api/bot-instances/
 * :instanceId/candles endpoint must apply, mirroring the exact boundary
 * BotManager._hydrateOneTimeframe already uses for strategy hydration:
 *
 *   candle.timestamp >= bot.createdAt
 *
 * SKIPPED automatically if no MongoDB is reachable, same convention as
 * tests/newBotHistoryBaseline.test.js / tests/startupRecovery.test.js.
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
    console.log(`[chartCandleBaseline tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
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

/** Invokes getCandles directly against a constructed req/res, mirroring the real Express contract. */
function callGetCandles(controller, { instanceId, userId, query = {} }) {
  return new Promise((resolve, reject) => {
    const req = { params: { instanceId }, session: { userId }, query };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); },
    };
    const next = (err) => { if (err) reject(err); };
    controller.getCandles(req, res, next).catch(reject);
  });
}

test('CHART BASELINE: exact confirmed scenario — bot created 07:40, candles 05:00/06:00/07:00 excluded, 07:40 onward included', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const botInstancesController = require('../controllers/botInstancesController');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `chart_baseline_${Date.now()}`, passwordHash: 'x' });

  const base = Math.floor(Date.now() / MIN) * MIN - 60 * MIN;
  const t0500 = base;              // "05:00" equivalent — pre-creation
  const t0740 = base + 40 * MIN;   // bot's own createdAt anchor
  const t0741 = t0740 + MIN;
  const t0742 = t0740 + 2 * MIN;

  const created = await botManager.createInstance({
    name: 'chart_baseline_bot', userId: user._id, modelId: 'MODEL_002', symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '1m', trend: 'BEARISH', support: [1, 2, 3], resistance: [999000, 998000, 997000] },
    capitalAllocation: 10000, leverage: 1,
  });
  await BotInstance.updateOne({ instanceId: created.instanceId }, { $set: { createdAt: new Date(t0740) } });

  await seedFlatCandles(Candle, 'BTCUSD', '1m', [t0500, t0740 - MIN, t0740, t0741, t0742], 64000);

  const { statusCode, body } = await callGetCandles(botInstancesController, { instanceId: created.instanceId, userId: user._id });
  assert.equal(statusCode, 200);
  assert.equal(body.success, true);

  const times = body.data.candles.map((c) => c.time * 1000);
  assert.equal(times.includes(t0500), false, '05:00-equivalent candle must be excluded');
  assert.equal(times.includes(t0740 - MIN), false, 'the candle immediately before createdAt must be excluded');
  assert.equal(times.includes(t0740), true, 'the candle exactly at createdAt must be included');
  assert.equal(times.includes(t0741), true);
  assert.equal(times.includes(t0742), true);
});

test('CHART BASELINE: a brand-new bot with only pre-creation candles in MongoDB returns an empty candle list, never the latest global candles', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const botInstancesController = require('../controllers/botInstancesController');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `chart_baseline_new_${Date.now()}`, passwordHash: 'x' });

  const base = Math.floor(Date.now() / MIN) * MIN - 30 * MIN;
  const oldTimestamps = [];
  for (let i = 0; i < 10; i += 1) oldTimestamps.push(base + i * MIN);
  await seedFlatCandles(Candle, 'BTCUSD', '1m', oldTimestamps, 64000);

  // createdAt = Mongoose-automatic (right now) — after every seeded candle.
  const created = await botManager.createInstance({
    name: 'chart_baseline_new_bot', userId: user._id, modelId: 'MODEL_002', symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '1m', trend: 'BEARISH', support: [1, 2, 3], resistance: [999000, 998000, 997000] },
    capitalAllocation: 10000, leverage: 1,
  });

  const { body } = await callGetCandles(botInstancesController, { instanceId: created.instanceId, userId: user._id });
  assert.equal(body.data.candles.length, 0, 'a brand-new bot must never see the latest global candles that predate its own creation');
});

test('CHART BASELINE: existing bot restart still shows candles from its ORIGINAL createdAt — the baseline is never reset', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const botInstancesController = require('../controllers/botInstancesController');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `chart_baseline_restart_${Date.now()}`, passwordHash: 'x' });

  const base = Math.floor(Date.now() / MIN) * MIN - 40 * MIN;
  const originalCreatedAt = base + 10 * MIN;

  const created = await botManager.createInstance({
    name: 'chart_baseline_restart_bot', userId: user._id, modelId: 'MODEL_002', symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '1m', trend: 'BEARISH', support: [1, 2, 3], resistance: [999000, 998000, 997000] },
    capitalAllocation: 10000, leverage: 1,
  });
  await BotInstance.updateOne({ instanceId: created.instanceId }, { $set: { createdAt: new Date(originalCreatedAt) } });

  const preCreation = [base, base + 5 * MIN];
  const postCreation = [];
  for (let i = 11; i < 36; i += 1) postCreation.push(base + i * MIN);
  await seedFlatCandles(Candle, 'BTCUSD', '1m', preCreation.concat(postCreation), 64000);

  const { body: bodyBefore } = await callGetCandles(botInstancesController, { instanceId: created.instanceId, userId: user._id });
  const timesBefore = bodyBefore.data.candles.map((c) => c.time * 1000);
  assert.equal(preCreation.some((t) => timesBefore.includes(t)), false);

  // Simulate a restart: createdAt must be untouched by restartInstance.
  await botManager.startInstance(created.instanceId);
  await botManager.restartInstance(created.instanceId);

  const dbInstanceAfter = await BotInstance.findOne({ instanceId: created.instanceId });
  assert.equal(dbInstanceAfter.createdAt.getTime(), originalCreatedAt, 'restart must never change createdAt');

  const { body: bodyAfter } = await callGetCandles(botInstancesController, { instanceId: created.instanceId, userId: user._id });
  const timesAfter = bodyAfter.data.candles.map((c) => c.time * 1000);
  assert.equal(preCreation.some((t) => timesAfter.includes(t)), false, 'pre-creation candles must still never appear after restart');
  assert.equal(postCreation.every((t) => timesAfter.includes(t)), true, 'the bot\'s full history since its ORIGINAL createdAt must still be shown after restart');
});

test('CHART BASELINE: backward compatibility — a missing/invalid createdAt falls back to the existing unfiltered behavior', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const botInstancesController = require('../controllers/botInstancesController');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `chart_baseline_compat_${Date.now()}`, passwordHash: 'x' });

  const base = Math.floor(Date.now() / MIN) * MIN - 10 * MIN;
  const timestamps = [base, base + MIN, base + 2 * MIN];
  await seedFlatCandles(Candle, 'BTCUSD', '1m', timestamps, 64000);

  const created = await botManager.createInstance({
    name: 'chart_baseline_compat_bot', userId: user._id, modelId: 'MODEL_002', symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '1m', trend: 'BEARISH', support: [1, 2, 3], resistance: [999000, 998000, 997000] },
    capitalAllocation: 10000, leverage: 1,
  });
  await BotInstance.collection.updateOne({ instanceId: created.instanceId }, { $unset: { createdAt: '' } });

  const { body } = await callGetCandles(botInstancesController, { instanceId: created.instanceId, userId: user._id });
  assert.equal(body.data.candles.length, 3, 'with no valid createdAt to filter by, all seeded candles must still be returned — never wrongly empty the chart for a real bot');
});

test('CHART BASELINE: other bots on the same symbol/timeframe are unaffected by this bot\'s baseline', { skip: () => !dbAvailable }, async () => {
  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const botInstancesController = require('../controllers/botInstancesController');
  const botManager = require('../services/botManager/BotManager');

  await botManager.discoverModels();
  const user = await User.create({ username: `chart_baseline_other_${Date.now()}`, passwordHash: 'x' });

  const base = Math.floor(Date.now() / MIN) * MIN - 30 * MIN;
  const allTimestamps = [];
  for (let i = 0; i < 25; i += 1) allTimestamps.push(base + i * MIN);
  await seedFlatCandles(Candle, 'BTCUSD', '1m', allTimestamps, 64000);

  // Bot A: created early — sees everything.
  const botA = await botManager.createInstance({
    name: 'chart_baseline_A', userId: user._id, modelId: 'MODEL_002', symbol: 'BTCUSD',
    environment: 'PAPER', parameters: { timeframe: '1m', trend: 'BEARISH', support: [1, 2, 3], resistance: [999000, 998000, 997000] },
    capitalAllocation: 10000, leverage: 1,
  });
  await BotInstance.updateOne({ instanceId: botA.instanceId }, { $set: { createdAt: new Date(base) } });

  // Bot B: created halfway through — sees only the later half.
  const midpoint = base + 12 * MIN;
  const botB = await botManager.createInstance({
    name: 'chart_baseline_B', userId: user._id, modelId: 'MODEL_002', symbol: 'BTCUSD',
    environment: 'PAPER', parameters: { timeframe: '1m', trend: 'BEARISH', support: [1, 2, 3], resistance: [999000, 998000, 997000] },
    capitalAllocation: 10000, leverage: 1,
  });
  await BotInstance.updateOne({ instanceId: botB.instanceId }, { $set: { createdAt: new Date(midpoint) } });

  const { body: bodyA } = await callGetCandles(botInstancesController, { instanceId: botA.instanceId, userId: user._id });
  const { body: bodyB } = await callGetCandles(botInstancesController, { instanceId: botB.instanceId, userId: user._id });

  assert.equal(bodyA.data.candles.length, 25, 'bot A (created at the very first candle) must see all 25');
  assert.equal(bodyB.data.candles.length, 13, 'bot B (created at the midpoint) must see only the 13 candles from its own creation onward');
});
