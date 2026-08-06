'use strict';

/**
 * Part 12 — tests for real Delta historical candle backfill:
 *
 *   CandleBackfillService.ensureSufficientHistory
 *   BotManager._hydrateInstance (backfill-then-hydrate integration)
 *
 * Synchronous validation (bad symbol/timeframe) is tested with no MongoDB
 * needed. Everything that touches the canonical Candle collection is
 * gated behind a MongoDB reachability check, same convention as
 * tests/part11.botManager.test.js / tests/part11_1.concurrency.test.js.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const MarketDataProvider = require('../services/marketData/MarketDataProvider');
const marketData = require('../services/marketData/index');
const candleBackfillService = require('../services/marketData/CandleBackfillService');

const TEST_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/nova_trade_test';
const MIN5 = 5 * 60 * 1000;

let dbAvailable = false;

before(async () => {
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 1500 });
    dbAvailable = true;
  } catch (err) {
    dbAvailable = false;
    console.log(`[part12 tests] Skipping DB-backed tests: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

/**
 * Deterministic in-memory historical provider — returns a configurable set
 * of real-shaped candles ending at `endTs`. Records every call so tests
 * can assert on how many (and whether) real historical requests were made.
 */
class FakeHistoricalProvider extends MarketDataProvider {
  constructor({ candles = null, count = 0, endTs = Date.now(), tfMs = MIN5, shouldFail = false, failMessage = 'simulated Delta outage' } = {}) {
    super();
    this.shouldFail = shouldFail;
    this.failMessage = failMessage;
    this.calls = [];
    if (candles) {
      this.candles = candles;
    } else {
      this.candles = [];
      let price = 64000;
      for (let i = 0; i < count; i += 1) {
        const ts = endTs - (count - i) * tfMs;
        const open = price;
        const close = price + (i % 2 === 0 ? 5 : -5);
        this.candles.push({
          timestamp: ts, open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close, volume: 12.5,
        });
        price = close;
      }
    }
  }

  async getCandles(symbol, timeframe, options) {
    this.calls.push({ symbol, timeframe, options });
    if (this.shouldFail) throw new Error(this.failMessage);
    return this.candles;
  }

  async getPrice() { throw new Error('not used'); }
  subscribePrice() { return () => {}; }
  subscribeCandles() { return () => {}; }
  getConnectionStatus() { return { configured: true, connected: true, providerName: 'fake_history' }; }
  isDataFresh() { return true; }
}

// ---------------------------------------------------------------------
// Synchronous validation — no DB needed.
// ---------------------------------------------------------------------

test('Part 12 — ensureSufficientHistory rejects a missing/invalid symbol', async () => {
  await assert.rejects(
    () => candleBackfillService.ensureSufficientHistory({ symbol: '', timeframe: '5m', targetCount: 60 }),
    /requires a symbol string/
  );
});

test('Part 12 — ensureSufficientHistory rejects an unsupported timeframe (never silently falls back)', async () => {
  await assert.rejects(
    () => candleBackfillService.ensureSufficientHistory({ symbol: 'BTCUSD', timeframe: '2m', targetCount: 60 }),
    /unsupported timeframe/
  );
});

// ---------------------------------------------------------------------
// DB-gated: CandleBackfillService against the real Candle collection.
// ---------------------------------------------------------------------

