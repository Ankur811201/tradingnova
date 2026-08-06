'use strict';

/**
 * Unit tests for DeltaMarketDataProvider's pure normalization/status logic.
 * These construct the provider (which requires the `axios` package) but make
 * no real network calls — only the private normalization helpers and status
 * accessors are exercised directly.
 *
 * NOTE: like other tests that import axios/mongoose, this requires
 * `npm install` to run (this sandbox has no network access — see root
 * README "Sandbox limitations"). Syntax-checked with `node --check`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const DeltaMarketDataProvider = require('../services/marketData/DeltaMarketDataProvider');

function makeProvider(overrides) {
  return new DeltaMarketDataProvider(Object.assign({
    baseUrl: 'https://api.india.delta.exchange/v2',
    wsUrl: 'wss://socket.india.delta.exchange',
    staleThresholdMs: 15000,
    pollIntervalMs: 3000,
    useWebSocket: false,
  }, overrides));
}

test('getConnectionStatus reports configured=true and providerName=delta_rest by default', () => {
  const provider = makeProvider();
  const status = provider.getConnectionStatus();
  assert.equal(status.configured, true);
  assert.equal(status.providerName, 'delta_rest');
  assert.equal(status.connected, false); // nothing polled yet
  assert.deepEqual(status.activeSymbols, []);
});

test('isDataFresh is false before any price has been recorded', () => {
  const provider = makeProvider();
  assert.equal(provider.isDataFresh('BTCUSD'), false);
});

test('_normalizeCandle accepts a well-formed Delta candle (time in seconds -> ms)', () => {
  const provider = makeProvider();
  const raw = { time: 1700000000, open: '100', high: '105', low: '98', close: '103', volume: '12.5' };
  const normalized = provider._normalizeCandle(raw);
  assert.ok(normalized);
  assert.equal(normalized.timestamp, 1700000000000);
  assert.equal(normalized.open, 100);
  assert.equal(normalized.close, 103);
  assert.equal(normalized.volume, 12.5);
});

test('_normalizeCandle rejects a malformed candle (never fabricates data)', () => {
  const provider = makeProvider();
  assert.equal(provider._normalizeCandle({ time: 1700000000, open: 100, high: 50, low: 200, close: 103 }), null);
  assert.equal(provider._normalizeCandle({ time: 1700000000, open: 'NaN', high: 105, low: 98, close: 103 }), null);
  assert.equal(provider._normalizeCandle(null), null);
  assert.equal(provider._normalizeCandle({}), null);
});

test('_extractPrice prefers close, falls back to mark_price/spot_price/last_price', () => {
  const provider = makeProvider();
  assert.equal(provider._extractPrice({ result: { close: '50000.5' } }), 50000.5);
  assert.equal(provider._extractPrice({ result: { mark_price: '50001' } }), 50001);
  assert.equal(provider._extractPrice({ result: { spot_price: 49999 } }), 49999);
  assert.equal(provider._extractPrice({ result: { last_price: 50002 } }), 50002);
});

test('_extractPrice returns null (never a fabricated price) when nothing usable is present', () => {
  const provider = makeProvider();
  assert.equal(provider._extractPrice({ result: {} }), null);
  assert.equal(provider._extractPrice({}), null);
  assert.equal(provider._extractPrice({ result: { close: '0' } }), null); // non-positive rejected
  assert.equal(provider._extractPrice({ result: { close: 'not-a-number' } }), null);
});

test('_extractTimestamp normalizes seconds/ms/microseconds defensively', () => {
  const provider = makeProvider();
  const nowSec = Math.floor(Date.now() / 1000);
  assert.equal(provider._extractTimestamp({ result: { timestamp: nowSec } }), nowSec * 1000);
  const nowMs = Date.now();
  assert.equal(provider._extractTimestamp({ result: { timestamp: nowMs } }), nowMs);
});

test('_extractTimestamp falls back to current time when the field is missing/invalid', () => {
  const provider = makeProvider();
  const result = provider._extractTimestamp({ result: {} });
  assert.ok(Math.abs(result - Date.now()) < 5000);
});

test('_defaultLookbackSeconds scales with timeframe and requested limit', () => {
  const provider = makeProvider();
  assert.equal(provider._defaultLookbackSeconds('1m', 200), 60 * 200);
  assert.equal(provider._defaultLookbackSeconds('1h', 10), 3600 * 10);
  assert.equal(provider._defaultLookbackSeconds('5m', undefined), 300 * 200); // default limit 200
});

test('WebSocket opt-in without a wsUrl safely falls back to REST polling instead of crashing', () => {
  const provider = makeProvider({ useWebSocket: true, wsUrl: '' });
  assert.equal(provider.useWebSocket, false);
  assert.equal(provider.getConnectionStatus().providerName, 'delta_rest');
});

test('getCandles rejects an unmapped timeframe before making any network call', async () => {
  const provider = makeProvider();
  await assert.rejects(() => provider.getCandles('BTCUSD', '2m'));
});
