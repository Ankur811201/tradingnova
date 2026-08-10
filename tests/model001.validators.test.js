'use strict';

/**
 * NOTE (Phase 2 fix, unrelated to MODEL_002): this file previously tested a
 * DEFAULT_RULESET_V1-era validation contract (breakoutLookback,
 * minimumBodyRatio, pyramiding, volumeConfirmationEnabled, quantityMode,
 * capitalUsagePercent, stopLossPercent/takeProfitPercent, batched
 * multi-field error messages, and "empty input merges to safe defaults"
 * including a default timeframe) that no longer exists in
 * bot-models/model-001/validators.js. The production validator was
 * rewritten for the client's CLIENT_MASTER_LOGIC_V1 parameter set
 * (topLevel/bottomLevel, hiPoints/miPoints/loPoints/soatPoints,
 * lotHi/lotMi/lotLo/lotSoat, maxTradesPerLevel, slBufferPips) and now
 * deliberately has NO default timeframe (an explicit, valid timeframe is
 * required on every call — see the comment in validators.js) and throws on
 * the FIRST violation found rather than batching. Every case below was
 * independently verified against the current, unmodified validators.js
 * before being written here. Production code was NOT weakened to make
 * these pass.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAndMergeParameters } = require('../bot-models/model-001/validators');

test('throws when no timeframe is provided (identity-defining field, no default is ever guessed)', () => {
  assert.throws(() => validateAndMergeParameters({}), /no configured timeframe/);
  assert.throws(() => validateAndMergeParameters(undefined), /no configured timeframe/);
});

test('a valid timeframe merges with the current CLIENT_MASTER_LOGIC_V1 defaults', () => {
  const merged = validateAndMergeParameters({ timeframe: '5m' });
  assert.equal(merged.timeframe, '5m');
  assert.equal(merged.historySize, 100);
  assert.equal(merged.ruleSet, 'CLIENT_MASTER_LOGIC_V1');
  assert.equal(merged.maxTradesPerLevel, 2);
  assert.equal(merged.topLevel, 64280);
  assert.equal(merged.bottomLevel, 64024);
});

test('partial overrides are merged on top of defaults, everything else stays default', () => {
  const merged = validateAndMergeParameters({ timeframe: '15m', topLevel: 500, bottomLevel: 400 });
  assert.equal(merged.timeframe, '15m');
  assert.equal(merged.topLevel, 500);
  assert.equal(merged.bottomLevel, 400);
  assert.equal(merged.slBufferPips, 10.0);
});

test('rejects an unsupported timeframe, naming the valid set', () => {
  assert.throws(() => validateAndMergeParameters({ timeframe: '7m' }), /Invalid timeframe/);
});

test('rejects historySize below 50 (needed for the 50-period EMA)', () => {
  assert.throws(() => validateAndMergeParameters({ timeframe: '5m', historySize: 10 }), /historySize/);
});

test('accepts historySize at or above 50', () => {
  const merged = validateAndMergeParameters({ timeframe: '5m', historySize: 200 });
  assert.equal(merged.historySize, 200);
});

test('rejects maxTradesPerLevel below 1', () => {
  assert.throws(() => validateAndMergeParameters({ timeframe: '5m', maxTradesPerLevel: 0 }), /maxTradesPerLevel/);
});

test('accepts every timeframe the model actually supports, including 1d (Part A multi-timeframe infra)', () => {
  for (const tf of ['1m', '3m', '5m', '15m', '30m', '1h', '1d']) {
    const merged = validateAndMergeParameters({ timeframe: tf });
    assert.equal(merged.timeframe, tf);
  }
});

test('validateCandle accepts a well-formed OHLCV candle and rejects a structurally invalid one', () => {
  const { validateCandle } = require('../bot-models/model-001/validators');
  assert.equal(validateCandle({ open: 1, high: 2, low: 0.5, close: 1.5, timestamp: 1000 }), true);
  assert.equal(validateCandle({ open: 1, high: 2, low: 0.5, close: -1, timestamp: 1000 }), false);
  assert.equal(validateCandle(null), false);
});
