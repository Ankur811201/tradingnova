'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const FakeCandleMarketDataProvider = require('../services/marketData/FakeCandleMarketDataProvider');

test('fake candle provider emits OHLC as normal price ticks in one bucket', async () => {
  const provider = new FakeCandleMarketDataProvider();
  const ticks = [];
  provider.subscribePrice('BTCUSD', async (tick) => ticks.push(tick));

  const result = await provider.pushCandle({
    symbol: 'BTCUSD', timeframe: '1m',
    open: 100, high: 105, low: 99, close: 103,
  });

  assert.equal(ticks.length, 4);
  assert.deepEqual(ticks.map(t => t.price), [100, 105, 99, 103]);
  assert.equal(result.closed, false);
});

test('fake candle provider advances one canonical candle bucket at a time', async () => {
  const provider = new FakeCandleMarketDataProvider();
  const starts = [];
  provider.subscribePrice('BTCUSD', async (tick) => starts.push(tick.timestamp));

  const a = await provider.pushCandle({symbol:'BTCUSD', timeframe:'1m', open:100, high:101, low:99, close:100.5});
  const b = await provider.pushCandle({symbol:'BTCUSD', timeframe:'1m', open:100.5, high:102, low:100, close:101});

  assert.equal(b.timestamp - a.timestamp, 60000);
  assert.ok(starts.every(Number.isFinite));
});

test('fake candle provider rejects malformed OHLC', async () => {
  const provider = new FakeCandleMarketDataProvider();
  provider.subscribePrice('BTCUSD', async () => {});
  await assert.rejects(
    provider.pushCandle({symbol:'BTCUSD', timeframe:'1m', open:100, high:90, low:99, close:101}),
    /high must be/,
  );
});


test('fake candle provider advances through project JSON sequence', async () => {
  const provider = new FakeCandleMarketDataProvider();
  provider.subscribePrice('BTCUSD', async () => {});
  const first = await provider.nextFromJson({ symbol: 'BTCUSD', timeframe: '1m' });
  const state = provider.sequenceState('BTCUSD', '1m');
  assert.equal(first.open, 100);
  assert.equal(state.index, 1);
  assert.equal(state.total, 4);
});
