'use strict';

/**
 * Part 7 — Trading authority safety tests.
 *
 * Proves, at the code level, that the legacy BotEngineManager /
 * TechnicalAnalysisService path can NEVER create a Trade, Position, or
 * authoritative Signal, and can never reach RiskEngine / ExecutionRouter /
 * PaperEngine / LiveEngine — and that the real authoritative path
 * (MODEL_001 -> BotManager -> RiskEngine -> ExecutionRouter -> PaperEngine)
 * is unaffected and still produces exactly one trade per market condition,
 * even when the legacy engine is simultaneously "triggered".
 *
 * Tests A, B, and D require no database (they spy on model/engine methods
 * directly). Tests C and E exercise the real pipeline end-to-end and are
 * automatically SKIPPED if no MongoDB is reachable, matching the existing
 * pattern in tests/integration.test.js and tests/model001.integration.test.js.
 *
 *   MONGODB_URI_TEST=mongodb://127.0.0.1:27017/nova_trade_test npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const TEST_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/nova_trade_test';
const MIN = 60 * 1000;
const BASE = 40 * MIN;

let dbAvailable = false;

before(async () => {
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 1500 });
    dbAvailable = true;
  } catch (err) {
    dbAvailable = false;
    console.log(`[part7 authority tests] Skipping DB-backed tests: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

// ===========================================================
// Spy helper — wraps a method on an object, records call count,
// and restores the original afterwards.
// ===========================================================
function spyOn(obj, method) {
  const original = obj[method];
  const calls = [];
  obj[method] = (...args) => {
    calls.push(args);
    return original.apply(obj, args);
  };
  return {
    calls,
    get callCount() { return calls.length; },
    restore() { obj[method] = original; },
  };
}

// ===========================================================
// Test A — Legacy BUY produces zero authoritative side effects
// ===========================================================

test('[Part 7] Legacy BUY: BotEngineManager.handleTradeExecution creates no Trade/Position/Signal and touches no execution engine', async () => {
  const botEngineManager = require('../services/BotEngineManager');
  const Trade = require('../models/Trade');
  const Position = require('../models/Position');
  const Signal = require('../models/Signal');
  const riskEngine = require('../services/riskEngine/RiskEngine');
  const executionRouter = require('../services/execution/ExecutionRouter');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const liveEngine = require('../services/liveEngine/LiveEngine');

  const tradeSpy = spyOn(Trade, 'create');
  const positionSpy = spyOn(Position, 'create');
  const signalSpy = spyOn(Signal, 'create');
  const riskSpy = spyOn(riskEngine, 'evaluate');
  const routerSpy = spyOn(executionRouter, 'route');
  const paperOpenSpy = spyOn(paperEngine, 'openPosition');
  const liveOpenSpy = spyOn(liveEngine, 'openPosition');

  try {
    const fakeInstance = {
      instanceId: 'legacy_test_buy',
      modelId: 'Model001',
      symbol: 'BTCUSD',
      currentPosition: null,
    };

    await botEngineManager.handleTradeExecution(
      fakeInstance,
      50000,
      { decision: 'BUY', humanReason: 'mock breakout', factors: {}, sl: 49000, tp: 52000 },
    );

    assert.equal(tradeSpy.callCount, 0, 'Trade.create must not be called by legacy BUY');
    assert.equal(positionSpy.callCount, 0, 'Position.create must not be called by legacy BUY');
    assert.equal(signalSpy.callCount, 0, 'Signal.create must not be called by legacy BUY');
    assert.equal(riskSpy.callCount, 0, 'RiskEngine.evaluate must not be called by legacy BUY');
    assert.equal(routerSpy.callCount, 0, 'ExecutionRouter.route must not be called by legacy BUY');
    assert.equal(paperOpenSpy.callCount, 0, 'PaperEngine.openPosition must not be called by legacy BUY');
    assert.equal(liveOpenSpy.callCount, 0, 'LiveEngine.openPosition must not be called by legacy BUY');
    assert.equal(fakeInstance.currentPosition, null, 'legacy runtime currentPosition must remain null (not treated as authoritative)');
  } finally {
    tradeSpy.restore();
    positionSpy.restore();
    signalSpy.restore();
    riskSpy.restore();
    routerSpy.restore();
    paperOpenSpy.restore();
    liveOpenSpy.restore();
  }
});

// ===========================================================
// Test B — Legacy SELL produces zero authoritative side effects
// ===========================================================

test('[Part 7] Legacy SELL: BotEngineManager.handleTradeExecution creates no Trade/Position/Signal and touches no execution engine', async () => {
  const botEngineManager = require('../services/BotEngineManager');
  const Trade = require('../models/Trade');
  const Position = require('../models/Position');
  const Signal = require('../models/Signal');
  const executionRouter = require('../services/execution/ExecutionRouter');

  const tradeSpy = spyOn(Trade, 'create');
  const positionSpy = spyOn(Position, 'create');
  const signalSpy = spyOn(Signal, 'create');
  const routerSpy = spyOn(executionRouter, 'route');

  try {
    const fakeInstance = {
      instanceId: 'legacy_test_sell',
      modelId: 'Model001',
      symbol: 'BTCUSD',
      currentPosition: null,
    };

    await botEngineManager.handleTradeExecution(
      fakeInstance,
      50000,
      { decision: 'SELL', humanReason: 'mock breakdown', factors: {}, sl: 51000, tp: 48000 },
    );

    assert.equal(tradeSpy.callCount, 0, 'Trade.create must not be called by legacy SELL');
    assert.equal(positionSpy.callCount, 0, 'Position.create must not be called by legacy SELL');
    assert.equal(signalSpy.callCount, 0, 'Signal.create must not be called by legacy SELL');
    assert.equal(routerSpy.callCount, 0, 'ExecutionRouter.route must not be called by legacy SELL');
    assert.equal(fakeInstance.currentPosition, null);
  } finally {
    tradeSpy.restore();
    positionSpy.restore();
    signalSpy.restore();
    routerSpy.restore();
  }
});

// ===========================================================
// Test D — Legacy engine-level pause/stop: once stopped, an instance is
// dropped from the active set and no longer evaluated on new ticks.
// (No DB required — BotInstance.updateOne is stubbed so this test proves
// the in-memory guarantee independent of persistence.)
// ===========================================================

test('[Part 7] BotEngineManager.stopInstance removes the instance so further price ticks are ignored (no trade path reachable)', async () => {
  const botEngineManager = require('../services/BotEngineManager');
  const BotInstance = require('../models/BotInstance');
  const TechnicalAnalysisService = require('../services/TechnicalAnalysisService');

  const originalUpdateOne = BotInstance.updateOne;
  BotInstance.updateOne = async () => ({ acknowledged: true });

  const evalSpy = spyOn(TechnicalAnalysisService, 'evaluateModelStrategy');
  const execSpy = spyOn(botEngineManager, 'handleTradeExecution');

  try {
    // Manually seed an active runtime instance the way startInstance() would,
    // without touching Mongo.
    botEngineManager.activeInstances.set('legacy_test_pause', {
      instanceId: 'legacy_test_pause',
      modelId: 'Model001',
      symbol: 'ETHUSD',
      config: {},
      status: 'RUNNING',
      lastPrice: 0,
      currentPosition: null,
      thinking: { factors: {}, decision: 'WAIT', humanReason: '' },
    });

    assert.ok(botEngineManager.getInstanceRuntimeState('legacy_test_pause'), 'instance should be active before stop');

    await botEngineManager.stopInstance('legacy_test_pause');
    assert.equal(botEngineManager.getInstanceRuntimeState('legacy_test_pause'), null, 'instance must be removed from activeInstances after stop');

    // Feed a price tick that would have matched the (now-removed) instance's symbol.
    await botEngineManager.processPriceTick('ETHUSD', { price: 3000, timestamp: Date.now() });

    assert.equal(evalSpy.callCount, 0, 'a stopped instance must not be evaluated on new price ticks');
    assert.equal(execSpy.callCount, 0, 'a stopped instance must never reach handleTradeExecution');
  } finally {
    BotInstance.updateOne = originalUpdateOne;
    evalSpy.restore();
    execSpy.restore();
    botEngineManager.activeInstances.delete('legacy_test_pause');
  }
});

// ===========================================================
// Test C — Real MODEL_001 trade + double-engine test combined:
// a genuine breakout drives MODEL_001 -> BotManager -> RiskEngine ->
// ExecutionRouter -> PaperEngine to open exactly one Position, WHILE the
// legacy engine is simultaneously fed a forced BUY for the same
// instance/symbol/price. Exactly one Trade-producing path must have fired.
// ===========================================================

test('[Part 7] Double-engine test: real MODEL_001 breakout opens exactly one PAPER position even when legacy BotEngineManager is simultaneously triggered', async (t) => {
  if (!dbAvailable) {
    t.skip('MongoDB not available in this environment');
    return;
  }

  const User = require('../models/User');
  const Position = require('../models/Position');
  const Signal = require('../models/Signal');
  const botManager = require('../services/botManager/BotManager');
  const botEngineManager = require('../services/BotEngineManager');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const marketData = require('../services/marketData');
  const MockProvider = require('./helpers/mockProvider');

  const mockProvider = new MockProvider();
  marketData._setProviderForTesting(mockProvider);

  await botManager.discoverModels();

  const user = await User.create({ username: 'part7_double_engine_user', passwordHash: 'x' });
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

  // Simultaneously "trigger" the legacy engine for the exact same instance
  // with a forced BUY at the same market condition. If legacy retained any
  // trading authority, this would independently open a second position.
  const legacyInstance = {
    instanceId: instance.instanceId,
    modelId: 'Model001',
    symbol: 'BTCUSD',
    currentPosition: null,
  };
  await botEngineManager.handleTradeExecution(
    legacyInstance,
    201,
    { decision: 'BUY', humanReason: 'legacy mock breakout (should be a no-op)', factors: {}, sl: 195, tp: 210 },
  );

  // Drive the REAL breakout through the authoritative pipeline.
  for (let i = 0; i <= 3; i += 1) {
    await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + i * MIN });
  }
  await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 200 }, timestamp: BASE + 3 * MIN + 1000 });
  await botManager.dispatchMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN });

  // Fire the legacy "trigger" again, after the real trade, for good measure.
  await botEngineManager.handleTradeExecution(
    legacyInstance,
    201,
    { decision: 'BUY', humanReason: 'legacy mock breakout (should still be a no-op)', factors: {}, sl: 195, tp: 210 },
  );

  const positions = await Position.find({ instanceId: instance.instanceId });
  assert.equal(positions.length, 1, 'exactly one authoritative position must exist — the real MODEL_001 trade, never a legacy duplicate');
  assert.equal(positions[0].source, 'BOT');
  assert.equal(positions[0].modelId, 'MODEL_001');

  const signals = await Signal.find({ instanceId: instance.instanceId });
  assert.equal(signals.length, 0, 'legacy must not have written any authoritative Signal documents for this instance');

  assert.equal(legacyInstance.currentPosition, null, 'legacy runtime currentPosition must never have been populated');
});

// ===========================================================
// Test E — PAUSE / STOP: a paused or stopped bot cannot trade through
// either path, and Current Price / market telemetry is unaffected.
// ===========================================================

test('[Part 7] Pause/Stop: neither MODEL_001 nor legacy can open a position for a non-RUNNING bot instance', async (t) => {
  if (!dbAvailable) {
    t.skip('MongoDB not available in this environment');
    return;
  }

  const User = require('../models/User');
  const BotInstance = require('../models/BotInstance');
  const Position = require('../models/Position');
  const botManager = require('../services/botManager/BotManager');
  const botEngineManager = require('../services/BotEngineManager');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const marketData = require('../services/marketData');
  const MockProvider = require('./helpers/mockProvider');

  const mockProvider = new MockProvider();
  marketData._setProviderForTesting(mockProvider);

  await botManager.discoverModels();

  const user = await User.create({ username: 'part7_pause_stop_user', passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const instance = await botManager.createInstance({
    userId: user._id,
    modelId: 'MODEL_001',
    symbol: 'ADAUSD',
    environment: 'PAPER',
    parameters: { timeframe: '1m', breakoutLookback: 3, historySize: 20, stopLossPercent: 1, takeProfitPercent: 2 },
    capitalAllocation: 5000,
    leverage: 2,
  });

  mockProvider.setPrice('ADAUSD', 100, Date.now());
  await botManager.startInstance(instance.instanceId);
  await botEngineManager.startInstance(instance.instanceId);

  // PAUSE (mirrors botInstancesController.pauseInstance's Part 7 wiring)
  await botManager.pauseInstance(instance.instanceId);
  await botEngineManager.stopInstance(instance.instanceId);

  const pausedDb = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(pausedDb.status, 'PAUSED');
  assert.equal(botEngineManager.getInstanceRuntimeState(instance.instanceId), null, 'legacy telemetry must stop tracking a paused bot');

  // Even a genuine breakout sequence must not open a position while PAUSED —
  // BotManager.dispatchMarketData only evaluates instances with status RUNNING.
  for (let i = 0; i <= 4; i += 1) {
    await botManager.dispatchMarketData({ type: 'price', symbol: 'ADAUSD', data: { price: i < 3 ? 100 : 300 }, timestamp: BASE + 10 * MIN + i * MIN });
  }
  let positions = await Position.find({ instanceId: instance.instanceId });
  assert.equal(positions.length, 0, 'no position may open while PAUSED');

  // STOP (mirrors botInstancesController.stopInstance)
  await botManager.stopInstance(instance.instanceId);
  await botEngineManager.stopInstance(instance.instanceId);

  const stoppedDb = await BotInstance.findOne({ instanceId: instance.instanceId });
  assert.equal(stoppedDb.status, 'STOPPED');

  for (let i = 0; i <= 4; i += 1) {
    await botManager.dispatchMarketData({ type: 'price', symbol: 'ADAUSD', data: { price: i < 3 ? 100 : 400 }, timestamp: BASE + 20 * MIN + i * MIN });
  }
  positions = await Position.find({ instanceId: instance.instanceId });
  assert.equal(positions.length, 0, 'no position may open while STOPPED');

  // Current Price / market telemetry (Part 6/7 requirement: unrelated to bot
  // trading authority) must still function for a paused/stopped bot's symbol.
  await paperEngine.refreshUnrealizedForSymbol('ADAUSD', 105);
});
