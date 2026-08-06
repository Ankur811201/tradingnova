'use strict';

/**
 * NOVA TRADE -- PART 8: Real MODEL_001 Decision Engine tests.
 *
 * Deliberately dependency-free (no mongoose/express/socket.io) so this file
 * can run in sandboxes without `npm install` / a database — like
 * tests/model001.model.test.js, it drives Model001 directly with a stub
 * emit/submitTradeCommand context.
 *
 * Covers (see Part 8 prompt "TESTS REQUIRED"):
 *   Test A - Real WAIT decision, real reason/analysis, no legacy values.
 *   Test B - Real BUY/SELL decision via patternEngine directly.
 *   Test C - No fake PASS/FAIL: volume is always UNAVAILABLE.
 *   (Test D/E/F/G/H require Mongo/Socket.IO/browser and are exercised via
 *    manual QA notes in the Part 8 final report, not here.)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const patternEngine = require('../bot-models/model-001/patternEngine');
const Model001 = require('../bot-models/model-001/Model001');

function makeCtx() {
  const ctx = {
    modelId: 'MODEL_001',
    modelVersion: '1.0.0',
    events: [],
    commands: [],
    nextResult: { approved: true, reason: 'Approved', metadata: {} },
  };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => { ctx.commands.push(cmd); return ctx.nextResult; };
  return ctx;
}

async function makeStartedModel(ctx, overrides) {
  const model = new Model001(ctx);
  await model.onStart(Object.assign({
    instanceId: 'inst_test',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: Object.assign({ timeframe: '1m' }, overrides && overrides.parameters),
    capitalAllocation: 10000,
    leverage: 2,
    riskSettings: {},
  }, overrides && overrides.instanceConfig));
  return model;
}

function decisionEvents(ctx) {
  return ctx.events.filter((e) => e.kind === 'StrategyEvent' && e.eventType === 'DECISION');
}

/** Builds `count` flat (non-moving) candles starting at `startTs`, one per `stepMs`. */
function flatCandleSequence(count, startTs, stepMs, price) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ timestamp: startTs + i * stepMs, open: price, high: price, low: price, close: price, volume: null });
  }
  return out;
}

async function feedCandles(model, candles) {
  for (const c of candles) {
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timestamp: c.timestamp, data: c }, null);
  }
}

// ---------------------------------------------------------------------
// patternEngine.evaluateStrategy — pure unit tests
// ---------------------------------------------------------------------

test('patternEngine: NO_ACTION with insufficient history reports a real reason and no analysis', () => {
  const result = patternEngine.evaluateStrategy([{ timestamp: 1, open: 1, high: 1, low: 1, close: 1 }], {}, { l1: 0 });
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.reason, 'insufficient_history');
  assert.equal(result.analysis, null);
});

test('patternEngine: WAIT with sufficient history exposes real, non-fabricated analysis fields', () => {
  const candles = flatCandleSequence(55, 0, 60000, 100);
  const params = { mintick: 0.01, topLevel: 1000000, bottomLevel: -1, maxTradesPerLevel: 2, slBufferPips: 10 };
  const result = patternEngine.evaluateStrategy(candles, params, { l1: 0 });

  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.reason, 'no_level_touch'); // topLevel/bottomLevel never touched by flat candles
  assert.ok(result.analysis, 'analysis must be present once there is enough history');
  // Every field must be a real computed value, not an invented pass/fail —
  // flat candles never touch either level, so both are explicitly false.
  assert.equal(result.analysis.touchTop, false);
  assert.equal(result.analysis.touchBottom, false);
  assert.equal(typeof result.analysis.ema50, 'number');
  assert.equal(result.analysis.trend, 'NEUTRAL'); // close === ema50 on a perfectly flat series
});

test('patternEngine: LONG rule match includes the real analysis that justified it (Test B)', () => {
  // 49 flat candles at price 100 (below bottomLevel-adjacent), then a
  // 3-candle rising cycle that touches bottomLevel with an uptrend close.
  const candles = flatCandleSequence(47, 0, 60000, 100);
  const c1 = { timestamp: 47 * 60000, open: 100, high: 101, low: 99, close: 100 };
  const c2 = { timestamp: 48 * 60000, open: 100, high: 105, low: 98, close: 104 };
  const c3 = { timestamp: 49 * 60000, open: 104, high: 110, low: 5, close: 109 }; // low touches bottomLevel=5
  candles.push(c1, c2, c3);

  const params = { mintick: 0.01, topLevel: 1000000, bottomLevel: 5, maxTradesPerLevel: 2, slBufferPips: 10 };
  const result = patternEngine.evaluateStrategy(candles, params, { l1: 0 });

  assert.equal(result.action, 'LONG');
  assert.equal(result.ruleId, 'L1_WITH_BUY');
  assert.ok(result.analysis, 'a real decision must carry the analysis that produced it');
  assert.equal(result.analysis.touchBottom, true);
  assert.equal(result.analysis.cycle3CandleBuy, true);
  assert.equal(result.analysis.trend, 'BULLISH');
});

