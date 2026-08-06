'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateCandle } = require('../bot-models/model-001/validators');
const indicators = require('../bot-models/model-001/indicators');

function candle(overrides) {
  return Object.assign({ timestamp: 1000, open: 100, high: 105, low: 98, close: 103, volume: 10 }, overrides);
}

// --- 1/2. Candle validation ---

test('valid candle passes validation', () => {
  assert.equal(validateCandle(candle()), true);
});

test('rejects candle with NaN price', () => {
  assert.equal(validateCandle(candle({ close: NaN })), false);
});

test('rejects candle with missing OHLC field', () => {
  const c = candle();
  delete c.high;
  assert.equal(validateCandle(c), false);
});

test('rejects candle with non-positive price', () => {
  assert.equal(validateCandle(candle({ low: 0 })), false);
  assert.equal(validateCandle(candle({ open: -5 })), false);
});

test('rejects candle with invalid timestamp', () => {
  assert.equal(validateCandle(candle({ timestamp: 0 })), false);
  assert.equal(validateCandle(candle({ timestamp: -100 })), false);
});

test('rejects candle where high is less than other prices', () => {
  assert.equal(validateCandle(candle({ high: 90 })), false); // high < close
});

test('rejects candle where low is greater than other prices', () => {
  assert.equal(validateCandle(candle({ low: 110 })), false); // low > open/close/high
});

test('accepts candle with null volume (optional field)', () => {
  assert.equal(validateCandle(candle({ volume: null })), true);
});

test('rejects candle with negative volume', () => {
  assert.equal(validateCandle(candle({ volume: -1 })), false);
});

test('rejects non-object input', () => {
  assert.equal(validateCandle(null), false);
  assert.equal(validateCandle('candle'), false);
  assert.equal(validateCandle(undefined), false);
});

// --- 3/4/5/6. Bullish/bearish/wick/body calculations ---

test('bullish candle calculation', () => {
  const c = candle({ open: 100, close: 105 });
  assert.equal(indicators.isBullish(c), true);
  assert.equal(indicators.isBearish(c), false);
});

test('bearish candle calculation', () => {
  const c = candle({ open: 105, close: 100 });
  assert.equal(indicators.isBearish(c), true);
  assert.equal(indicators.isBullish(c), false);
});

test('wick calculations', () => {
  const c = { timestamp: 1, open: 100, close: 105, high: 110, low: 95 };
  assert.equal(indicators.upperWick(c), 5); // 110 - max(100,105)
  assert.equal(indicators.lowerWick(c), 5); // min(100,105) - 95
});

test('body ratio calculation', () => {
  const c = { timestamp: 1, open: 100, close: 105, high: 110, low: 95 }; // range=15, body=5
  assert.equal(indicators.bodyRatio(c), 5 / 15);
});

test('body ratio is 0 for a zero-range candle', () => {
  const c = { timestamp: 1, open: 100, close: 100, high: 100, low: 100 };
  assert.equal(indicators.bodyRatio(c), 0);
});

test('doji detection uses body ratio threshold', () => {
  const doji = { timestamp: 1, open: 100, close: 100.5, high: 110, low: 90 }; // small body, big range
  assert.equal(indicators.isDoji(doji, 0.1), true);
  const nonDoji = { timestamp: 1, open: 100, close: 109, high: 110, low: 90 };
  assert.equal(indicators.isDoji(nonDoji, 0.1), false);
});

// --- 7/8. Swing/recent high & low ---

test('recentHigh returns the highest high across the window', () => {
  const candles = [candle({ high: 101 }), candle({ high: 108 }), candle({ high: 104 })];
  assert.equal(indicators.recentHigh(candles), 108);
});

test('recentLow returns the lowest low across the window', () => {
  const candles = [candle({ low: 95 }), candle({ low: 89 }), candle({ low: 92 })];
  assert.equal(indicators.recentLow(candles), 89);
});

test('recentHigh/recentLow return null for an empty window', () => {
  assert.equal(indicators.recentHigh([]), null);
  assert.equal(indicators.recentLow([]), null);
});

test('consecutive bullish/bearish counts trailing streak only', () => {
  const bull = candle({ open: 100, close: 101 });
  const bear = candle({ open: 101, close: 100 });
  assert.equal(indicators.consecutiveBullish([bear, bull, bull, bull]), 3);
  assert.equal(indicators.consecutiveBearish([bull, bear, bear]), 2);
});

test('pctChange computes percentage move', () => {
  assert.equal(indicators.pctChange(100, 110), 10);
  assert.equal(indicators.pctChange(100, 90), -10);
});

test('volumeAboveAverage returns null when volume data is missing', () => {
  const candles = [candle({ volume: null }), candle({ volume: 10 })];
  assert.equal(indicators.volumeAboveAverage(candles, 1.5), null);
});

test('volumeAboveAverage compares last candle against prior average', () => {
  const candles = [candle({ volume: 10 }), candle({ volume: 10 }), candle({ volume: 30 })];
  assert.equal(indicators.volumeAboveAverage(candles, 1.5), true); // 30 >= 10*1.5
  const candles2 = [candle({ volume: 10 }), candle({ volume: 10 }), candle({ volume: 5 })];
  assert.equal(indicators.volumeAboveAverage(candles2, 1.5), false);
});
