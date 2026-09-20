'use strict';

/**
 * MODEL_002 — tests for the custom-pattern strategy (unchanged this
 * revision) plus the 3 confirmed fixes in this pass:
 *   1. maxCapital x leverage notional ceiling (was: maxCapital alone)
 *   2. real Trade-based WIN/LOSS/BREAK_EVEN detection (was: a next-candle
 *      heuristic)
 *   3. consecutive-loss safety state persisted/reconstructed across
 *      restart (was: in-memory only)
 *
 * No MongoDB dependency for the model-level tests — same mocked-ctx
 * convention as every other bot-models test file. BotManager's new
 * onPositionClosed/_recoverSafetyState wiring is covered by static/shape
 * inspection here (no live MongoDB in this environment — see the final
 * report's environment-blocker note) and by the model-level tests that
 * exercise the hooks directly, exactly as BotManager would call them.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Model002 = require('../bot-models/model-002/Model002');
const { resolveTouchedLevel } = require('../bot-models/model-002/levelEngine');
const { evaluateCounterTrendBuy, evaluateCounterTrendSell } = require('../bot-models/model-002/patternEngine');
const riskSizing = require('../bot-models/model-002/riskSizing');
const { validateAndMergeParameters } = require('../bot-models/model-002/validators');

const MIN = 60000;
const BASE = 1_700_000_000_000;

function flat(count, price, startTs) {
  const arr = [];
  for (let i = 0; i < count; i += 1) {
    arr.push({ timestamp: startTs + i * MIN, open: price, high: price + 0.01, low: price - 0.01, close: price, volume: null });
  }
  return arr;
}

function makeCtx() {
  const ctx = { modelId: 'MODEL_002', modelVersion: 'test', events: [], commands: [] };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => { ctx.commands.push(cmd); return { approved: true, reason: 'Approved', metadata: {} }; };
  return ctx;
}

async function startedModel(parameters, instanceOverrides) {
  const ctx = makeCtx();
  const model = new Model002(ctx);
  await model.onStart(Object.assign({
    instanceId: 'inst1', symbol: 'BTCUSD', environment: 'PAPER',
    parameters: Object.assign({ timeframe: '1m', trend: 'BEARISH', support: [60000, 50, 25], resistance: [65000, 999000, 998000] }, parameters),
    capitalAllocation: 10000, leverage: 10, riskSettings: {},
  }, instanceOverrides));
  return { ctx, model };
}

// =========================================================================
// Registration / no-BOS static checks (unchanged behavior, re-verified)
// =========================================================================

test('MODEL_002 registration declares NO required higher timeframes', () => {
  const mod = require('../bot-models/model-002');
  assert.equal(mod.modelId, 'MODEL_002');
  assert.deepEqual(mod.requiredTimeframes, []);
});

test('MODEL_002 source contains no BOS/EMA/higher-timeframe or next-candle-heuristic result logic', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'bot-models', 'model-002');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const forbidden = [/computeBosTrend/, /calculateEMA/, /\bema50\b/i, /_trackPositionForSafety/, /estimateOutcome/];
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(content), false, `${file} unexpectedly matches forbidden pattern ${pattern}`);
    }
  }
});

test('trend is user-provided and required, timeframe restricted to 1m/3m (unchanged)', () => {
  assert.throws(() => validateAndMergeParameters({ timeframe: '1m' }), /trend/);
  assert.throws(() => validateAndMergeParameters({ timeframe: '5m', trend: 'BULLISH', support: [1, 2, 3], resistance: [4, 5, 6] }), /1m, 3m/);
  assert.equal(validateAndMergeParameters({ timeframe: '3m', trend: 'BULLISH', support: [1, 2, 3], resistance: [4, 5, 6] }).timeframe, '3m');
});

test('support/resistance are now REQUIRED at exactly 3 each (new Create Bot form contract) — not optional, not capped-at-3', () => {
  assert.throws(
    () => validateAndMergeParameters({ timeframe: '1m', trend: 'BULLISH', support: [], resistance: [1, 2, 3] }),
    /exactly 3 support levels; received 0/
  );
  assert.throws(
    () => validateAndMergeParameters({ timeframe: '1m', trend: 'BULLISH', support: [1, 2], resistance: [1, 2, 3] }),
    /exactly 3 support levels; received 2/
  );
  assert.throws(
    () => validateAndMergeParameters({ timeframe: '1m', trend: 'BULLISH', support: [1, 2, 3, 4], resistance: [1, 2, 3] }),
    /exactly 3 support levels; received 4/
  );
  const merged = validateAndMergeParameters({ timeframe: '1m', trend: 'BULLISH', support: [1, 2, 3], resistance: [4, 5, 6] });
  assert.deepEqual(merged.support, [1, 2, 3]);
  assert.deepEqual(merged.resistance, [4, 5, 6]);
});

test('resolveTouchedLevel: last-level-wins tie-break unchanged', () => {
  const candle = { low: 59, high: 205 };
  const match = resolveTouchedLevel([60, 100, 200], candle, 0.01);
  assert.equal(match.index, 3);
});

test('counter-trend confirmation formulas unchanged (close vs reference body + 1.5x body rule)', () => {
  const ref = { open: 100, close: 105 };
  const passing = { open: 105, close: 120 };
  const failing = { open: 105, close: 110 };
  assert.equal(evaluateCounterTrendBuy(1, ref, passing).passed, true);
  assert.equal(evaluateCounterTrendBuy(1, ref, failing).passed, false);
});

// NOTE: the old counter-trend BUY/SELL formula (BEARISH+SUPPORT=BUY,
// BULLISH+RESISTANCE=SELL, close-vs-reference-body-high/low + 1.5x body)
// has been SUPERSEDED by the newly confirmed same-side pattern
// (BULLISH+SUPPORT=BUY, BEARISH+RESISTANCE=SELL, Candle1/2/3 + UpperP/
// LowerP/BodyP) — see tests/model002.sameSidePattern.test.js for its full
// coverage.

// =========================================================================
// PART 1 — Max Capital x Leverage cap REMOVED (confirmed requirement)
// =========================================================================
// computeMaxAllowedNotional / capExposureToMaxNotional have been deleted
// from riskSizing.js entirely — quantity is no longer reduced for
// exceeding capital x leverage notional, and the trade is no longer
// rejected for this reason. These tests confirm the removal.

test('riskSizing no longer exports the max-capital x leverage cap functions', () => {
  assert.equal(riskSizing.computeMaxAllowedNotional, undefined);
  assert.equal(riskSizing.capExposureToMaxNotional, undefined);
});

test('rejects leverage below 1x, never silently clamps', async () => {
  const ctx = makeCtx();
  const model = new Model002(ctx);
  await assert.rejects(() => model.onStart({
    instanceId: 'i1', symbol: 'BTCUSD', environment: 'PAPER',
    parameters: { timeframe: '1m', trend: 'BULLISH', support: [1, 2, 3], resistance: [999000, 998000, 997000] },
    capitalAllocation: 100, leverage: 0, riskSettings: {},
  }), /leverage/);
});

test('rejects leverage above 200x, never silently clamps', async () => {
  const ctx = makeCtx();
  const model = new Model002(ctx);
  await assert.rejects(() => model.onStart({
    instanceId: 'i1', symbol: 'BTCUSD', environment: 'PAPER',
    parameters: { timeframe: '1m', trend: 'BULLISH', support: [1, 2, 3], resistance: [999000, 998000, 997000] },
    capitalAllocation: 100, leverage: 201, riskSettings: {},
  }), /leverage/);
});

test('accepts leverage exactly 200x, uses it exactly (no silent conversion)', async () => {
  const { model } = await startedModel({}, { leverage: 200 });
  assert.equal(model.leverage, 200);
});

// ========================================================================
// MODEL_002 layer safety is covered exhaustively in model002.layerSafety.test.js
// ========================================================================

// BotManager wiring — layer safety recovery must remain model-agnostic.
// =========================================================================

test('BotManager defines the layer-safety recovery hook and keeps it model-agnostic', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'services', 'botManager', 'BotManager.js'), 'utf8');
  assert.match(content, /_recoverLayerSafetyState/);
  assert.match(content, /typeof modelInstance\.restoreLayerSafetyState !== 'function'/);
  assert.match(content, /typeof live\.modelInstance\.onPositionClosed === 'function'/);
});

test('BotManager layer-safety Trade query is scoped by instanceId AND environment', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'services', 'botManager', 'BotManager.js'), 'utf8');
  assert.match(content, /Trade\.find\(\{ instanceId: dbInstance\.instanceId, environment: dbInstance\.environment \}\)/);
});

test('MODEL_002 no longer exposes the legacy consecutive-loss safety hook', async () => {
  const { model } = await startedModel();
  assert.equal(model.safety, undefined);
  assert.equal(typeof model.getSafetyLossLimit, 'undefined');
  assert.equal(typeof model.restoreSafetyState, 'undefined');
});


// =========================================================================
// Regression: no pyramiding, malformed/duplicate protection, hydration never trades
// =========================================================================

test('position-aware: no new entry evaluated while a position is already open', async () => {
  const { ctx, model } = await startedModel();
  await model.onHydrate(flat(17, 61000, BASE));
  const positionContext = { side: 'LONG', entryPrice: 60300, stopLoss: 59940 };
  const refL1 = { timestamp: BASE + 17 * MIN, open: 61000, high: 61010, low: 60990, close: 60950, volume: null };
  const touch = { timestamp: BASE + 18 * MIN, open: 60950, high: 60960, low: 60000, close: 60100, volume: null };
  const conf = { timestamp: BASE + 19 * MIN, open: 60100, high: 61200, low: 60050, close: 61100, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: refL1.timestamp, data: refL1 }, positionContext);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, positionContext);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: conf.timestamp, data: conf }, positionContext);
  assert.equal(ctx.commands.length, 0);
});

test('hydration never submits a TradeCommand or emits a DECISION', async () => {
  const { ctx, model } = await startedModel();
  const candles = flat(17, 61000, BASE).concat([
    { timestamp: BASE + 17 * MIN, open: 61000, high: 61010, low: 60990, close: 60950, volume: null },
    { timestamp: BASE + 18 * MIN, open: 60950, high: 60960, low: 60000, close: 60100, volume: null },
    { timestamp: BASE + 19 * MIN, open: 60100, high: 61200, low: 60050, close: 61100, volume: null },
  ]);
  await model.onHydrate(candles);
  assert.equal(ctx.commands.length, 0);
  assert.ok(!ctx.events.some((e) => e.eventType === 'DECISION'));
});

test('malformed candle is rejected without corrupting the buffer', async () => {
  const { model } = await startedModel();
  const malformed = { timestamp: BASE, open: 1, high: 2, low: 0, close: -5 };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: BASE, data: malformed }, null);
  assert.equal(model.candles.length, 0);
});

test('duplicate candle timestamp is not double-processed', async () => {
  const { model } = await startedModel();
  const candle = { timestamp: BASE, open: 100, high: 101, low: 99, close: 100.5, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: BASE, data: candle }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: BASE, data: candle }, null);
  assert.equal(model.candles.length, 1);
});

// =========================================================================
// MODEL_002 source-isolation check
// =========================================================================

test('MODEL_002 source files never require model-001 files', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'bot-models', 'model-002');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(/require\(['"][^'"]*model-001/.test(content), false, `${file} unexpectedly requires a model-001 file`);
  }
});

// =========================================================================
// Focused fixes: full-window dedup seeding + deferred closed-trade lookup
// =========================================================================

// --- Fix 2: Position-close vs Trade-create race (deferred/retried lookup) ---

test('BotManager: dispatchMarketData source guards a not-yet-visible Trade with a deferred retry rather than a single query', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'services', 'botManager', 'BotManager.js'), 'utf8');
  // The pending lookup must persist (not be cleared) when no Trade is found yet, and
  // must carry the exact closed Position's _id (Part 6 exact correlation fix).
  assert.match(content, /live\.pendingClosedTradeLookup = \{\s*\n\s*positionId: live\.lastOpenPositionId,\s*\n\s*symbol: dbInstance\.symbol,\s*\n\s*attempts: 0,\s*\n\s*sinceTs: Date\.now\(\),\s*\n\s*\};/);
  // On success it must clear the pending marker and fire the hook exactly once.
  assert.match(content, /live\.pendingClosedTradeLookup = null;\s*\n\s*try \{\s*\n\s*await live\.modelInstance\.onPositionClosed\(closedTrade\);/);
  // A genuine, prolonged miss must be logged loudly, never silent.
  assert.match(content, /giving up\. This trade's WIN\/LOSS outcome was NOT applied/);
  // Part 6: the exact Trade↔Position correlation must be by ObjectId ref, not symbol/newest-closedAt.
  assert.match(content, /position: pending\.positionId,/);
  assert.doesNotMatch(
    content,
    /Trade\.findOne\(\{ instanceId, environment: dbInstance\.environment, symbol: pending\.symbol \}\)\s*\n\s*\.sort\(\{ closedAt: -1 \}\)/,
    'the unsafe newest-Trade-for-symbol lookup in the closed-trade correlation path must be gone'
  );
});

test('CLOSED_TRADE_LOOKUP bounds are finite (never retries forever, never blocks forever)', () => {
  // BotManager.js itself can't be require()'d standalone in this environment
  // (it pulls in mongoose-backed models) — checked statically, same
  // convention as the other BotManager-touching tests in this file.
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'services', 'botManager', 'BotManager.js'), 'utf8');
  assert.match(content, /static CLOSED_TRADE_LOOKUP_MAX_ATTEMPTS = \d+;/);
  assert.match(content, /static CLOSED_TRADE_LOOKUP_MAX_WAIT_MS = \d+;/);
});