// ---------------------------------------------------------------------
// Model001._emitDecision — integration with the real onMarketData pipeline
// ---------------------------------------------------------------------

test('Model001: emits a real DECISION StrategyEvent (WAIT) for a closed candle with no trade setup', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { parameters: { topLevel: 1000000, bottomLevel: -1 } });

  await feedCandles(model, flatCandleSequence(55, 60000, 60000, 100));

  const decisions = decisionEvents(ctx);
  assert.ok(decisions.length > 0, 'expected at least one DECISION event');
  const last = decisions[decisions.length - 1];

  assert.equal(last.payload.decision, 'WAIT');
  assert.equal(last.payload.action, 'NO_ACTION');
  assert.ok(last.payload.reason, 'a real WAIT must carry a real reason string');
  assert.notEqual(last.payload.reason, 'Waiting for valid breakout confirmation.'); // the legacy mock string
  assert.ok(last.payload.checks, 'checks must be populated once there is enough candle history');
});

test('Model001: Test C — volume is always reported UNAVAILABLE, never a fabricated PASS', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { parameters: { topLevel: 1000000, bottomLevel: -1 } });

  await feedCandles(model, flatCandleSequence(55, 60000, 60000, 100));

  const decisions = decisionEvents(ctx);
  const withChecks = decisions.find((e) => e.payload.checks);
  assert.ok(withChecks, 'expected at least one DECISION with checks populated');
  assert.equal(withChecks.payload.checks.volume.status, 'UNAVAILABLE');
  assert.equal(withChecks.payload.checks.volume.value, null);
});

test('Model001: Test A — WAIT decision when a position is already open is honest about skipped evaluation', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  const openPosition = { side: 'LONG' };

  for (const c of flatCandleSequence(55, 60000, 60000, 100)) {
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timestamp: c.timestamp, data: c }, openPosition);
  }

  const decisions = decisionEvents(ctx);
  assert.ok(decisions.length > 0);
  const last = decisions[decisions.length - 1];
  assert.equal(last.payload.decision, 'WAIT');
  assert.equal(last.payload.reason, 'position_open_entry_evaluation_skipped');
  assert.equal(last.payload.checks, null, 'no real analysis ran, so checks must be null, not fabricated');
});

test('Model001: no fake pass/fail values ever appear in a checks object (spot-check field values)', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { parameters: { topLevel: 1000000, bottomLevel: -1 } });
  await feedCandles(model, flatCandleSequence(55, 60000, 60000, 100));

  const decisions = decisionEvents(ctx);
  const withChecks = decisions.find((e) => e.payload.checks);
  assert.ok(withChecks);
  const { checks } = withChecks.payload;
  // Every status must be one of the real, defined vocabulary values — never
  // a bare boolean or an invented "PASS" where patternEngine only computed
  // a directional/touch result.
  assert.ok(['BULLISH', 'BEARISH', 'NEUTRAL'].includes(checks.trend.status));
  assert.ok(['TOUCHED', 'NOT_TOUCHED'].includes(checks.support.status));
  assert.ok(['TOUCHED', 'NOT_TOUCHED'].includes(checks.resistance.status));
  assert.ok(['PASS', 'FAIL'].includes(checks.bodyExpansion.status));
  assert.equal(checks.volume.status, 'UNAVAILABLE');
});

test('Model001: at most one DECISION per canonical closed candle (dedup reuses the existing candle-timestamp guard)', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { parameters: { topLevel: 1000000, bottomLevel: -1 } });
  const candle = { timestamp: 60000, open: 100, high: 100, low: 100, close: 100, volume: null };

  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timestamp: candle.timestamp, data: candle }, null);
  const countAfterFirst = decisionEvents(ctx).length;

  // Re-deliver the exact same closed candle (simulating a redelivery bug).
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timestamp: candle.timestamp, data: candle }, null);
  const countAfterDuplicate = decisionEvents(ctx).length;

  assert.equal(countAfterFirst, 1);
  assert.equal(countAfterDuplicate, 1, 'a duplicate closed candle must not produce a second DECISION');
});

test('Model001: malformed candles never produce a DECISION event', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);

  await model.onMarketData({
    type: 'candle', symbol: 'BTCUSD',
    data: { timestamp: 1, open: 100, high: 50, low: 200, close: NaN },
    timestamp: 1,
  }, null);

  assert.equal(decisionEvents(ctx).length, 0);
  assert.ok(ctx.events.some((e) => e.kind === 'Error'));
});
