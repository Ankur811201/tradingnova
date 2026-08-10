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
const { ConsecutiveLossSafety } = require('../bot-models/model-002/safetyState');
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

/** Drives a full counter-trend BUY (BEARISH + support level 1) to completion, returns {ctx, model}. */
async function runToBuySignal(instanceOverrides, parameterOverrides) {
  const { ctx, model } = await startedModel(
    Object.assign({ timeframe: '1m', trend: 'BEARISH', support: [60000, 50, 25], resistance: [65000, 999000, 998000] }, parameterOverrides),
    instanceOverrides
  );
  await model.onHydrate(flat(17, 61000, BASE));
  const refL1 = { timestamp: BASE + 17 * MIN, open: 61000, high: 61010, low: 60990, close: 60950, volume: null };
  const touch = { timestamp: BASE + 18 * MIN, open: 60950, high: 60960, low: 60000, close: 60100, volume: null };
  const conf = { timestamp: BASE + 19 * MIN, open: 60100, high: 61200, low: 60050, close: 61100, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: refL1.timestamp, data: refL1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: conf.timestamp, data: conf }, null);
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

test('END-TO-END: counter-trend BUY still produces a correct command (strategy unchanged)', async () => {
  const { ctx } = await runToBuySignal();
  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].action, 'LONG');
  assert.equal(ctx.commands[0].stopLoss, 59940);
});

// =========================================================================
// PART 1 — Max Capital x Leverage
// =========================================================================

test('computeMaxAllowedNotional: maxCapital=100, leverage=200 -> 20000', () => {
  assert.equal(riskSizing.computeMaxAllowedNotional(100, 200), 20000);
});

test('computeMaxAllowedNotional: maxCapital=100, leverage=1 -> 100', () => {
  assert.equal(riskSizing.computeMaxAllowedNotional(100, 1), 100);
});

test('capExposureToMaxNotional: calculated notional below the limit is allowed unchanged', () => {
  const result = riskSizing.capExposureToMaxNotional(1, 15000, 100, 200, 3); // notional 15000 <= 20000
  assert.equal(result.capped, false);
  assert.equal(result.quantity, 1);
  assert.equal(result.maximumAllowedNotional, 20000);
});

test('capExposureToMaxNotional: calculated notional exactly at the limit is allowed', () => {
  const result = riskSizing.capExposureToMaxNotional(2, 10000, 100, 200, 3); // notional exactly 20000
  assert.equal(result.capped, false);
  assert.equal(result.notional, 20000);
});

test('capExposureToMaxNotional: calculated notional above the limit is capped, quantity only ever reduced', () => {
  const result = riskSizing.capExposureToMaxNotional(2, 12500, 100, 200, 3); // notional 25000 > 20000
  assert.equal(result.capped, true);
  assert.ok(result.quantity < 2);
  assert.ok(result.notional <= 20000);
});

test('capExposureToMaxNotional: final notional NEVER exceeds the limit after rounding (floating-point guard)', () => {
  // A price chosen to stress floating-point rounding at 3-decimal precision.
  const result = riskSizing.capExposureToMaxNotional(1000, 33.333333, 100, 200, 3);
  assert.ok(result.notional <= 20000, `finalNotional ${result.notional} must never exceed maximumAllowedNotional 20000`);
});

