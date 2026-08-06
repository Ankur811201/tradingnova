'use strict';

/**
 * Part 12.1 — tests for USABLE RECENT HISTORY:
 *
 *   services/marketData/historyContinuity.js  (pure, unit-tested directly)
 *   services/marketData/usableHistoryQuery.js (Mongo-gated)
 *   CandleBackfillService.ensureSufficientHistory (gap/staleness-aware)
 *   BotManager._hydrateInstance (hydrates only the contiguous window)
 *
 * Convention matches tests/part12.historicalBackfill.test.js: pure logic is
 * tested with no MongoDB needed; everything touching the canonical Candle
 * collection is gated behind a reachability check.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { computeUsableHistory } = require('../services/marketData/historyContinuity');
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
    console.log(`[part12.1 tests] Skipping DB-backed tests: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

function makeCandle(ts, overrides = {}) {
  return Object.assign(
    { timestamp: ts, open: 100, high: 102, low: 98, close: 101, volume: 1 },
    overrides
  );
}

/** Builds `count` contiguous 5m candles ending at (and including) endTs. */
function buildContiguous(count, endTs, tfMs = MIN5) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(makeCandle(endTs - (count - 1 - i) * tfMs));
  }
  return out;
}

// ---------------------------------------------------------------------
// Pure unit tests — historyContinuity.computeUsableHistory
// ---------------------------------------------------------------------

test('Part 12.1 TEST A — 60 recent contiguous candles are sufficient, no gap', () => {
  const now = Math.floor(Date.now() / MIN5) * MIN5; // aligned "now"
  const latestClosed = now - MIN5; // most recently closed bucket
  const candles = buildContiguous(60, latestClosed);
  const result = computeUsableHistory({ candles, tfMs: MIN5, targetCount: 60, now });
  assert.equal(result.usable, 60);
  assert.equal(result.sufficient, true);
  assert.equal(result.stale, false);
});

test('Part 12.1 TEST B — 100 total candles but latest contiguous run is only 20: backfill required', () => {
  const now = Math.floor(Date.now() / MIN5) * MIN5;
  const latestClosed = now - MIN5;
  const recentRun = buildContiguous(20, latestClosed); // recent, contiguous
  const oldRun = buildContiguous(80, latestClosed - 20 * MIN5 - 500 * MIN5); // older, disjoint block far in the past
  const candles = [...oldRun, ...recentRun];
  const result = computeUsableHistory({ candles, tfMs: MIN5, targetCount: 60, now });
  assert.equal(result.totalDocs, 100);
  assert.equal(result.usable, 20, 'older unrelated candles across the gap must not count');
  assert.equal(result.sufficient, false);
});

test('Part 12.1 TEST C — 60 contiguous candles from "yesterday" while current time is "today": insufficient (stale)', () => {
  const now = Date.now();
  const yesterdayEnd = Math.floor((now - 24 * 60 * 60 * 1000) / MIN5) * MIN5;
  const candles = buildContiguous(60, yesterdayEnd);
  const result = computeUsableHistory({ candles, tfMs: MIN5, targetCount: 60, now });
  assert.equal(result.stale, true);
  assert.equal(result.usable, 0, 'stale history must not be usable as current context');
  assert.equal(result.sufficient, false);
  assert.equal(result.latestContiguousCount, 60, 'diagnostic count still reflects the real contiguous run length');
});

test('Part 12.1 TEST D — 59 contiguous recent candles: still insufficient for target 60', () => {
  const now = Math.floor(Date.now() / MIN5) * MIN5;
  const latestClosed = now - MIN5;
  const candles = buildContiguous(59, latestClosed);
  const result = computeUsableHistory({ candles, tfMs: MIN5, targetCount: 60, now });
  assert.equal(result.usable, 59);
  assert.equal(result.sufficient, false);
});

test('Part 12.1 TEST I — duplicate timestamps cannot inflate usable count', () => {
  const now = Math.floor(Date.now() / MIN5) * MIN5;
  const latestClosed = now - MIN5;
  const candles = buildContiguous(60, latestClosed);
  // Duplicate every timestamp in the run.
  const withDupes = [...candles, ...candles.map((c) => Object.assign({}, c))];
  const result = computeUsableHistory({ candles: withDupes, tfMs: MIN5, targetCount: 60, now });
  assert.equal(result.usable, 60, 'duplicates must collapse to one candle per timestamp, not inflate the count');
});

test('Part 12.1 TEST J — misaligned timestamps cannot make history sufficient', () => {
  const now = Math.floor(Date.now() / MIN5) * MIN5;
  const latestClosed = now - MIN5;
  const candles = buildContiguous(59, latestClosed);
  // A 60th candle that is NOT aligned to a 5m bucket boundary.
  candles.push(makeCandle(latestClosed + MIN5 - 37));
  const result = computeUsableHistory({ candles, tfMs: MIN5, targetCount: 60, now });
  assert.equal(result.usable, 59, 'the misaligned candle must be rejected, not counted');
  assert.equal(result.sufficient, false);
});

