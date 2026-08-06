'use strict';

/**
 * Part 6 integration tests — MODEL_001 consuming the CANONICAL closed
 * candle produced by CandlePersistenceService (the same candle written to
 * MongoDB / broadcast to the chart), instead of independently rebuilding
 * its own candle from raw price ticks.
 *
 * These tests replicate the exact production wiring added to server.js:
 *
 *   candlePersistenceService.processTick(symbol, price, timestamp)
 *     -> events[]
 *        -> for each event where event.candle.closed === true:
 *             botManager.dispatchMarketData({ type: 'candle', ... })
 *
 * Automatically SKIPPED if no MongoDB is reachable (same pattern as
 * tests/model001.integration.test.js). To run for real:
 *
 *   MONGODB_URI_TEST=mongodb://127.0.0.1:27017/nova_trade_test npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const TEST_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/nova_trade_test';
const MIN = 60 * 1000;
const BASE = 30 * MIN; // divisible by both 1m and 3m buckets, so bucket math is easy to reason about

let dbAvailable = false;

before(async () => {
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 1500 });
    dbAvailable = true;
  } catch (err) {
    dbAvailable = false;
    console.log(`[part6 tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

/**
 * Exactly reproduces the production candle-dispatch wiring added to
 * server.js in Part 6: feed one real tick through the canonical
 * CandlePersistenceService, then forward any CLOSED events (and only
 * closed events) to BotManager as type:'candle'. Returns the raw events
 * for assertions.
 */
async function feedCanonicalTick(symbol, price, timestamp) {
  const candlePersistenceService = require('../services/marketData/CandlePersistenceService');
  const botManager = require('../services/botManager/BotManager');

  const events = await candlePersistenceService.processTick(symbol, price, timestamp);
  for (const event of events) {
    if (!event.candle.closed) continue;
    await botManager.dispatchMarketData({
      type: 'candle',
      symbol: event.symbol,
      timeframe: event.timeframe,
      timestamp: event.candle.timestamp,
      data: {
        timestamp: event.candle.timestamp,
        open: event.candle.open,
        high: event.candle.high,
        low: event.candle.low,
        close: event.candle.close,
        volume: event.candle.volume,
        closed: event.candle.closed,
      },
    });
  }
  return events;
}