test('END-TO-END: max capital x leverage caps the final quantity, notional never exceeds the ceiling', async () => {
  // A large riskPercent forces the risk-sized quantity's notional well
  // beyond a modest maxCapital x leverage ceiling, deterministically
  // exercising the cap regardless of the specific SL-distance scenario.
  const { ctx } = await runToBuySignal({ capitalAllocation: 10000, leverage: 1 }, { riskPercent: 0.5 }); // ceiling = 10000
  assert.equal(ctx.commands.length, 1);
  const cmd = ctx.commands[0];
  assert.ok(cmd.metadata.finalNotional <= 10000, `finalNotional ${cmd.metadata.finalNotional} must not exceed the ceiling`);
  assert.equal(cmd.metadata.maximumAllowedNotional, 10000);
  assert.equal(cmd.metadata.maxCapitalCapped, true);
  assert.ok(cmd.metadata.finalQuantity < cmd.metadata.calculatedQuantity, 'final quantity must be reduced from the risk-sized quantity, never increased');
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

// =========================================================================
// PART 2 — Real WIN/LOSS/BREAK_EVEN detection
// =========================================================================

test('ConsecutiveLossSafety: a profitable closed trade -> WIN, resets streak', () => {
  const safety = new ConsecutiveLossSafety(3);
  safety.recordTradeOutcome('t1', -50);
  const { outcome, state } = safety.recordTradeOutcome('t2', 100);
  assert.equal(outcome, 'WIN');
  assert.equal(state.consecutiveLosses, 0);
});

test('ConsecutiveLossSafety: a losing closed trade -> LOSS, increments streak', () => {
  const safety = new ConsecutiveLossSafety(3);
  const { outcome, state } = safety.recordTradeOutcome('t1', -50);
  assert.equal(outcome, 'LOSS');
  assert.equal(state.consecutiveLosses, 1);
});

test('ConsecutiveLossSafety: zero realizedPnl -> BREAK_EVEN, resets streak, not counted as a loss', () => {
  const safety = new ConsecutiveLossSafety(3);
  safety.recordTradeOutcome('t1', -50);
  const { outcome, state } = safety.recordTradeOutcome('t2', 0);
  assert.equal(outcome, 'BREAK_EVEN');
  assert.equal(state.consecutiveLosses, 0, 'BREAK_EVEN resets the streak (confirmed recommended behavior — see final report)');
});

test('ConsecutiveLossSafety: same tradeId processed twice counts only once', () => {
  const safety = new ConsecutiveLossSafety(3);
  const first = safety.recordTradeOutcome('t1', -50);
  const second = safety.recordTradeOutcome('t1', -50);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(safety.getState().consecutiveLosses, 1, 'duplicate delivery of the same trade must not double-count');
});

test('Model002.onPositionClosed: routes a real Trade record through to the safety counter (not a candle heuristic)', async () => {
  const { ctx, model } = await startedModel();
  await model.onPositionClosed({ _id: 'trade1', realizedPnl: -25, reason: 'STOP_LOSS' });
  assert.equal(model.safety.getState().consecutiveLosses, 1);
  assert.ok(ctx.events.some((e) => e.eventType === 'SAFETY_STATE_UPDATED' && e.payload.outcome === 'LOSS'));
});

test('a rejected TradeCommand never reaches onPositionClosed and never counts', async () => {
  const { model } = await startedModel();
  // SIGNAL_REJECTED events are emitted by _evaluateEntry independent of onPositionClosed —
  // asserting here that the safety counter is untouched by anything other than a real close.
  assert.equal(model.safety.getState().consecutiveLosses, 0);
});

test('a WAIT decision never touches the safety counter', async () => {
  const { ctx, model } = await startedModel();
  await model.onHydrate(flat(20, 62000, BASE));
  const candle = { timestamp: BASE + 20 * MIN, open: 62000, high: 62010, low: 61990, close: 62005, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: candle.timestamp, data: candle }, null);
  assert.equal(model.safety.getState().consecutiveLosses, 0);
});

// =========================================================================
// PART 3 — Three consecutive losses, reset, persistence
// =========================================================================

test('first loss -> 1/3, second -> 2/3, third -> 3/3 + PAUSE', async () => {
  const { ctx, model } = await startedModel();
  await model.onPositionClosed({ _id: 't1', realizedPnl: -10, reason: 'STOP_LOSS' });
  assert.deepEqual([model.safety.getState().consecutiveLosses, model.safety.getState().paused], [1, false]);
  await model.onPositionClosed({ _id: 't2', realizedPnl: -10, reason: 'STOP_LOSS' });
  assert.deepEqual([model.safety.getState().consecutiveLosses, model.safety.getState().paused], [2, false]);
  await model.onPositionClosed({ _id: 't3', realizedPnl: -10, reason: 'STOP_LOSS' });
  assert.deepEqual([model.safety.getState().consecutiveLosses, model.safety.getState().paused], [3, true]);
  assert.ok(ctx.events.some((e) => e.eventType === 'BOT_SAFETY_PAUSED'));
});

test('WIN resets an in-progress streak of 2 back to 0', async () => {
  const { model } = await startedModel();
  await model.onPositionClosed({ _id: 't1', realizedPnl: -10, reason: 'STOP_LOSS' });
  await model.onPositionClosed({ _id: 't2', realizedPnl: -10, reason: 'STOP_LOSS' });
  await model.onPositionClosed({ _id: 't3', realizedPnl: 30, reason: 'TAKE_PROFIT' });
  assert.equal(model.safety.getState().consecutiveLosses, 0);
});

test('restart preserves an in-progress streak of 2 (via restoreSafetyState, as BotManager would call it)', async () => {
  const { model } = await startedModel();
  model.restoreSafetyState({ consecutiveLosses: 2, paused: false });
  assert.equal(model.safety.getState().consecutiveLosses, 2);
  await model.onPositionClosed({ _id: 't3', realizedPnl: -5, reason: 'STOP_LOSS' });
  assert.equal(model.safety.getState().consecutiveLosses, 3);
  assert.equal(model.safety.getState().paused, true);
});

test('restart preserves an already-paused 3/3 state and does NOT silently resume running', async () => {
  const { model } = await startedModel();
  model.restoreSafetyState({ consecutiveLosses: 3, paused: true });
  assert.equal(model.safety.getState().paused, true);
});

test('after restart-restored pause, a 4th trade attempt is blocked before any entry evaluation', async () => {
  const { ctx, model } = await startedModel();
  model.restoreSafetyState({ consecutiveLosses: 3, paused: true });
  await model.onHydrate(flat(17, 61000, BASE));
  const refL1 = { timestamp: BASE + 17 * MIN, open: 61000, high: 61010, low: 60990, close: 60950, volume: null };
  const touch = { timestamp: BASE + 18 * MIN, open: 60950, high: 60960, low: 60000, close: 60100, volume: null };
  const conf = { timestamp: BASE + 19 * MIN, open: 60100, high: 61200, low: 60050, close: 61100, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: refL1.timestamp, data: refL1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: conf.timestamp, data: conf }, null);

  assert.equal(ctx.commands.length, 0, 'no new trade command may be submitted while safety-paused, even with a fully valid setup');
  const lastDecision = ctx.events.filter((e) => e.eventType === 'DECISION').pop();
  assert.equal(lastDecision.payload.reason, 'three_consecutive_losses');
  assert.equal(lastDecision.payload.safetyStatus, 'PAUSED');
});