test('Part 12.1 — a mid-run gap correctly truncates the contiguous count', () => {
  const now = Math.floor(Date.now() / MIN5) * MIN5;
  const latestClosed = now - MIN5;
  const candles = [
    makeCandle(latestClosed - 4 * MIN5),
    makeCandle(latestClosed - 3 * MIN5),
    // gap: latestClosed - 2*MIN5 missing
    makeCandle(latestClosed - MIN5),
    makeCandle(latestClosed),
  ];
  const result = computeUsableHistory({ candles, tfMs: MIN5, targetCount: 4, now });
  assert.equal(result.usable, 2, 'only the run touching the newest candle counts');
  assert.equal(result.totalDocs, 4);
});

test('Part 12.1 — current forming candle excluded (never part of usable closed history)', () => {
  // historyContinuity only ever receives closed candles from its callers
  // (CandleBackfillService/BotManager both query `closed: true`); this
  // test documents that guarantee holds even if a forming-shaped record
  // were accidentally included — it is just data to the pure function,
  // so the real guarantee lives in the closed:true query. Verify that
  // query contract explicitly here as a regression guard.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../services/marketData/usableHistoryQuery.js'), 'utf8');
  assert.match(src, /closed:\s*true/, 'usableHistoryQuery must only ever query closed candles');
});

// ---------------------------------------------------------------------
// DB-gated: CandleBackfillService against the real Candle collection.
// ---------------------------------------------------------------------

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

