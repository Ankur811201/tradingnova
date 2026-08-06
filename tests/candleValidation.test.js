'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateCandle } = require('../utils/candleValidation');

function candle(overrides) {
  return Object.assign({ timestamp: 1700000000000, open: 100, high: 105, low: 98, close: 103, volume: 10 }, overrides);
}

test('a well-formed candle passes', () => {
  assert.equal(validateCandle(candle()), true);
});

test('rejects NaN/missing/non-positive OHLC values', () => {
  assert.equal(validateCandle(candle({ close: NaN })), false);
  const missing = candle(); delete missing.high;
  assert.equal(validateCandle(missing), false);
  assert.equal(validateCandle(candle({ low: 0 })), false);
  assert.equal(validateCandle(candle({ open: -1 })), false);
});

test('rejects an invalid (zero/negative) timestamp', () => {
  assert.equal(validateCandle(candle({ timestamp: 0 })), false);
  assert.equal(validateCandle(candle({ timestamp: -1 })), false);
});

test('rejects internally inconsistent high/low', () => {
  assert.equal(validateCandle(candle({ high: 90 })), false);
  assert.equal(validateCandle(candle({ low: 110 })), false);
});

test('volume is optional but must be a valid non-negative number if present', () => {
  assert.equal(validateCandle(candle({ volume: null })), true);
  assert.equal(validateCandle(candle({ volume: undefined })), true);
  assert.equal(validateCandle(candle({ volume: -5 })), false);
  assert.equal(validateCandle(candle({ volume: NaN })), false);
});

test('rejects non-object input without throwing', () => {
  assert.equal(validateCandle(null), false);
  assert.equal(validateCandle(undefined), false);
  assert.equal(validateCandle('candle'), false);
  assert.equal(validateCandle(42), false);
});