async function makeRunningInstance({ userSuffix, symbol, timeframe, capitalAllocation = 5000 }) {
  const User = require('../models/User');
  const botManager = require('../services/botManager/BotManager');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  const user = await User.create({ username: `part6_${userSuffix}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const instance = await botManager.createInstance({
    userId: user._id,
    modelId: 'MODEL_001',
    symbol,
    environment: 'PAPER',
    parameters: { timeframe, breakoutLookback: 3, historySize: 20, stopLossPercent: 1, takeProfitPercent: 2 },
    capitalAllocation,
    leverage: 2,
  });

  await botManager.startInstance(instance.instanceId);
  return instance;
}

test('canonical equality: the candle MODEL_001 receives matches MongoDB exactly (same timestamp/OHLC/volume/closed)', async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not available'); return; }

  const botManager = require('../services/botManager/BotManager');
  const Candle = require('../models/Candle');
  await botManager.discoverModels();

  const symbol = 'BTCUSD';
  const instance = await makeRunningInstance({ userSuffix: 'canon', symbol, timeframe: '1m' });

  // Flat ticks across bucket 0, then a tick that opens bucket 1 (closing bucket 0).
  await feedCanonicalTick(symbol, 100, BASE);
  const events = await feedCanonicalTick(symbol, 105, BASE + MIN);

  const closedEvent = events.find((e) => e.candle.closed);
  assert.ok(closedEvent, 'expected a closed-candle event on bucket rollover');

  const storedCandle = await Candle.findOne({ symbol, timeframe: '1m', timestamp: BASE }).lean();
  assert.ok(storedCandle, 'expected the closed candle to be persisted in MongoDB');
  assert.equal(storedCandle.closed, true);

  // The exact same values, field for field, must be what was dispatched.
  assert.equal(closedEvent.candle.timestamp, storedCandle.timestamp);
  assert.equal(closedEvent.candle.open, storedCandle.open);
  assert.equal(closedEvent.candle.high, storedCandle.high);
  assert.equal(closedEvent.candle.low, storedCandle.low);
  assert.equal(closedEvent.candle.close, storedCandle.close);
  assert.equal(closedEvent.candle.volume, storedCandle.volume);
  assert.equal(closedEvent.candle.closed, storedCandle.closed);

  await botManager.stopInstance(instance.instanceId);
});

test('forming candles are never dispatched to MODEL_001 (no CANDLE_PROCESSED strategy event until rollover)', async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not available'); return; }

  const botManager = require('../services/botManager/BotManager');
  const StrategyEvent = require('../models/StrategyEvent');
  await botManager.discoverModels();

  const symbol = 'BTCUSD';
  const instance = await makeRunningInstance({ userSuffix: 'forming', symbol, timeframe: '1m' });

  // Several ticks INSIDE the same 1m bucket — all forming, no rollover.
  await feedCanonicalTick(symbol, 100, BASE);
  await feedCanonicalTick(symbol, 101, BASE + 10 * 1000);
  await feedCanonicalTick(symbol, 99, BASE + 20 * 1000);
  await feedCanonicalTick(symbol, 102, BASE + 30 * 1000);

  const processedBeforeRollover = await StrategyEvent.countDocuments({
    instanceId: instance.instanceId, eventType: 'CANDLE_PROCESSED',
  });
  assert.equal(processedBeforeRollover, 0, 'MODEL_001 must not process a still-forming candle');

  // Now cross into the next bucket — exactly one closed candle should be dispatched.
  await feedCanonicalTick(symbol, 103, BASE + MIN);

  const processedAfterRollover = await StrategyEvent.countDocuments({
    instanceId: instance.instanceId, eventType: 'CANDLE_PROCESSED',
  });
  assert.equal(processedAfterRollover, 1, 'exactly one closed candle should have been evaluated on rollover');

  await botManager.stopInstance(instance.instanceId);
});

test('timeframe isolation: a 1m bot and a 3m bot on the same symbol only receive their own timeframe\'s closed candles', async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not available'); return; }

  const botManager = require('../services/botManager/BotManager');
  const StrategyEvent = require('../models/StrategyEvent');
  await botManager.discoverModels();

  const symbol = 'ISO_TF_SYMBOL';
  const botA = await makeRunningInstance({ userSuffix: 'tf_a', symbol, timeframe: '1m' });
  const botB = await makeRunningInstance({ userSuffix: 'tf_b', symbol, timeframe: '3m' });

  const countFor = (instanceId) => StrategyEvent.countDocuments({ instanceId, eventType: 'CANDLE_PROCESSED' });

  // Flat price so no trade signals fire — this test is purely about routing.
  await feedCanonicalTick(symbol, 100, BASE + 0 * MIN);
  await feedCanonicalTick(symbol, 100, BASE + 1 * MIN);
  await feedCanonicalTick(symbol, 100, BASE + 2 * MIN);

  // After 3 minutes: the 1m bot has seen 2 rollovers (bucket0->1, bucket1->2).
  // The 3m bot's first bucket (0-3m) hasn't closed yet.
  assert.equal(await countFor(botA.instanceId), 2, 'the 1m bot should have processed 2 closed candles by t=2m');
  assert.equal(await countFor(botB.instanceId), 0, 'the 3m bot must not receive anything before its own bucket closes');

  await feedCanonicalTick(symbol, 100, BASE + 3 * MIN);
  await feedCanonicalTick(symbol, 100, BASE + 4 * MIN);

  assert.equal(await countFor(botA.instanceId), 4, 'the 1m bot should have processed 4 closed candles by t=4m');
  assert.equal(await countFor(botB.instanceId), 1, 'the 3m bot should have received exactly its one closed 3m candle, never the 1m bot\'s candles');

  await botManager.stopInstance(botA.instanceId);
  await botManager.stopInstance(botB.instanceId);
});

test('symbol isolation: a closed candle for one symbol never reaches a bot watching a different symbol', async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not available'); return; }

  const botManager = require('../services/botManager/BotManager');
  const StrategyEvent = require('../models/StrategyEvent');
  await botManager.discoverModels();

  const botA = await makeRunningInstance({ userSuffix: 'sym_a', symbol: 'ISO_SYM_A', timeframe: '1m' });
  const botB = await makeRunningInstance({ userSuffix: 'sym_b', symbol: 'ISO_SYM_B', timeframe: '1m' });

  await feedCanonicalTick('ISO_SYM_A', 100, BASE);
  await feedCanonicalTick('ISO_SYM_A', 100, BASE + MIN);

  const countA = await StrategyEvent.countDocuments({ instanceId: botA.instanceId, eventType: 'CANDLE_PROCESSED' });
  const countB = await StrategyEvent.countDocuments({ instanceId: botB.instanceId, eventType: 'CANDLE_PROCESSED' });
  assert.equal(countA, 1, 'bot watching ISO_SYM_A should have processed the closed candle');
  assert.equal(countB, 0, 'bot watching ISO_SYM_B must never receive a different symbol\'s candle');

  await botManager.stopInstance(botA.instanceId);
  await botManager.stopInstance(botB.instanceId);
});

test('duplicate closed-candle dispatch is evaluated at most once (existing lastProcessedCandleTimestamp guard holds via the new candle path)', async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not available'); return; }

  const botManager = require('../services/botManager/BotManager');
  const StrategyEvent = require('../models/StrategyEvent');
  await botManager.discoverModels();

  const symbol = 'BTCUSD';
  const instance = await makeRunningInstance({ userSuffix: 'dupe', symbol, timeframe: '1m' });

  await feedCanonicalTick(symbol, 100, BASE);
  const events = await feedCanonicalTick(symbol, 100, BASE + MIN);
  const closedEvent = events.find((e) => e.candle.closed);
  assert.ok(closedEvent);

  const countAfterFirst = await StrategyEvent.countDocuments({
    instanceId: instance.instanceId, eventType: 'CANDLE_PROCESSED',
  });
  assert.equal(countAfterFirst, 1);

  // Re-dispatch the EXACT same closed-candle event a second time (simulating
  // a bug elsewhere re-delivering it, or an out-of-order network replay).
  await botManager.dispatchMarketData({
    type: 'candle',
    symbol: closedEvent.symbol,
    timeframe: closedEvent.timeframe,
    timestamp: closedEvent.candle.timestamp,
    data: {
      timestamp: closedEvent.candle.timestamp,
      open: closedEvent.candle.open,
      high: closedEvent.candle.high,
      low: closedEvent.candle.low,
      close: closedEvent.candle.close,
      volume: closedEvent.candle.volume,
      closed: closedEvent.candle.closed,
    },
  });

  const countAfterDuplicate = await StrategyEvent.countDocuments({
    instanceId: instance.instanceId, eventType: 'CANDLE_PROCESSED',
  });
  assert.equal(countAfterDuplicate, 1, 'a duplicate closed candle must not be evaluated a second time');

  await botManager.stopInstance(instance.instanceId);
});

test('PAPER execution path: a real breakout closed candle flows MODEL_001 -> RiskEngine -> ExecutionRouter -> PaperEngine -> Position (no legacy BotEngineManager involved)', async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not available'); return; }

  const botManager = require('../services/botManager/BotManager');
  const Position = require('../models/Position');
  await botManager.discoverModels();

  const symbol = 'BTCUSD';
  const instance = await makeRunningInstance({ userSuffix: 'paper_exec', symbol, timeframe: '1m' });

  // 3 flat warm-up candles, then a strong breakout candle, closed by the next tick —
  // mirrors the breakout sequence in tests/model001.integration.test.js, but driven
  // entirely through the canonical CandlePersistenceService path (no raw type:'price'
  // dispatch to BotManager anywhere in this test).
  await feedCanonicalTick(symbol, 100, BASE);
  await feedCanonicalTick(symbol, 100, BASE + MIN);
  await feedCanonicalTick(symbol, 100, BASE + 2 * MIN);
  await feedCanonicalTick(symbol, 100, BASE + 3 * MIN);
  await feedCanonicalTick(symbol, 200, BASE + 3 * MIN + 1000); // breakout close inside bucket 3
  await feedCanonicalTick(symbol, 201, BASE + 4 * MIN); // rolls bucket 3 closed -> MODEL_001 evaluates

  const positions = await Position.find({ instanceId: instance.instanceId });
  assert.equal(positions.length, 1, 'expected exactly one PAPER position opened via the canonical candle path');
  assert.equal(positions[0].environment, 'PAPER');
  assert.equal(positions[0].side, 'LONG');
  assert.equal(positions[0].source, 'BOT');
  assert.equal(positions[0].modelId, 'MODEL_001');

  await botManager.stopInstance(instance.instanceId);
});