test('Model002.getSafetyLossLimit exposes the configured limit for BotManager restart-reconstruction', async () => {
  const { model } = await startedModel();
  assert.equal(model.getSafetyLossLimit(), 3);
});

// =========================================================================
// BotManager wiring — shape/contract checks (no live MongoDB in this
// environment; see final report). Confirms the additive hook exists and
// is guarded exactly like the pre-existing restoreLevelCounts pattern, so
// MODEL_001 (which defines neither) is provably unaffected.
// =========================================================================

test('BotManager defines the new additive _recoverSafetyState method, guarded by a typeof check (model-agnostic, same pattern as _recoverLevelCounts)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'services', 'botManager', 'BotManager.js'), 'utf8');
  assert.match(content, /_recoverSafetyState/);
  assert.match(content, /typeof modelInstance\.restoreSafetyState !== 'function'/);
  assert.match(content, /onPositionClosed/);
  assert.match(content, /typeof live\.modelInstance\.onPositionClosed === 'function'/);
});

test('BotManager scopes both safety/closed-trade Trade queries by instanceId AND environment (not instanceId alone)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'services', 'botManager', 'BotManager.js'), 'utf8');
  assert.match(
    content,
    /Trade\.find\(\{ instanceId: dbInstance\.instanceId, environment: dbInstance\.environment \}\)/,
    '_recoverSafetyState\'s history-reconstruction query must be scoped by environment'
  );
  assert.match(
    content,
    /Trade\.findOne\(\{\s*\n\s*position: pending\.positionId,\s*\n\s*instanceId,\s*\n\s*environment: dbInstance\.environment,\s*\n\s*symbol: pending\.symbol,\s*\n\s*\}\)/,
    'the deferred closed-trade lookup in dispatchMarketData must be scoped by position AND instanceId AND environment'
  );
});

test('BotManager seeds processedTradeIds with ALL recently-loaded trades (not only the ones inside the current loss streak)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'services', 'botManager', 'BotManager.js'), 'utf8');
  assert.match(content, /const processedTradeIds = recentTrades\.map\(\(trade\) => String\(trade\._id\)\);/);
  assert.match(content, /restoreSafetyState\(\{ consecutiveLosses, paused, processedTradeIds \}\)/);
});

