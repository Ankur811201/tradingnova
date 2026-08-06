'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const patternEngine = require('../bot-models/model-001/patternEngine');
const { DEFAULT_PARAMETERS, DEFAULT_RULESET_V1 } = require('../bot-models/model-001/config');

function flatCandle(ts) {
  return { timestamp: ts, open: 100, high: 100, low: 100, close: 100, volume: null };
}

function flatHistory(count, startTs = 0, stepMs = 60000) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(flatCandle(startTs + i * stepMs));
  return out;
}

function params(overrides) {
  return Object.assign({}, DEFAULT_PARAMETERS, { volumeConfirmationEnabled: false }, overrides);
}

test('NO_ACTION when there is insufficient candle history', () => {
  const candles = flatHistory(5);
  const result = patternEngine.evaluate({ candles, params: params(), positionContext: null });
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.reason, 'insufficient_history');
});

test('LONG rule matches on a strong bullish breakout above recent high', () => {
  const p = params({ breakoutLookback: 20 });
  const history = flatHistory(20);
  const breakoutCandle = { timestamp: 20 * 60000, open: 100, close: 110, high: 111, low: 99, volume: null };
  const candles = history.concat([breakoutCandle]);
  const result = patternEngine.evaluate({ candles, params: p, positionContext: null });
  assert.equal(result.action, 'LONG');
  assert.equal(result.ruleId, 'RULE_LONG_BREAKOUT_V1');
  assert.equal(result.score, 1);
});

test('SHORT rule matches on a strong bearish breakdown below recent low', () => {
  const p = params({ breakoutLookback: 20 });
  const history = flatHistory(20);
  const breakdownCandle = { timestamp: 20 * 60000, open: 100, close: 90, high: 101, low: 89, volume: null };
  const candles = history.concat([breakdownCandle]);
  const result = patternEngine.evaluate({ candles, params: p, positionContext: null });
  assert.equal(result.action, 'SHORT');
  assert.equal(result.ruleId, 'RULE_SHORT_BREAKDOWN_V1');
});

test('NO_ACTION when body ratio is below the configured minimum', () => {
  const p = params({ breakoutLookback: 20, minimumBodyRatio: 0.5 });
  const history = flatHistory(20);
  // Small body relative to range: body=1, range=11, ratio ~0.09
  const weakCandle = { timestamp: 20 * 60000, open: 100, close: 101, high: 110, low: 99, volume: null };
  const candles = history.concat([weakCandle]);
  const result = patternEngine.evaluate({ candles, params: p, positionContext: null });
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.reason, 'no_rule_matched');
});

test('NO_ACTION when nothing breaks the recent range', () => {
  const p = params({ breakoutLookback: 20 });
  const history = flatHistory(20);
  const insideCandle = { timestamp: 20 * 60000, open: 100, close: 100, high: 100, low: 100, volume: null };
  const candles = history.concat([insideCandle]);
  const result = patternEngine.evaluate({ candles, params: p, positionContext: null });
  assert.equal(result.action, 'NO_ACTION');
});

test('pyramiding disabled: no duplicate LONG while a LONG position is already open', () => {
  const p = params({ breakoutLookback: 20, pyramiding: false });
  const history = flatHistory(20);
  const breakoutCandle = { timestamp: 20 * 60000, open: 100, close: 110, high: 111, low: 99, volume: null };
  const candles = history.concat([breakoutCandle]);
  const result = patternEngine.evaluate({ candles, params: p, positionContext: { side: 'LONG' } });
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.reason, 'pyramiding_disabled_long_already_open');
});

test('pyramiding disabled: no duplicate SHORT while a SHORT position is already open', () => {
  const p = params({ breakoutLookback: 20, pyramiding: false });
  const history = flatHistory(20);
  const breakdownCandle = { timestamp: 20 * 60000, open: 100, close: 90, high: 101, low: 89, volume: null };
  const candles = history.concat([breakdownCandle]);
  const result = patternEngine.evaluate({ candles, params: p, positionContext: { side: 'SHORT' } });
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.reason, 'pyramiding_disabled_short_already_open');
});

test('exit rule: CLOSE emitted when an opposing signal fires while a position is open', () => {
  const p = params({ breakoutLookback: 20, exitOnOpposingSignal: true });
  const history = flatHistory(20);
  const breakdownCandle = { timestamp: 20 * 60000, open: 100, close: 90, high: 101, low: 89, volume: null };
  const candles = history.concat([breakdownCandle]);
  const result = patternEngine.evaluate({ candles, params: p, positionContext: { side: 'LONG' } });
  assert.equal(result.action, 'CLOSE');
  assert.equal(result.ruleId, 'RULE_EXIT_ON_OPPOSING_SIGNAL_V1');
});

test('without exitOnOpposingSignal, an opposing signal produces NO_ACTION instead of stacking', () => {
  const p = params({ breakoutLookback: 20, exitOnOpposingSignal: false });
  const history = flatHistory(20);
  const breakdownCandle = { timestamp: 20 * 60000, open: 100, close: 90, high: 101, low: 89, volume: null };
  const candles = history.concat([breakdownCandle]);
  const result = patternEngine.evaluate({ candles, params: p, positionContext: { side: 'LONG' } });
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.reason, 'opposing_long_position_open');
});

test('an unknown ruleSet safely resolves to NO_ACTION rather than throwing', () => {
  const p = params({ ruleSet: 'SOME_UNREGISTERED_RULESET' });
  const candles = flatHistory(25);
  const result = patternEngine.evaluate({ candles, params: p, positionContext: null });
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.reason, 'unknown_ruleset');
});

test('volume confirmation blocks a signal when enabled but volume data is unavailable', () => {
  const p = params({ breakoutLookback: 20, volumeConfirmationEnabled: true });
  const history = flatHistory(20); // volume: null throughout
  const breakoutCandle = { timestamp: 20 * 60000, open: 100, close: 110, high: 111, low: 99, volume: null };
  const candles = history.concat([breakoutCandle]);
  const result = patternEngine.evaluate({ candles, params: p, positionContext: null });
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.metadata.volumeNote, 'volume_data_unavailable');
});

test('DEFAULT_RULESET_V1 is registered', () => {
  assert.ok(patternEngine.RULESET_EVALUATORS[DEFAULT_RULESET_V1]);
});

test('evaluate() is deterministic for identical inputs', () => {
  const p = params({ breakoutLookback: 20 });
  const history = flatHistory(20);
  const breakoutCandle = { timestamp: 20 * 60000, open: 100, close: 110, high: 111, low: 99, volume: null };
  const candles = history.concat([breakoutCandle]);
  const a = patternEngine.evaluate({ candles, params: p, positionContext: null });
  const b = patternEngine.evaluate({ candles, params: p, positionContext: null });
  assert.deepEqual(a, b);
});
