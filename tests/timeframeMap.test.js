'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapTimeframe, UnsupportedTimeframeError, NOVA_TO_DELTA_RESOLUTION } = require('../services/marketData/timeframeMap');

test('every Model 001 timeframe maps to an identical Delta resolution', () => {
  assert.equal(mapTimeframe('1m'), '1m');
  assert.equal(mapTimeframe('3m'), '3m');
  assert.equal(mapTimeframe('5m'), '5m');
  assert.equal(mapTimeframe('15m'), '15m');
  assert.equal(mapTimeframe('30m'), '30m');
  assert.equal(mapTimeframe('1h'), '1h');
});

// PART A (multi-timeframe infra): '1d' added for higher-timeframe models
// (e.g. MODEL_002). Delta natively supports it — see timeframeMap.js header.
test('1d maps to an identical Delta resolution (Part A multi-timeframe infra)', () => {
  assert.equal(mapTimeframe('1d'), '1d');
});

test('an unsupported timeframe is rejected explicitly, never silently aggregated', () => {
  assert.throws(() => mapTimeframe('2m'), UnsupportedTimeframeError);
  assert.throws(() => mapTimeframe('4h'), UnsupportedTimeframeError);
  assert.throws(() => mapTimeframe(''), UnsupportedTimeframeError);
  assert.throws(() => mapTimeframe(undefined), UnsupportedTimeframeError);
});

test('UnsupportedTimeframeError message names the offending timeframe', () => {
  try {
    mapTimeframe('2m');
    assert.fail('expected mapTimeframe to throw');
  } catch (err) {
    assert.match(err.message, /2m/);
    assert.equal(err.code, 'UNSUPPORTED_TIMEFRAME');
  }
});

test('the mapping table covers exactly the timeframes Nova Trade supports (Model 001 set + Part A 1d)', () => {
  assert.deepEqual(
    Object.keys(NOVA_TO_DELTA_RESOLUTION).sort(),
    ['15m', '1h', '1m', '30m', '3m', '5m', '1d'].sort()
  );
});
