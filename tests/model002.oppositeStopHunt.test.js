'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Model002 = require('../bot-models/model-002/Model002');

const MIN = 60000;
const BASE = 1_700_000_000_000;
function flat(count, price, startTs = BASE) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: startTs + i * MIN, open: price, high: price + 1, low: price - 1, close: price, volume: null,
  }));
}
function candleAt(idx, o, h, l, c) {
  return { timestamp: BASE + idx * MIN, open: o, high: h, low: l, close: c, volume: null };
}
function ctx() {
  const x = { events: [], commands: [] };
  x.emit = e => x.events.push(e);
  x.submitTradeCommand = async cmd => { x.commands.push(cmd); return { approved: true }; };
  return x;
}
async function model(params = {}) {
  const c = ctx();
  const m = new Model002(c);
  await m.onStart({
    instanceId: 'stop-hunt-test', symbol: 'BTCUSD', environment: 'PAPER',
    parameters: Object.assign({ timeframe: '1m', trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [65000, 66000, 67000] }, params),
    capitalAllocation: 10000, leverage: 10, riskSettings: {},
  });
  await m.onHydrate(flat(20, 64000));
  return { c, m };
}

async function r1Pattern(m, baseIndex = 20) {
  const a = candleAt(baseIndex, 65020, 65030, 65010, 65015);
  const b = candleAt(baseIndex + 1, 65010, 65015, 64995, 65000);
  await m.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a.timestamp, data: a }, null);
  await m.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
  return { a, b };
}

test('first opposite BULLISH+R1 pattern becomes STOP_HUNTING and does not submit a trade', async () => {
  const { c, m } = await model();
  await r1Pattern(m);
  await m.onMarketData({ type: 'price', symbol: 'BTCUSD', timestamp: BASE + 21 * MIN + 1000, data: { price: 64990 } }, null);
  assert.equal(c.commands.length, 0);
  assert.ok(m.oppositeStopHuntActive);
  assert.equal(m.oppositeStopHuntUsed, true);
  assert.equal(m.oppositeStopHuntActive.direction, 'SELL');
  assert.equal(m.oppositeStopHuntActive.entryPrice, 64990);
  assert.equal(m.oppositeStopHuntActive.stopLoss, 65040);
  assert.ok(c.events.some(e => e.eventType === 'DECISION' && e.payload.decision === 'STOP_HUNTING'));
});

test('R1 stop hunt exits on its stop loss and the next R1 setup is a real SELL', async () => {
  const { c, m } = await model();
  await r1Pattern(m);
  await m.onMarketData({ type: 'price', symbol: 'BTCUSD', timestamp: BASE + 21 * MIN + 1000, data: { price: 64990 } }, null);
  await m.onMarketData({ type: 'price', symbol: 'BTCUSD', timestamp: BASE + 21 * MIN + 2000, data: { price: 65040 } }, null);
  assert.equal(m.oppositeStopHuntActive, null);
  assert.equal(m.oppositeStopHuntUsed, true);
  assert.ok(c.events.some(e => e.eventType === 'DECISION' && e.payload.decision === 'STOP_HUNTING_EXIT'));

  // New R1 pattern after stop-hunt is consumed.
  const a2 = candleAt(22, 65035, 65040, 65025, 65030);
  const b2 = candleAt(23, 65030, 65035, 65015, 65020);
  await m.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a2.timestamp, data: a2 }, null);
  await m.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b2.timestamp, data: b2 }, null);
  await m.onMarketData({ type: 'price', symbol: 'BTCUSD', timestamp: b2.timestamp + 1000, data: { price: 65010 } }, null);
  assert.equal(c.commands.length, 1);
  assert.equal(c.commands[0].action, 'SHORT');
});

test('BULLISH+R2 goes directly to real SELL even when stop hunt was never used', async () => {
  const { c, m } = await model();
  const a = candleAt(20, 66020, 66030, 66010, 66015);
  const b = candleAt(21, 66010, 66015, 65995, 66000);
  await m.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a.timestamp, data: a }, null);
  await m.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
  await m.onMarketData({ type: 'price', symbol: 'BTCUSD', timestamp: b.timestamp + 1000, data: { price: 65990 } }, null);
  assert.equal(c.commands.length, 1);
  assert.equal(c.commands[0].action, 'SHORT');
  assert.equal(m.oppositeStopHuntUsed, false);
});

test('BEARISH+S1 gets the one-time BUY stop hunt; S2 is direct BUY', async () => {
  const c = ctx();
  const m = new Model002(c);
  await m.onStart({ instanceId: 's1-test', symbol: 'BTCUSD', environment: 'PAPER', parameters: { timeframe: '1m', trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [70000, 69000, 68000] }, capitalAllocation: 10000, leverage: 10, riskSettings: {} });
  await m.onHydrate(flat(20, 60200));
  const a = candleAt(20, 60100, 60200, 60100, 60150);
  const b = candleAt(21, 60100, 60310, 60000, 60300);
  await m.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a.timestamp, data: a }, null);
  await m.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
  await m.onMarketData({ type: 'price', symbol: 'BTCUSD', timestamp: b.timestamp + 1000, data: { price: 60315 } }, null);
  assert.equal(c.commands.length, 0);
  assert.equal(m.oppositeStopHuntUsed, true);
  assert.equal(m.oppositeStopHuntActive.direction, 'BUY');
});