test('Part 12.1 — CandleBackfillService gap/staleness awareness', { skip: () => !dbAvailable && 'MongoDB not reachable' }, async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not reachable'); return; }

  const Candle = require('../models/Candle');

  await t.test('TEST E/G — 100 stored total but only a 20-candle recent run: backfill fills the gap, then sufficient', async () => {
    const SYMBOL = 'P12_1_GAP_REPAIR';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;

    // Old disjoint block, far in the past — must not count toward readiness.
    const oldDocs = [];
    for (let i = 0; i < 80; i += 1) {
      oldDocs.push({
        symbol: SYMBOL, timeframe: '5m', timestamp: endTs - 1000 * MIN5 - (80 - i) * MIN5,
        open: 100, high: 102, low: 98, close: 101, volume: null, closed: true, source: 'delta',
      });
    }
    // Recent but short run — only 20 candles, well short of target 60.
    const recentDocs = [];
    for (let i = 0; i < 20; i += 1) {
      recentDocs.push({
        symbol: SYMBOL, timeframe: '5m', timestamp: endTs - (20 - i) * MIN5,
        open: 100, high: 102, low: 98, close: 101, volume: null, closed: true, source: 'delta',
      });
    }
    await Candle.insertMany([...oldDocs, ...recentDocs]);

    // Total documents (100) look sufficient under the OLD countDocuments
    // logic, but usable recent contiguous history is only 20 — this must
    // trigger a real backfill.
    const fake = new FakeHistoricalProvider({ count: 70, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const result = await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });
    assert.equal(result.backfilled, true, 'gap-riddled total-100 history must still trigger backfill');
    assert.ok(fake.calls.length >= 1);
    assert.ok(result.mongoAfter >= 60, `expected usable >= 60 after backfill, got ${result.mongoAfter}`);
  });

  await t.test('TEST H — provider cannot repair the gap: remains honestly insufficient', async () => {
    const SYMBOL = 'P12_1_GAP_UNREPAIRABLE';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;

    const recentDocs = [];
    for (let i = 0; i < 10; i += 1) {
      recentDocs.push({
        symbol: SYMBOL, timeframe: '5m', timestamp: endTs - (10 - i) * MIN5,
        open: 100, high: 102, low: 98, close: 101, volume: null, closed: true, source: 'delta',
      });
    }
    await Candle.insertMany(recentDocs);

    // Provider only returns a handful more — still short of target.
    const fake = new FakeHistoricalProvider({ count: 15, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const result = await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });
    assert.equal(result.backfilled, true);
    assert.ok(result.mongoAfter < 60, 'must remain honestly insufficient, never padded to target');
  });

  await t.test('TEST — stale history (yesterday) triggers backfill even though raw count is already >= target', async () => {
    const SYMBOL = 'P12_1_STALE';
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    const staleEnd = Math.floor(yesterday / MIN5) * MIN5;

    const staleDocs = [];
    for (let i = 0; i < 80; i += 1) {
      staleDocs.push({
        symbol: SYMBOL, timeframe: '5m', timestamp: staleEnd - (80 - i) * MIN5,
        open: 100, high: 102, low: 98, close: 101, volume: null, closed: true, source: 'delta',
      });
    }
    await Candle.insertMany(staleDocs);

    const nowEndTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake = new FakeHistoricalProvider({ count: 70, endTs: nowEndTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const result = await candleBackfillService.ensureSufficientHistory({ symbol: SYMBOL, timeframe: '5m', targetCount: 60 });
    assert.equal(result.backfilled, true, '80 stale (yesterday) candles must not be treated as already sufficient');
    assert.ok(fake.calls.length >= 1);
    assert.ok(result.mongoAfter >= 60, 'after backfill, usable history should now reflect current candles');
  });
});

// ---------------------------------------------------------------------
// DB-gated: BotManager integration — hydration only uses the contiguous window.
// ---------------------------------------------------------------------

test('Part 12.1 — BotManager hydrates only the usable contiguous window', { skip: () => !dbAvailable && 'MongoDB not reachable' }, async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not reachable'); return; }

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

  const user = await User.create({ username: `part12_1_user_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  await t.test('TEST C/17 — old contiguous Mongo history + current time: bot backfills instead of falsely reporting READY', async () => {
    const SYMBOL = 'P12_1_BOT_OLD_HISTORY';
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    const staleEnd = Math.floor(yesterday / MIN5) * MIN5;

    const staleDocs = [];
    for (let i = 0; i < 100; i += 1) {
      staleDocs.push({
        symbol: SYMBOL, timeframe: '5m', timestamp: staleEnd - (100 - i) * MIN5,
        open: 100, high: 102, low: 98, close: 101, volume: null, closed: true, source: 'delta',
      });
    }
    await Candle.insertMany(staleDocs);

    const nowEndTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake = new FakeHistoricalProvider({ count: 70, endTs: nowEndTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const instance = await botManager.createInstance({
      name: 'part12_1_old_history', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL,
      environment: 'PAPER', parameters: { timeframe: '5m' }, capitalAllocation: 10000, leverage: 2,
    });

    await botManager.startInstance(instance.instanceId);
    assert.ok(fake.calls.length >= 1, '100 stale candles must not skip backfill');

    const readiness = botManager.getReadiness(instance.instanceId);
    assert.equal(readiness.state, 'READY', 'after real backfill, the bot should reach READY on current candles');

    await botManager.stopInstance(instance.instanceId);
  });

  await t.test('TEST N — restart with sufficient CURRENT usable Mongo history makes zero further Delta calls', async () => {
    const SYMBOL = 'P12_1_BOT_RESTART_CURRENT';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake = new FakeHistoricalProvider({ count: 70, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const instance = await botManager.createInstance({
      name: 'part12_1_restart_current', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL,
      environment: 'PAPER', parameters: { timeframe: '5m' }, capitalAllocation: 10000, leverage: 2,
    });

    await botManager.startInstance(instance.instanceId);
    const callsAfterFirstStart = fake.calls.length;
    assert.ok(callsAfterFirstStart >= 1);

    await botManager.restartInstance(instance.instanceId);
    assert.equal(fake.calls.length, callsAfterFirstStart, 'restart with current usable Mongo history must not call Delta again');

    const readiness = botManager.getReadiness(instance.instanceId);
    assert.equal(readiness.state, 'READY');

    await botManager.stopInstance(instance.instanceId);
  });

  await t.test('TEST L — backfill/hydration creates zero TradeCommands/Trades/Positions/markers', async () => {
    const StrategyEvent = require('../models/StrategyEvent');
    const Trade = require('../models/Trade');
    const Position = require('../models/Position');

    const SYMBOL = 'P12_1_BOT_NO_EXECUTION';
    const endTs = Math.floor(Date.now() / MIN5) * MIN5 - MIN5;
    const fake = new FakeHistoricalProvider({ count: 70, endTs, tfMs: MIN5 });
    marketData._setProviderForTesting(fake);

    const instance = await botManager.createInstance({
      name: 'part12_1_no_execution', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL,
      environment: 'PAPER', parameters: { timeframe: '5m' }, capitalAllocation: 10000, leverage: 2,
    });

    await botManager.startInstance(instance.instanceId);

    const ruleMatched = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'RULE_MATCHED' }).lean();
    const decisions = await StrategyEvent.find({ instanceId: instance.instanceId, eventType: 'DECISION' }).lean();
    const trades = await Trade.find({ instanceId: instance.instanceId }).lean();
    const positions = await Position.find({ instanceId: instance.instanceId }).lean();

    assert.equal(ruleMatched.length, 0);
    assert.equal(decisions.length, 0);
    assert.equal(trades.length, 0);
    assert.equal(positions.length, 0);

    await botManager.stopInstance(instance.instanceId);
  });
});