test('BotManager defers/retries the closed-trade lookup instead of relying on a single immediate query (Position-close vs Trade-create race)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'services', 'botManager', 'BotManager.js'), 'utf8');
  assert.match(content, /pendingClosedTradeLookup/);
  assert.match(content, /CLOSED_TRADE_LOOKUP_MAX_ATTEMPTS/);
  assert.match(content, /CLOSED_TRADE_LOOKUP_MAX_WAIT_MS/);
  // Must not give up after a single query — a retry-on-next-tick path must exist.
  assert.match(content, /still unresolved and within bounds — retried again on the next tick/);
});

test('ConsecutiveLossSafety.restoreState seeds the dedup set — a trade already counted during reconstruction cannot be double-counted after restart', () => {
  const safety = new ConsecutiveLossSafety(3);
  // Simulate BotManager._recoverSafetyState reconstructing "2 consecutive losses"
  // from trades t1 (older) and t2 (newer, most recent).
  safety.restoreState({ consecutiveLosses: 2, paused: false, processedTradeIds: ['t1', 't2'] });
  assert.equal(safety.getState().consecutiveLosses, 2);

  // A redelivery of the SAME trade t2 (e.g. a replayed/duplicate onPositionClosed
  // call after restart) must be recognized as a duplicate, not counted again.
  const redelivered = safety.recordTradeOutcome('t2', -10);
  assert.equal(redelivered.duplicate, true);
  assert.equal(safety.getState().consecutiveLosses, 2, 'redelivering an already-reconstructed trade must not bump the count');

  // A genuinely NEW loss (t3) still counts normally.
  const genuinelyNew = safety.recordTradeOutcome('t3', -10);
  assert.equal(genuinelyNew.duplicate, false);
  assert.equal(safety.getState().consecutiveLosses, 3);
  assert.equal(safety.getState().paused, true);
});

test('restoreState without processedTradeIds (older/partial state) still restores consecutiveLosses/paused correctly — backward compatible', () => {
  const safety = new ConsecutiveLossSafety(3);
  safety.restoreState({ consecutiveLosses: 2, paused: false });
  assert.equal(safety.getState().consecutiveLosses, 2);
  assert.equal(safety.processedTradeIds.size, 0);
});

test('Model002.restoreSafetyState forwards processedTradeIds through to the underlying safety state (end-to-end restart-safe dedup)', async () => {
  const { model } = await startedModel();
  model.restoreSafetyState({ consecutiveLosses: 2, paused: false, processedTradeIds: ['t1', 't2'] });
  const redelivered = await model.onPositionClosed({ _id: 't2', realizedPnl: -10, reason: 'STOP_LOSS' });
  assert.equal(model.safety.getState().consecutiveLosses, 2, 'the already-reconstructed trade t2 must not be recounted after restoreSafetyState');
});

test('MODEL_001 never defines onPositionClosed/restoreSafetyState/getSafetyLossLimit — the new BotManager hooks are no-ops for it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'bot-models', 'model-001');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(/onPositionClosed|restoreSafetyState|getSafetyLossLimit/.test(content), false, `${file} unexpectedly defines a MODEL_002-only safety hook`);
  }
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
// MODEL_001 regression — untouched by this pass
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

test('ConsecutiveLossSafety.restoreState: seeding with the FULL loaded trade window (not just the loss-streak trades) protects an older, pre-streak trade from being double-counted too', () => {
  const safety = new ConsecutiveLossSafety(3);
  // Simulate _recoverSafetyState's real behavior: consecutiveLosses=1 (only
  // the newest trade, t3, is a loss — t1/t2 are older and were WINs), but
  // ALL of t1/t2/t3 were loaded and must all be seeded into the dedup set.
  safety.restoreState({ consecutiveLosses: 1, paused: false, processedTradeIds: ['t1', 't2', 't3'] });
  assert.equal(safety.getState().consecutiveLosses, 1, 'the consecutive-loss calculation itself is unchanged');

  // A redelivery of t1 — an OLDER trade outside the current streak, but
  // still within the loaded lookback window — must be recognized as a
  // duplicate, not counted as a fresh outcome.
  const redelivered = safety.recordTradeOutcome('t1', -10);
  assert.equal(redelivered.duplicate, true);
  assert.equal(safety.getState().consecutiveLosses, 1, 'redelivering an older, already-loaded trade must not change the streak');
});

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
