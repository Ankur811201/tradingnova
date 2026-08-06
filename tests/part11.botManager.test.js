'use strict';

/**
 * Part 11 — integration tests for BotManager's production-stabilization
 * behavior: history hydration on start, strategy readiness, no historical
 * execution, restart-safe levelCounts recovery, and Save Configuration
 * validation.
 *
 * SKIPPED automatically if no MongoDB is reachable, same convention as
 * tests/part9.executionState.test.js / tests/integration.test.js.
 */

const { test, before, after, beforeEach } = require('node:test');
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
    console.log(`[part11 botManager tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
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

const MIN5 = 5 * 60 * 1000;

/** Inserts `count` real, distinct, closed Candle documents ending at `endTs`. */
async function seedClosedCandles(Candle, symbol, timeframe, count, endTs) {
  const docs = [];
  let price = 64000;
  for (let i = 0; i < count; i += 1) {
    const ts = endTs - (count - i) * MIN5;
    const open = price;
    const close = price + (i % 2 === 0 ? 5 : -5);
    docs.push({
      symbol, timeframe, timestamp: ts,
      open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close,
      volume: null, closed: true, source: 'delta',
    });
    price = close;
  }
  await Candle.insertMany(docs);
  return docs;
}

test('Part 11 — BotManager hydration + readiness + no-historical-execution + restart + levelCounts + config validation', { skip: () => !dbAvailable && 'MongoDB not reachable' }, async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not reachable'); return; }

  const BotInstance = require('../models/BotInstance');
  const StrategyEvent = require('../models/StrategyEvent');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const botManager = require('../services/botManager/BotManager');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const io = createMockIo();
  botManager.attachSocketServer(io);
  await botManager.discoverModels();

  const user = await User.create({ username: `part11_user_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const SYMBOL = 'BTCUSD';
  const TIMEFRAME = '5m';
  const now = Date.now();

  // ---- Test 1/6: sufficient real history -> READY without waiting -------
  {
    const endTs = Math.floor(now / MIN5) * MIN5;
    await seedClosedCandles(Candle, SYMBOL, TIMEFRAME, 80, endTs);

    const instance = await botManager.createInstance({
      name: 'part11_ready', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL,
      environment: 'PAPER', parameters: { timeframe: TIMEFRAME }, capitalAllocation: 10000, leverage: 2,
    });

    await botManager.startInstance(instance.instanceId);
    const readiness = botManager.getReadiness(instance.instanceId);
    assert.equal(readiness.state, 'READY', 'Test 1: 80 real closed candles (>= 50 required) must yield READY immediately');
    assert.ok(readiness.have >= 50);

    // ---- Test 3: hydration must not execute any historical BUY/SELL ----
    const ruleMatchedEvents = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'RULE_MATCHED' }).lean();
    const decisionEvents = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).lean();
    assert.equal(ruleMatchedEvents.length, 0, 'Test 3: hydration must never emit RULE_MATCHED (i.e. never trade on history)');
    assert.equal(decisionEvents.length, 0, 'Test 3: hydration must never emit a DECISION');

    // ---- Test 6: restart is READY again without a 50-candle live wait --
    await botManager.restartInstance(instance.instanceId);
    const readinessAfterRestart = botManager.getReadiness(instance.instanceId);
    assert.equal(readinessAfterRestart.state, 'READY', 'Test 6: restart must rehydrate to READY, not wait for 50 new live candles');

    await botManager.stopInstance(instance.instanceId);
  }

  // ---- Test 2: insufficient real history -> honest INSUFFICIENT_HISTORY -
  {
    const endTs = Math.floor(now / MIN5) * MIN5 - 10_000_000; // separate bucket range, unique symbol below
    const SYMBOL2 = 'ETHUSD';
    await seedClosedCandles(Candle, SYMBOL2, TIMEFRAME, 20, endTs);

    const instance = await botManager.createInstance({
      name: 'part11_insufficient', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL2,
      environment: 'PAPER', parameters: { timeframe: TIMEFRAME }, capitalAllocation: 10000, leverage: 2,
    });

    await botManager.startInstance(instance.instanceId);
    const readiness = botManager.getReadiness(instance.instanceId);
    assert.equal(readiness.state, 'INSUFFICIENT_HISTORY');
    assert.equal(readiness.have, 20, 'must report the real count, never fabricated');
    assert.equal(readiness.required, 50);

    await botManager.stopInstance(instance.instanceId);
  }

  // ---- Test 8: levelCounts recovery blocks a restart exploit -------------
  {
    const SYMBOL3 = 'SOLUSD';
    const endTs = Math.floor(now / MIN5) * MIN5;
    await seedClosedCandles(Candle, SYMBOL3, TIMEFRAME, 60, endTs);

    const instance = await botManager.createInstance({
      name: 'part11_levelcounts', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL3,
      environment: 'PAPER', parameters: { timeframe: TIMEFRAME, maxTradesPerLevel: 2 }, capitalAllocation: 10000, leverage: 2,
    });

    // Simulate two already-recorded level-limited trades from a prior run.
    await StrategyEvent.create({
      instanceId: instance.instanceId, modelId: 'MODEL_001', symbol: SYMBOL3, eventType: 'RULE_MATCHED',
      payload: { ruleId: 'L1_WITH_BUY', metadata: { levelUpdated: 'l1' } }, at: new Date(),
    });
    await StrategyEvent.create({
      instanceId: instance.instanceId, modelId: 'MODEL_001', symbol: SYMBOL3, eventType: 'RULE_MATCHED',
      payload: { ruleId: 'L1_AGAINST_SELL', metadata: { levelUpdated: 'l1' } }, at: new Date(),
    });

    await botManager.startInstance(instance.instanceId);
    const live = botManager.liveInstances.get(instance.instanceId);
    assert.ok(live, 'instance must be registered live after start');
    assert.equal(live.modelInstance.levelCounts.l1, 2, 'Test 8: levelCounts.l1 must be recovered to 2, not reset to 0');

    await botManager.stopInstance(instance.instanceId);
  }

  // ---- Test 11: starting an already-RUNNING instance is idempotent -------
  {
    const SYMBOL4 = 'BNBUSD';
    const endTs = Math.floor(now / MIN5) * MIN5;
    await seedClosedCandles(Candle, SYMBOL4, TIMEFRAME, 60, endTs);
    const instance = await botManager.createInstance({
      name: 'part11_idempotent', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL4,
      environment: 'PAPER', parameters: { timeframe: TIMEFRAME }, capitalAllocation: 10000, leverage: 2,
    });

    await botManager.startInstance(instance.instanceId);
    const before1 = botManager.liveInstances.get(instance.instanceId).modelInstance;
    await botManager.startInstance(instance.instanceId); // second Start click
    const after1 = botManager.liveInstances.get(instance.instanceId).modelInstance;
    assert.equal(before1, after1, 'Test 11: a second Start while RUNNING must not create a second runtime');

    await botManager.stopInstance(instance.instanceId);
  }

  // ---- Test 9/10: Save Configuration timeframe validation -----------------
  {
    const SYMBOL5 = 'XRPUSD';
    const instance = await botManager.createInstance({
      name: 'part11_config', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL5,
      environment: 'PAPER', parameters: { timeframe: '5m' }, capitalAllocation: 10000, leverage: 2,
    });

    // Test 10: invalid timeframe rejected
    await assert.rejects(
      () => botManager.updateConfiguration(instance.instanceId, { timeframe: 'abc' }),
      /Invalid timeframe/
    );
    await assert.rejects(
      () => botManager.updateConfiguration(instance.instanceId, { timeframe: '' }),
      /No valid configuration/
    );

    // Test 9: valid timeframe accepted while STOPPED, applied everywhere
    const updated = await botManager.updateConfiguration(instance.instanceId, { timeframe: '15m', capital: 5000 });
    assert.equal(updated.parameters.timeframe, '15m');
    assert.equal(updated.capitalAllocation, 5000);

    // Config while RUNNING: timeframe change must be rejected
    await seedClosedCandles(Candle, SYMBOL5, '15m', 60, Math.floor(now / (15 * 60 * 1000)) * (15 * 60 * 1000));
    await botManager.startInstance(instance.instanceId);
    await assert.rejects(
      () => botManager.updateConfiguration(instance.instanceId, { timeframe: '1h' }),
      /RUNNING/
    );
    // But capital can still be changed while RUNNING.
    const stillRunning = await botManager.updateConfiguration(instance.instanceId, { capital: 7500 });
    assert.equal(stillRunning.capitalAllocation, 7500);

    await botManager.stopInstance(instance.instanceId);
  }
});
