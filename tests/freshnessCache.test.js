'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const FreshnessCache = require('../services/marketData/FreshnessCache');

test('a symbol with no data is not fresh', () => {
  const cache = new FreshnessCache(1000);
  assert.equal(cache.isFresh('BTCUSD'), false);
});

test('a symbol updated just now is fresh', () => {
  const cache = new FreshnessCache(1000);
  cache.setPrice('BTCUSD', 50000, Date.now());
  assert.equal(cache.isFresh('BTCUSD'), true);
});

test('a symbol updated beyond the stale threshold is not fresh', () => {
  const cache = new FreshnessCache(1000);
  cache.setPrice('BTCUSD', 50000, Date.now() - 5000);
  assert.equal(cache.isFresh('BTCUSD'), false);
});

test('subscribers are notified on price updates', () => {
  const cache = new FreshnessCache(1000);
  let received = null;
  cache.subscribe('BTCUSD', (update) => { received = update; });
  cache.setPrice('BTCUSD', 51000, 123456);
  assert.deepEqual(received, { symbol: 'BTCUSD', price: 51000, timestamp: 123456 });
});

test('unsubscribe stops further notifications', () => {
  const cache = new FreshnessCache(1000);
  let count = 0;
  const unsub = cache.subscribe('BTCUSD', () => { count += 1; });
  cache.setPrice('BTCUSD', 1, Date.now());
  unsub();
  cache.setPrice('BTCUSD', 2, Date.now());
  assert.equal(count, 1);
});
