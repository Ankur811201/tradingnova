'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NullProvider, NotConfiguredError } = require('../services/marketData/NullProvider');

test('getPrice throws NotConfiguredError instead of returning fake data', async () => {
  const provider = new NullProvider();
  await assert.rejects(() => provider.getPrice('BTCUSD'), NotConfiguredError);
});

test('getCandles throws NotConfiguredError instead of returning fake candles', async () => {
  const provider = new NullProvider();
  await assert.rejects(() => provider.getCandles('BTCUSD', '1m'), NotConfiguredError);
});

test('isDataFresh always returns false when unconfigured', () => {
  const provider = new NullProvider();
  assert.equal(provider.isDataFresh('BTCUSD'), false);
});

test('getConnectionStatus reports not configured/not connected', () => {
  const provider = new NullProvider();
  const status = provider.getConnectionStatus();
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
});
