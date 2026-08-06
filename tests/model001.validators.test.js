'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAndMergeParameters } = require('../bot-models/model-001/validators');
const { DEFAULT_PARAMETERS } = require('../bot-models/model-001/config');

test('empty input merges to safe defaults', () => {
  const merged = validateAndMergeParameters({});
  assert.deepEqual(merged, DEFAULT_PARAMETERS);
});

test('undefined input merges to safe defaults', () => {
  const merged = validateAndMergeParameters(undefined);
  assert.deepEqual(merged, DEFAULT_PARAMETERS);
});

test('partial overrides are merged on top of defaults', () => {
  const merged = validateAndMergeParameters({ timeframe: '15m', stopLossPercent: 2.5 });
  assert.equal(merged.timeframe, '15m');
  assert.equal(merged.stopLossPercent, 2.5);
  assert.equal(merged.takeProfitPercent, DEFAULT_PARAMETERS.takeProfitPercent);
});

test('rejects an unsupported timeframe', () => {
  assert.throws(() => validateAndMergeParameters({ timeframe: '7m' }), /timeframe/);
});

test('rejects historySize out of range', () => {
  assert.throws(() => validateAndMergeParameters({ historySize: 5 }), /historySize/);
  assert.throws(() => validateAndMergeParameters({ historySize: 1000 }), /historySize/);
});

test('rejects breakoutLookback >= historySize', () => {
  assert.throws(() => validateAndMergeParameters({ historySize: 20, breakoutLookback: 20 }), /breakoutLookback/);
});

test('rejects minimumBodyRatio outside 0-1', () => {
  assert.throws(() => validateAndMergeParameters({ minimumBodyRatio: 1.5 }), /minimumBodyRatio/);
  assert.throws(() => validateAndMergeParameters({ minimumBodyRatio: -0.1 }), /minimumBodyRatio/);
});

test('rejects non-boolean flags', () => {
  assert.throws(() => validateAndMergeParameters({ pyramiding: 'yes' }), /pyramiding/);
  assert.throws(() => validateAndMergeParameters({ volumeConfirmationEnabled: 1 }), /volumeConfirmationEnabled/);
});

test('rejects an unregistered ruleSet', () => {
  assert.throws(() => validateAndMergeParameters({ ruleSet: 'NOT_REAL' }), /ruleSet/);
});

test('rejects an unsupported quantityMode', () => {
  assert.throws(() => validateAndMergeParameters({ quantityMode: 'FIXED_LOTS' }), /quantityMode/);
});

test('rejects capitalUsagePercent outside (0,1]', () => {
  assert.throws(() => validateAndMergeParameters({ capitalUsagePercent: 0 }), /capitalUsagePercent/);
  assert.throws(() => validateAndMergeParameters({ capitalUsagePercent: 1.5 }), /capitalUsagePercent/);
});

test('rejects stopLossPercent/takeProfitPercent out of range', () => {
  assert.throws(() => validateAndMergeParameters({ stopLossPercent: -1 }), /stopLossPercent/);
  assert.throws(() => validateAndMergeParameters({ takeProfitPercent: 500 }), /takeProfitPercent/);
});

test('error message batches all violations at once', () => {
  try {
    validateAndMergeParameters({ timeframe: 'bad', pyramiding: 'nope' });
    assert.fail('expected validateAndMergeParameters to throw');
  } catch (err) {
    assert.match(err.message, /timeframe/);
    assert.match(err.message, /pyramiding/);
  }
});
