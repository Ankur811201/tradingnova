'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Model002 = require('../bot-models/model-002/Model002');
const { findTouchedLevel } = require('../bot-models/model-002/reversalPatternEngine');

test('a red candle upper wick touching R2 is a valid resistance touch', () => {
  const levels = [81500, 81666, 81750];
  const candle = { open: 81620, high: 81670, low: 81590, close: 81600 };
  assert.deepEqual(findTouchedLevel(levels, candle, 'SELL'), { index: 2, price: 81666 });
});

test('fresh R2 candidate uses R2 safety counter even if most recent remembered touch is R1', () => {
  const context = {
    levelTouch: { resistance: { touched: true, index: 1, level: 81500 } },
  };
  const candidate = {
    direction: 'SELL',
    matchedLevel: { index: 2, price: 81666 },
    carriedForwardLevel: false,
  };
  assert.deepEqual(Model002.prototype._activeLevelFor.call(context, candidate), {
    side: 'RESISTANCE', index: 2, price: 81666,
  });
});

test('carried-forward candidate retains the level it originally matched', () => {
  const context = {
    levelTouch: { resistance: { touched: true, index: 3, level: 81750 } },
  };
  const candidate = {
    direction: 'SELL',
    matchedLevel: { index: 1, price: 81500 },
    carriedForwardLevel: true,
  };
  assert.deepEqual(Model002.prototype._activeLevelFor.call(context, candidate), {
    side: 'RESISTANCE', index: 1, price: 81500,
  });
});
