'use strict';

/**
 * PART A — multi-timeframe infrastructure tests.
 *
 * Pure-logic coverage only (no MongoDB connection): the timeframe/config
 * additions, and BotManager._instanceAcceptsTimeframe / requiredTimeframes
 * plumbing exercised against an in-memory registeredModels map, exactly the
 * way BotManager.discoverModels() would have populated it from a real
 * bot-models model folder's index.js at startup.
 *
 * Goal of this file specifically: prove MODEL_001 (a model that declares NO
 * requiredTimeframes) is byte-identical in behavior to before Part A, while
 * a multi-timeframe model gets exactly the additional timeframes it declared
 * — nothing more, nothing less.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TIMEFRAMES_MS } = require('../bot-models/model-001/config');
const { mapTimeframe, NOVA_TO_DELTA_RESOLUTION } = require('../services/marketData/timeframeMap');
const botManager = require('../services/botManager/BotManager');

test('TIMEFRAMES_MS gains 1d without altering any pre-existing entry', () => {
  assert.equal(TIMEFRAMES_MS['1d'], 24 * 60 * 60 * 1000);
  // pre-existing values, unchanged
  assert.equal(TIMEFRAMES_MS['1m'], 60 * 1000);
  assert.equal(TIMEFRAMES_MS['3m'], 3 * 60 * 1000);
  assert.equal(TIMEFRAMES_MS['5m'], 5 * 60 * 1000);
  assert.equal(TIMEFRAMES_MS['15m'], 15 * 60 * 1000);
  assert.equal(TIMEFRAMES_MS['30m'], 30 * 60 * 1000);
  assert.equal(TIMEFRAMES_MS['1h'], 60 * 60 * 1000);
});

test('NOVA_TO_DELTA_RESOLUTION maps 1d to Delta\'s native 1d resolution', () => {
  assert.equal(mapTimeframe('1d'), '1d');
  assert.equal(NOVA_TO_DELTA_RESOLUTION['1d'], '1d');
});

test('_instanceAcceptsTimeframe: a model with no requiredTimeframes behaves exactly like the pre-Part-A exact-match check', () => {
  botManager.registeredModels.set('MODEL_001_TEST', { modelId: 'MODEL_001_TEST', requiredTimeframes: [] });
  const instance = { modelId: 'MODEL_001_TEST', parameters: { timeframe: '5m' } };

  assert.equal(botManager._instanceAcceptsTimeframe(instance, '5m'), true);
  assert.equal(botManager._instanceAcceptsTimeframe(instance, '1h'), false);
  assert.equal(botManager._instanceAcceptsTimeframe(instance, '1m'), false);
  assert.equal(botManager._instanceAcceptsTimeframe(instance, '1d'), false);
});

test('_instanceAcceptsTimeframe: a model with no registeredModels entry at all still only accepts its own instance timeframe (fail-safe default)', () => {
  const instance = { modelId: 'MODEL_NEVER_REGISTERED', parameters: { timeframe: '15m' } };
  assert.equal(botManager._instanceAcceptsTimeframe(instance, '15m'), true);
  assert.equal(botManager._instanceAcceptsTimeframe(instance, '1h'), false);
});

test('_instanceAcceptsTimeframe: a multi-timeframe model accepts its entry timeframe plus every declared requiredTimeframe, and nothing else', () => {
  botManager.registeredModels.set('MODEL_002_TEST', {
    modelId: 'MODEL_002_TEST',
    requiredTimeframes: [
      { timeframe: '1h', history: 500 },
      { timeframe: '1d', history: 180 },
    ],
  });
  const instance = { modelId: 'MODEL_002_TEST', parameters: { timeframe: '1m' } };

  assert.equal(botManager._instanceAcceptsTimeframe(instance, '1m'), true, 'entry timeframe');
  assert.equal(botManager._instanceAcceptsTimeframe(instance, '1h'), true, 'declared requiredTimeframe');
  assert.equal(botManager._instanceAcceptsTimeframe(instance, '1d'), true, 'declared requiredTimeframe');
  assert.equal(botManager._instanceAcceptsTimeframe(instance, '15m'), false, 'not declared, not entry');
  assert.equal(botManager._instanceAcceptsTimeframe(instance, '5m'), false, 'not declared, not entry');
});

test('two different instances of the same multi-timeframe model are evaluated independently by their own instance timeframe', () => {
  // Same registered model, two BotInstances with different entry timeframes
  // (e.g. two MODEL_002 bots on different symbols/configs) — the declared
  // requiredTimeframes apply to both, but the entry timeframe is per-instance.
  const instanceA = { modelId: 'MODEL_002_TEST', parameters: { timeframe: '1m' } };
  const instanceB = { modelId: 'MODEL_002_TEST', parameters: { timeframe: '3m' } };

  assert.equal(botManager._instanceAcceptsTimeframe(instanceA, '3m'), false);
  assert.equal(botManager._instanceAcceptsTimeframe(instanceB, '3m'), true);
  assert.equal(botManager._instanceAcceptsTimeframe(instanceA, '1h'), true);
  assert.equal(botManager._instanceAcceptsTimeframe(instanceB, '1h'), true);
});
