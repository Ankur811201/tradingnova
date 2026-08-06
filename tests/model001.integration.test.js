'use strict';

/**
 * End-to-end integration test: Model 001 running inside a real BotInstance,
 * driven by a deterministic mock market data provider, all the way through
 * BotManager -> RiskEngine -> ExecutionRouter -> PaperEngine.
 *
 * Automatically SKIPPED if no MongoDB is reachable (same pattern as
 * tests/integration.test.js). To run for real:
 *
 *   MONGODB_URI_TEST=mongodb://127.0.0.1:27017/nova_trade_test npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const TEST_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/nova_trade_test';
const MIN = 60 * 1000;
const BASE = 10 * MIN;

let dbAvailable = false;

before(async () => {
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 1500 });
    dbAvailable = true;
  } catch (err) {
    dbAvailable = false;
    console.log(`[model001 integration tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('BotManager discovers Model 001; a PAPER breakout signal flows through RiskEngine and ExecutionRouter into PaperEngine only', async (t) => {
  if (!dbAvailable) {
    t.skip('MongoDB not available in this environment');
    return;
  }

  const User = require('../models/User');
  const BotInstance = require('../models/BotInstance');
  const Position = require('../models/Position');
  const botManager = require('../services/botManager/BotManager');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const marketData = require('../services/marketData');
  const MockProvider = require('./helpers/mockProvider');

  const mockProvider = new MockProvider();
  marketData._setProviderForTesting(mockProvider);

  const discovered = await botManager.discoverModels();
  assert.ok(discovered.includes('MODEL_001'), 'expected BotManager to discover MODEL_001');

  const models = await botManager.listAvailableModels();
  assert.ok(models.some((m) => m.modelId === 'MODEL_001'));

  const user = await User.create({ username: 'model001_integration_user', passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const instance = await botManager.createInstance({
    userId: user._id,
    modelId: 'MODEL_001',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '1m', breakoutLookback: 3, historySize: 20, stopLossPercent: 1, takeProfitPercent: 2 },
    capitalAllocation: 5000,
    leverage: 2,
  });

  mockProvider.setPrice('BTCUSD', 100, Date.now());
  await botManager.startInstance(instance.instanceId);

  for (let i = 0; i <= 3; i += 1) {
    await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + i * MIN });
  }
  await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + 3 * MIN });
  await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 200 }, timestamp: BASE + 3 * MIN + 1000 });
  await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN });

  const positions = await Position.find({ instanceId: instance.instanceId });
  assert.equal(positions.length, 1, 'expected exactly one PAPER position opened by Model 001');
  assert.equal(positions[0].environment, 'PAPER');
  assert.equal(positions[0].side, 'LONG');
  assert.equal(positions[0].source, 'BOT');
  assert.equal(positions[0].modelId, 'MODEL_001');

  await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN });
  const positionsAfterDup = await Position.find({ instanceId: instance.instanceId });
  assert.equal(positionsAfterDup.length, 1, 'duplicate candle dispatch must not create a duplicate position');

  await botManager.pauseInstance(instance.instanceId);
  const pausedInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(pausedInstance.status, 'PAUSED');

  await botManager.stopInstance(instance.instanceId);
  const stoppedInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(stoppedInstance.status, 'STOPPED');
});

test('a LIVE Model 001 instance never reaches PaperEngine (environment isolation preserved)', async (t) => {
  if (!dbAvailable) {
    t.skip('MongoDB not available in this environment');
    return;
  }

  const User = require('../models/User');
  const Position = require('../models/Position');
  const botManager = require('../services/botManager/BotManager');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const marketData = require('../services/marketData');
  const MockProvider = require('./helpers/mockProvider');

  const mockProvider = new MockProvider();
  marketData._setProviderForTesting(mockProvider);
  await botManager.discoverModels();

  const user = await User.create({ username: 'model001_live_isolation_user', passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const instance = await botManager.createInstance({
    userId: user._id,
    modelId: 'MODEL_001',
    symbol: 'BTCUSD',
    environment: 'LIVE',
    parameters: { timeframe: '1m', breakoutLookback: 3, historySize: 20 },
    capitalAllocation: 5000,
    leverage: 2,
  });

  mockProvider.setPrice('BTCUSD', 100, Date.now());
  await botManager.startInstance(instance.instanceId);

  for (let i = 0; i <= 3; i += 1) {
    await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + i * MIN });
  }
  await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + 3 * MIN });
  await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 200 }, timestamp: BASE + 3 * MIN + 1000 });
  await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN });

  // Delta is not configured in this test environment, so LiveEngine must reject
  // (DELTA_NOT_CONFIGURED) rather than ever falling back to PaperEngine.
  const paperPositions = await Position.find({ instanceId: instance.instanceId, environment: 'PAPER' });
  const livePositions = await Position.find({ instanceId: instance.instanceId, environment: 'LIVE' });
  assert.equal(paperPositions.length, 0, 'a LIVE instance must never create a PAPER position');
  assert.equal(livePositions.length, 0, 'Delta is not configured in this test env, so no live position should be created either');
});
