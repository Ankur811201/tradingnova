'use strict';

/**
 * NOTE (Phase 2 fix, unrelated to MODEL_002): this file previously tested a
 * DEFAULT_RULESET_V1 breakout-pattern engine (breakoutLookback,
 * minimumBodyRatio, RULESET_EVALUATORS, an object-arg evaluate() signature)
 * that no longer exists in bot-models/model-001/patternEngine.js. The
 * production code was rewritten at some point to the client's actual
 * CLIENT_MASTER_LOGIC_V1 strategy (topLevel/bottomLevel touches, EMA50
 * trend, liquidity-sweep rejection, 3-candle buy/sell cycles, dynamic lot
 * sizing) exposed as a single positional-arg function
 * evaluateStrategy(candles, params, levelCounts) — but this test file was
 * never updated to match. Every scenario below was independently verified
 * against the current, unmodified patternEngine.js before being written
 * here (no guessing). Production code was NOT changed to make these pass.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const patternEngine = require('../bot-models/model-001/patternEngine');

const STEP = 60000;

function flat(count, price, startTs = 0) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ timestamp: startTs + i * STEP, open: price, high: price, low: price, close: price, volume: null });
  }
  return out;
}

function baseParams(overrides) {
  return Object.assign({
    topLevel: 130, bottomLevel: 95, mintick: 0.01,
    hiPoints: 360, miPoints: 250, loPoints: 150, soatPoints: 70,
    lotHi: 4, lotMi: 6, lotLo: 7, lotSoat: 10,
    maxTradesPerLevel: 2, slBufferPips: 10,
  }, overrides);
}

function zeroLevelCounts() {
  return { l1: 0, l2: 0, l3: 0 };
}

test('NO_ACTION when there is insufficient candle history (fewer than 50 candles)', () => {
  const result = patternEngine.evaluateStrategy(flat(5, 100), baseParams(), zeroLevelCounts());
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.reason, 'insufficient_history');
  assert.equal(result.analysis, null);
});

test('NO_ACTION when neither topLevel nor bottomLevel is touched', () => {
  const result = patternEngine.evaluateStrategy(flat(51, 100), baseParams(), zeroLevelCounts());
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.reason, 'no_level_touch');
});

test('SHORT (L1_AGAINST_SELL): topLevel swept, downtrend, valid 1.5x body -> rejection-sweep short', () => {
  const base = flat(35, 100);
  let price = 100;
  const decline = [];
  for (let i = 0; i < 14; i += 1) {
    const o = price; const c = price - 2;
    decline.push({ timestamp: (35 + i) * STEP, open: o, high: o + 0.2, low: c - 0.2, close: c, volume: null });
    price = c;
  }
  const prevCandle = { timestamp: 49 * STEP, open: price, high: price + 0.5, low: price - 1, close: price - 0.5, volume: null };
  const trigger = { timestamp: 50 * STEP, open: price, high: 112, low: price - 10, close: price - 8, volume: null };
  const candles = base.concat(decline, [prevCandle, trigger]);

  const result = patternEngine.evaluateStrategy(candles, baseParams({ topLevel: 110, bottomLevel: 80 }), zeroLevelCounts());
  assert.equal(result.action, 'SHORT');
  assert.equal(result.ruleId, 'L1_AGAINST_SELL');
  assert.equal(result.levelUpdated, 'l1');
  assert.equal(result.analysis.liquiditySweepHigh, true);
  assert.equal(result.analysis.isValidBody15x, true);
});

test('LONG (L1_WITH_BUY): bottomLevel touched, uptrend, 3-candle buy cycle -> support buy', () => {
  const base = flat(47, 100);
  const c1 = { timestamp: 47 * STEP, open: 99, high: 99, low: 98, close: 99, volume: null };
  const c2 = { timestamp: 48 * STEP, open: 99, high: 101, low: 98.5, close: 100.5, volume: null };
  const c3 = { timestamp: 49 * STEP, open: 100.5, high: 105, low: 94, close: 105, volume: null };
  const candles = base.concat([c1, c2, c3]);

  const result = patternEngine.evaluateStrategy(candles, baseParams(), zeroLevelCounts());
  assert.equal(result.action, 'LONG');
  assert.equal(result.ruleId, 'L1_WITH_BUY');
  assert.equal(result.levelUpdated, 'l1');
  assert.equal(result.analysis.cycle3CandleBuy, true);
});

test('NO_ACTION (level_touched_no_confirmation) when a level is touched but the trade condition is not met', () => {
  const base = flat(50, 100);
  // Touches bottomLevel but with a bearish/no-cycle candle -> no L1_WITH_BUY, no L1_AGAINST_SELL either.
  const touchOnly = { timestamp: 50 * STEP, open: 100, high: 100.2, low: 94, close: 99, volume: null };
  const candles = base.concat([touchOnly]);
  const result = patternEngine.evaluateStrategy(candles, baseParams(), zeroLevelCounts());
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.reason, 'level_touched_no_confirmation');
});

test('maxTradesPerLevel cap: a level already at its trade cap produces NO_ACTION even when the setup is otherwise valid', () => {
  const base = flat(47, 100);
  const c1 = { timestamp: 47 * STEP, open: 99, high: 99, low: 98, close: 99, volume: null };
  const c2 = { timestamp: 48 * STEP, open: 99, high: 101, low: 98.5, close: 100.5, volume: null };
  const c3 = { timestamp: 49 * STEP, open: 100.5, high: 105, low: 94, close: 105, volume: null };
  const candles = base.concat([c1, c2, c3]);

  const p = baseParams({ maxTradesPerLevel: 2 });
  const result = patternEngine.evaluateStrategy(candles, p, { l1: 2, l2: 0, l3: 0 });
  assert.equal(result.action, 'NO_ACTION');
});

test('analysis object exposes real, already-computed values — never a fabricated pass/fail (volume is always absent from these candles, never referenced as a pass)', () => {
  const base = flat(47, 100);
  const c1 = { timestamp: 47 * STEP, open: 99, high: 99, low: 98, close: 99, volume: null };
  const c2 = { timestamp: 48 * STEP, open: 99, high: 101, low: 98.5, close: 100.5, volume: null };
  const c3 = { timestamp: 49 * STEP, open: 100.5, high: 105, low: 94, close: 105, volume: null };
  const candles = base.concat([c1, c2, c3]);
  const result = patternEngine.evaluateStrategy(candles, baseParams(), zeroLevelCounts());
  assert.ok(result.analysis);
  assert.equal(result.analysis.bodySize, Math.abs(c3.close - c3.open));
  assert.equal(result.analysis.prevBodySize, Math.abs(c2.close - c2.open));
  assert.ok(!Object.prototype.hasOwnProperty.call(result.analysis, 'volume'));
});

test('evaluateStrategy() is deterministic for identical inputs', () => {
  const base = flat(47, 100);
  const c1 = { timestamp: 47 * STEP, open: 99, high: 99, low: 98, close: 99, volume: null };
  const c2 = { timestamp: 48 * STEP, open: 99, high: 101, low: 98.5, close: 100.5, volume: null };
  const c3 = { timestamp: 49 * STEP, open: 100.5, high: 105, low: 94, close: 105, volume: null };
  const candles = base.concat([c1, c2, c3]);
  const a = patternEngine.evaluateStrategy(candles, baseParams(), zeroLevelCounts());
  const b = patternEngine.evaluateStrategy(candles, baseParams(), zeroLevelCounts());
  assert.deepEqual(a, b);
});

test('dynamic lot sizing tiers: a large-range candle selects lotHi', () => {
  const base = flat(47, 100);
  const c1 = { timestamp: 47 * STEP, open: 99, high: 99, low: 98, close: 99, volume: null };
  const c2 = { timestamp: 48 * STEP, open: 99, high: 101, low: 98.5, close: 100.5, volume: null };
  // range (high-low)/mintick = (105-94)/0.01 = 1100 >= hiPoints(360) -> lotHi
  const c3 = { timestamp: 49 * STEP, open: 100.5, high: 105, low: 94, close: 105, volume: null };
  const candles = base.concat([c1, c2, c3]);
  const result = patternEngine.evaluateStrategy(candles, baseParams({ lotHi: 4 }), zeroLevelCounts());
  assert.equal(result.lot, 4);
});
