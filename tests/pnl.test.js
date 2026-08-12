'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeNotional, computeMargin, computeFee, computePnl, computeMultiTargets } = require('../utils/pnl');

test('computeNotional multiplies price by quantity', () => {
  assert.equal(computeNotional(100, 2), 200);
});

test('computeMargin divides notional by leverage', () => {
  assert.equal(computeMargin(1000, 10), 100);
});

test('computeMargin throws on zero/negative leverage', () => {
  assert.throws(() => computeMargin(1000, 0));
  assert.throws(() => computeMargin(1000, -5));
});

test('computeFee applies fee rate to notional', () => {
  assert.equal(computeFee(1000, 0.0005), 0.5);
});

test('LONG PnL is positive when price rises', () => {
  const pnl = computePnl('LONG', 100, 110, 2);
  assert.equal(pnl, 20); // (110-100)*2
});

test('LONG PnL is negative when price falls', () => {
  const pnl = computePnl('LONG', 100, 90, 2);
  assert.equal(pnl, -20);
});

test('SHORT PnL is positive when price falls', () => {
  const pnl = computePnl('SHORT', 100, 90, 2);
  assert.equal(pnl, 20); // (100-90)*2
});

test('SHORT PnL is negative when price rises', () => {
  const pnl = computePnl('SHORT', 100, 110, 2);
  assert.equal(pnl, -20);
});

test('computePnl throws on unknown side', () => {
  assert.throws(() => computePnl('SIDEWAYS', 100, 110, 1));
});

test('LONG/SHORT PnL are mirror images at same price move', () => {
  const longPnl = computePnl('LONG', 100, 105, 1);
  const shortPnl = computePnl('SHORT', 100, 105, 1);
  assert.equal(longPnl, -shortPnl);
});

// =========================================================================
// Multi-target exits (confirmed rules): risk=|entry-SL|, T1..T4=1R..4R,
// 25% of ORIGINAL quantity per target, BUY above entry / SELL below entry.
// =========================================================================

test('computeMultiTargets: BUY — targets are ABOVE entry, at exact R multiples', () => {
  const targets = computeMultiTargets('LONG', 100, 90, 4); // risk=10
  assert.deepEqual(targets.map((t) => t.price), [110, 120, 130, 140]);
  assert.deepEqual(targets.map((t) => t.rMultiple), [1, 2, 3, 4]);
});

test('computeMultiTargets: SELL — targets are BELOW entry, at exact R multiples', () => {
  const targets = computeMultiTargets('SHORT', 100, 110, 4); // risk=10
  assert.deepEqual(targets.map((t) => t.price), [90, 80, 70, 60]);
});

test('computeMultiTargets: each target is exactly 25% of ORIGINAL quantity, and the four slices sum to exactly the original (no floating-point residual)', () => {
  const targets = computeMultiTargets('LONG', 100, 90, 7); // an awkward, non-round quantity
  assert.equal(targets[0].quantity, 1.75);
  assert.equal(targets[1].quantity, 1.75);
  assert.equal(targets[2].quantity, 1.75);
  const sum = targets.reduce((s, t) => s + t.quantity, 0);
  assert.equal(sum, 7, 'the four slices must sum to EXACTLY the original quantity');
});

test('computeMultiTargets: T4 absorbs the exact remainder, never drifts from floating-point rounding across T1-T3', () => {
  const targets = computeMultiTargets('LONG', 100, 90, 1); // 0.25 per target — classic float-drift case
  const sum = targets.reduce((s, t) => s + t.quantity, 0);
  assert.equal(sum, 1);
});

test('computeMultiTargets: every target starts unhit', () => {
  const targets = computeMultiTargets('LONG', 100, 90, 4);
  for (const t of targets) {
    assert.equal(t.hit, false);
    assert.equal(t.hitAt, null);
  }
});

test('computeMultiTargets: returns null when stopLoss is not provided — risk is undefined without it', () => {
  assert.equal(computeMultiTargets('LONG', 100, null, 4), null);
  assert.equal(computeMultiTargets('LONG', 100, undefined, 4), null);
});

test('computeMultiTargets: returns null when stopLoss equals entry (zero risk distance)', () => {
  assert.equal(computeMultiTargets('LONG', 100, 100, 4), null);
});

test('computeMultiTargets: throws on an unknown side', () => {
  assert.throws(() => computeMultiTargets('SIDEWAYS', 100, 90, 4));
});

test('computeMultiTargets: risk is the absolute distance regardless of which side of entry the stop is on', () => {
  // A SL "on the wrong side" of entry for the given direction is not this
  // function's concern to validate (that belongs to whatever risk
  // validation already exists upstream) — it still computes |entry-SL|.
  const targets = computeMultiTargets('LONG', 100, 110, 4); // SL above entry — unusual but risk is still |100-110|=10
  assert.deepEqual(targets.map((t) => t.price), [110, 120, 130, 140]);
});

// =========================================================================
// Regression: PaperEngine's sequential per-target quantity subtraction can
// leave a tiny floating-point residual after all 4 targets fire, even
// though computeMultiTargets' OWN returned quantities sum EXACTLY to the
// original (proven above). This documents the exact residual PaperEngine's
// _applyPartialTargetFill guards against (forces quantity to exact 0 once
// all 4 targets are hit) — see tests/multiTargetExits.test.js for the real
// PaperEngine-level regression test (MongoDB-dependent).
// =========================================================================

test('REGRESSION (float residual): sequential subtraction of the 4 target quantities can leave a nonzero remainder for 0.1/0.3/3.7, even though the targets themselves sum exactly — this is exactly what PaperEngine._applyPartialTargetFill\'s explicit zero-guard exists to correct', () => {
  for (const originalQuantity of [0.1, 0.3, 3.7]) {
    const targets = computeMultiTargets('LONG', 100, 90, originalQuantity);
    const sumOfTargets = targets.reduce((s, t) => s + t.quantity, 0);
    assert.equal(sumOfTargets, originalQuantity, `computeMultiTargets itself must sum exactly for ${originalQuantity}`);

    // Simulate PaperEngine's actual accounting pattern: 4 SEQUENTIAL
    // subtractions from a running "remaining quantity" value (as
    // _applyPartialTargetFill's $inc effectively performs one at a time).
    let remaining = originalQuantity;
    for (const t of targets) remaining -= t.quantity;
    // This documents the real, non-hypothetical residual PaperEngine must
    // guard against — sequential subtraction does NOT reliably land on
    // exact 0 even when the four addends sum exactly as a group.
    assert.notEqual(remaining, 0, `expected a nonzero float residual for ${originalQuantity} to prove the guard is necessary, got exactly 0`);
    assert.ok(Math.abs(remaining) < 1e-10, 'the residual must be negligible (float noise), not a real accounting error');
  }
});
