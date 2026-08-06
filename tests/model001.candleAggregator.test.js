'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const CandleAggregator = require('../bot-models/model-001/candleAggregator');

const MIN = 60 * 1000;
const BASE = 10 * MIN; // real epoch timestamps are always > 0; avoid the ts<=0 edge case in these tests

test('first tick starts a candle and returns null (not yet closed)', () => {
  const agg = new CandleAggregator(MIN);
  const result = agg.addTick(100, BASE);
  assert.equal(result, null);
});

test('ticks within the same bucket update high/low/close but stay open', () => {
  const agg = new CandleAggregator(MIN);
  agg.addTick(100, BASE);
  agg.addTick(105, BASE + 10000);
  const result = agg.addTick(98, BASE + 20000);
  assert.equal(result, null);
  assert.equal(agg.current.open, 100);
  assert.equal(agg.current.high, 105);
  assert.equal(agg.current.low, 98);
  assert.equal(agg.current.close, 98);
});

test('a tick in the next bucket closes the previous candle', () => {
  const agg = new CandleAggregator(MIN);
  agg.addTick(100, BASE);
  agg.addTick(110, BASE + 30000);
  const closed = agg.addTick(120, BASE + MIN + 5000);
  assert.ok(closed);
  assert.equal(closed.open, 100);
  assert.equal(closed.high, 110);
  assert.equal(closed.close, 110);
  assert.equal(closed.timestamp, BASE);
  // the new tick starts the next candle
  assert.equal(agg.current.open, 120);
  assert.equal(agg.current.timestamp, BASE + MIN);
});

test('closed candles have volume: null (price-tick stream carries no volume)', () => {
  const agg = new CandleAggregator(MIN);
  agg.addTick(100, BASE);
  const closed = agg.addTick(101, BASE + MIN + 1);
  assert.equal(closed.volume, null);
});

test('out-of-order ticks (older bucket) are ignored, never rewriting a closed candle', () => {
  const agg = new CandleAggregator(MIN);
  agg.addTick(100, MIN * 5);
  const stale = agg.addTick(999, MIN); // belongs to an earlier bucket
  assert.equal(stale, null);
  assert.equal(agg.current.open, 100); // unchanged
});

test('invalid ticks (non-finite/non-positive price, or non-positive timestamp) are ignored', () => {
  const agg = new CandleAggregator(MIN);
  assert.equal(agg.addTick(NaN, BASE), null);
  assert.equal(agg.addTick(-5, BASE), null);
  assert.equal(agg.addTick(0, BASE), null);
  assert.equal(agg.addTick(100, 0), null);
  assert.equal(agg.current, null);
});

test('constructor rejects a non-positive timeframe', () => {
  assert.throws(() => new CandleAggregator(0));
  assert.throws(() => new CandleAggregator(-100));
});

test('aggregation is deterministic for the same input sequence', () => {
  const ticks = [[100, BASE], [102, BASE + 15000], [99, BASE + 40000], [105, BASE + MIN + 1000]];
  const run = () => {
    const agg = new CandleAggregator(MIN);
    return ticks.map(([p, t]) => agg.addTick(p, t)).filter(Boolean);
  };
  assert.deepEqual(run(), run());
});