test('Part 12 — CandleBackfillService', { skip: () => !dbAvailable && 'MongoDB not reachable' }, async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not reachable'); return; }

  const Candle = require('../models/Candle');

  await t.test('Test 3 — already-sufficient Mongo history makes zero provider calls', async () => {
    const SYMBOL = 'P12_SUFFICIENT';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5;
    const fake = new FakeHistoricalProvider({ count: 0 });
    marketData._setProviderForTesting(fake);

    const docs = [];
    for (let i = 0; i < 80; i += 1) {
      docs.push({
        symbol: SYMBOL, timeframe: '5m', timestamp: endTs - (80 - i) * MIN5,
        open: 100, high: 102, low: 98, close: 101, volume: null, closed: true, source: 'delta',
      });
    }
    await Candle.insertMany(docs);

    const result = await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });
    assert.equal(result.backfilled, false);
    assert.equal(fake.calls.length, 0, 'no Delta historical request when Mongo already has enough');
    assert.equal(result.mongoAfter, 80);
  });

  await t.test('Test 1 — empty Mongo + real historical response persists and reaches target', async () => {
    const SYMBOL = 'P12_EMPTY';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake = new FakeHistoricalProvider({ count: 70, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const result = await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });
    assert.equal(result.backfilled, true);
    assert.ok(fake.calls.length >= 1);
    assert.ok(result.mongoAfter >= 60, `expected >=60 persisted closed candles, got ${result.mongoAfter}`);

    const count = await Candle.countDocuments({ symbol: SYMBOL, timeframe: '5m', closed: true });
    assert.equal(count, result.mongoAfter);
  });

  await t.test('Test 2 — partial Mongo history is topped up by real backfill', async () => {
    const SYMBOL = 'P12_PARTIAL';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const seedDocs = [];
    for (let i = 0; i < 10; i += 1) {
      seedDocs.push({
        symbol: SYMBOL, timeframe: '5m', timestamp: endTs - (10 - i) * MIN5,
        open: 100, high: 102, low: 98, close: 101, volume: null, closed: true, source: 'delta',
      });
    }
    await Candle.insertMany(seedDocs);

    const fake = new FakeHistoricalProvider({ count: 70, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const result = await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });
    assert.equal(result.backfilled, true);
    assert.ok(result.mongoAfter >= 60);
  });

  await t.test('Test 4 — idempotency: running backfill twice creates no duplicate documents', async () => {
    const SYMBOL = 'P12_IDEMPOTENT';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake = new FakeHistoricalProvider({ count: 70, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });
    const afterFirst = await Candle.countDocuments({ symbol: SYMBOL, timeframe: '5m' });

    const fake2 = new FakeHistoricalProvider({ count: 70, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake2);
    await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });
    const afterSecond = await Candle.countDocuments({ symbol: SYMBOL, timeframe: '5m' });

    assert.equal(afterSecond, afterFirst, 'no duplicate documents from a repeated backfill request');

    const distinct = await Candle.aggregate([
      { $match: { symbol: SYMBOL, timeframe: '5m' } },
      { $group: { _id: '$timestamp', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    assert.equal(distinct.length, 0, 'every (symbol,timeframe,timestamp) has exactly one document');
  });

  await t.test('Test 5 — the still-forming current bucket is never persisted as a closed historical candle', async () => {
    const SYMBOL = 'P12_FORMING';
    const nowBucket = Math.floor(Date.now() / MIN5) * MIN5;
    const fake = new FakeHistoricalProvider({ count: 65, endTs: nowBucket + MIN5, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });

    const currentBucketDoc = await Candle.findOne({ symbol: SYMBOL, timeframe: '5m', timestamp: nowBucket }).lean();
    assert.equal(currentBucketDoc, null, 'the still-forming bucket must not be persisted by backfill');
  });

  await t.test('Test 8 — boundary duplicate: a bucket the live pipeline already owns is never overwritten', async () => {
    const SYMBOL = 'P12_COLLISION';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const bucketTs = endTs - 5 * MIN5;

    await Candle.create({
      symbol: SYMBOL, timeframe: '5m', timestamp: bucketTs,
      open: 111, high: 115, low: 109, close: 113, volume: null, closed: true, source: 'delta',
    });

    const fake = new FakeHistoricalProvider({ count: 70, endTs, tfMs: MIN5 });
    fake.candles = fake.candles.map((c) => (c.timestamp === bucketTs ? Object.assign({}, c, { open: 999, close: 998 }) : c));
    marketData._setProviderForTesting(fake);

    await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });

    const doc = await Candle.findOne({ symbol: SYMBOL, timeframe: '5m', timestamp: bucketTs }).lean();
    assert.equal(doc.close, 113, 'an existing closed candle must never be overwritten by historical backfill');
  });

  await t.test('Test 9 — real volume from the provider is preserved, never fabricated', async () => {
    const SYMBOL = 'P12_VOLUME';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake = new FakeHistoricalProvider({ count: 65, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });

    const doc = await Candle.findOne({ symbol: SYMBOL, timeframe: '5m' }).sort({ timestamp: 1 }).lean();
    assert.equal(doc.volume, 12.5, 'real provider volume must be preserved exactly');
  });

  await t.test('Test 10 — a malformed candle from the provider is rejected, not persisted', async () => {
    const SYMBOL = 'P12_MALFORMED';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake = new FakeHistoricalProvider({
      candles: [
        { timestamp: endTs - MIN5, open: 100, high: 50, low: 200, close: 103, volume: 1 },
        { timestamp: endTs, open: 100, high: 105, low: 98, close: 103, volume: 1 },
      ],
    });
    marketData._setProviderForTesting(fake);

    const result = await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });
    assert.equal(result.accepted, 1, 'the malformed candle must be rejected; only the valid one is accepted');

    const badDoc = await Candle.findOne({ symbol: SYMBOL, timeframe: '5m', timestamp: endTs - MIN5 }).lean();
    assert.equal(badDoc, null);
  });

  await t.test('Test 11 — provider failure never fabricates data and never throws', async () => {
    const SYMBOL = 'P12_OUTAGE';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5;
    const seedDocs = [];
    for (let i = 0; i < 10; i += 1) {
      seedDocs.push({
        symbol: SYMBOL, timeframe: '5m', timestamp: endTs - (10 - i) * MIN5,
        open: 100, high: 102, low: 98, close: 101, volume: null, closed: true, source: 'delta',
      });
    }
    await Candle.insertMany(seedDocs);

    const fake = new FakeHistoricalProvider({ shouldFail: true, failMessage: 'network timeout contacting Delta' });
    marketData._setProviderForTesting(fake);

    const result = await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });
    assert.equal(result.backfilled, false);
    assert.match(result.error, /network timeout/);
    assert.equal(result.mongoAfter, 10, 'real count must remain honest — never fabricated up to target');
  });

  await t.test('Test 12 — partial Delta history (insufficient even after backfill) is reported honestly', async () => {
    const SYMBOL = 'P12_PARTIAL_RESULT';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const seedDocs = [];
    for (let i = 0; i < 10; i += 1) {
      seedDocs.push({
        symbol: SYMBOL, timeframe: '5m', timestamp: endTs - 100 * MIN5 + i * MIN5,
        open: 100, high: 102, low: 98, close: 101, volume: null, closed: true, source: 'delta',
      });
    }
    await Candle.insertMany(seedDocs);

    const fake = new FakeHistoricalProvider({ count: 25, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const result = await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });
    assert.ok(result.mongoAfter < 60, 'must never fake the remaining candles to reach target');
  });

  await t.test('Test 13/14 — timeframe and symbol isolation: backfilling one pair never touches another', async () => {
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake5m = new FakeHistoricalProvider({ count: 65, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake5m);
    await candleBackfillService.ensureSufficientHistory({ symbol: 'P12_ISOLATE', timeframe: '5m', targetCount: 60 });

    const count15m = await Candle.countDocuments({ symbol: 'P12_ISOLATE', timeframe: '15m' });
    assert.equal(count15m, 0, 'backfilling 5m must not create any 15m documents');

    const countOtherSymbol = await Candle.countDocuments({ symbol: 'P12_ISOLATE_OTHER', timeframe: '5m' });
    assert.equal(countOtherSymbol, 0, 'backfilling one symbol must not create documents for another symbol');
  });

  await t.test('Test 15/16 — concurrent ensureSufficientHistory calls for the same pair are coalesced (no duplicate work)', async () => {
    const SYMBOL = 'P12_CONCURRENT';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake = new FakeHistoricalProvider({ count: 70, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const [r1, r2] = await Promise.all([
      candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 }),
      candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 }),
    ]);

    assert.equal(fake.calls.length, 1, 'two concurrent requests for the identical pair must coalesce into one provider call');
    assert.deepEqual(r1, r2, 'both callers receive the same coalesced result');

    const distinct = await Candle.aggregate([
      { $match: { symbol: SYMBOL, timeframe: '5m' } },
      { $group: { _id: '$timestamp', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    assert.equal(distinct.length, 0, 'no duplicate documents from the coalesced concurrent calls');
  });
});

// ---------------------------------------------------------------------
// DB-gated: full BotManager.startInstance integration (backfill -> hydrate -> READY).
// ---------------------------------------------------------------------

test('Part 12 — BotManager integration: backfill brings a cold-start bot to READY', { skip: () => !dbAvailable && 'MongoDB not reachable' }, async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not reachable'); return; }

  const StrategyEvent = require('../models/StrategyEvent');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const botManager = require('../services/botManager/BotManager');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  function createMockIo() {
    const emitted = [];
    return { emitted, to(room) { return { emit(event, payload) { emitted.push({ room, event, payload }); } }; } };
  }

  const io = createMockIo();
  botManager.attachSocketServer(io);
  await botManager.discoverModels();

  const user = await User.create({ username: `part12_user_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  await t.test('Test 1/6/7 — cold start (0 Mongo candles) backfills to READY without historical execution', async () => {
    const SYMBOL = 'P12_BOT_COLDSTART';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake = new FakeHistoricalProvider({ count: 70, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const instance = await botManager.createInstance({
      name: 'part12_coldstart', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL,
      environment: 'PAPER', parameters: { timeframe: '5m' }, capitalAllocation: 10000, leverage: 2,
    });

    await botManager.startInstance(instance.instanceId);
    const readiness = botManager.getReadiness(instance.instanceId);
    assert.equal(readiness.state, 'READY', 'backfilled history must bring a cold-start bot to READY without waiting hours');
    assert.ok(readiness.have >= 50);

    const ruleMatched = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'RULE_MATCHED' }).lean();
    const decisions = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).lean();
    assert.equal(ruleMatched.length, 0, 'backfilled history must never generate a RULE_MATCHED (trade) event');
    assert.equal(decisions.length, 0, 'backfilled history must never generate a live DECISION event');

    await botManager.stopInstance(instance.instanceId);

    const count = await Candle.countDocuments({ symbol: SYMBOL, timeframe: '5m', closed: true });
    assert.ok(count >= 60);
  });

  await t.test('Test 17 — restart with already-sufficient Mongo history makes zero further Delta calls and is READY immediately', async () => {
    const SYMBOL = 'P12_BOT_RESTART';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake = new FakeHistoricalProvider({ count: 70, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const instance = await botManager.createInstance({
      name: 'part12_restart', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL,
      environment: 'PAPER', parameters: { timeframe: '5m' }, capitalAllocation: 10000, leverage: 2,
    });

    await botManager.startInstance(instance.instanceId);
    const callsAfterFirstStart = fake.calls.length;
    assert.ok(callsAfterFirstStart >= 1, 'the cold start must have triggered at least one real backfill call');

    await botManager.restartInstance(instance.instanceId);
    assert.equal(fake.calls.length, callsAfterFirstStart, 'restart with sufficient Mongo history must not trigger another Delta historical request');

    const readiness = botManager.getReadiness(instance.instanceId);
    assert.equal(readiness.state, 'READY');

    await botManager.stopInstance(instance.instanceId);
  });

  await t.test('Test 11 (BotManager level) — Delta outage during a cold start degrades to honest INSUFFICIENT_HISTORY, never crashes', async () => {
    const SYMBOL = 'P12_BOT_OUTAGE';
    const fake = new FakeHistoricalProvider({ shouldFail: true });
    marketData._setProviderForTesting(fake);

    const instance = await botManager.createInstance({
      name: 'part12_outage', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL,
      environment: 'PAPER', parameters: { timeframe: '5m' }, capitalAllocation: 10000, leverage: 2,
    });

    await botManager.startInstance(instance.instanceId);
    const readiness = botManager.getReadiness(instance.instanceId);
    assert.equal(readiness.state, 'INSUFFICIENT_HISTORY');
    assert.equal(readiness.have, 0, 'no fabricated candles when Delta is unreachable');

    await botManager.stopInstance(instance.instanceId);
  });
});
