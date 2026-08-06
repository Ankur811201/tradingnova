'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeNotional, computeMargin, computeFee, computePnl } = require('../utils/pnl');

test('computeNotional multiplies price by quantity', () => {
  assert.equal(computeNotional(100, 2), 200);
});

test('computeMargin divides notional by leverage', () => {
  assert.equal(computeMargin(1000, 10), 100);
});

test('computeMargin throws on zero/negative leverage', () => {
  assert.throws(() => computeMargin(1000, 0));
  assert.throws(() => computeMargin(1000, -5));
});

test('computeFee applies fee rate to notional', () => {
  assert.equal(computeFee(1000, 0.0005), 0.5);
});

test('LONG PnL is positive when price rises', () => {
  const pnl = computePnl('LONG', 100, 110, 2);
  assert.equal(pnl, 20); // (110-100)*2
});

test('LONG PnL is negative when price falls', () => {
  const pnl = computePnl('LONG', 100, 90, 2);
  assert.equal(pnl, -20);
});

test('SHORT PnL is positive when price falls', () => {
  const pnl = computePnl('SHORT', 100, 90, 2);
  assert.equal(pnl, 20); // (100-90)*2
});

test('SHORT PnL is negative when price rises', () => {
  const pnl = computePnl('SHORT', 100, 110, 2);
  assert.equal(pnl, -20);
});

test('computePnl throws on unknown side', () => {
  assert.throws(() => computePnl('SIDEWAYS', 100, 110, 1));
});

test('LONG/SHORT PnL are mirror images at same price move', () => {
  const longPnl = computePnl('LONG', 100, 105, 1);
  const shortPnl = computePnl('SHORT', 100, 105, 1);
  assert.equal(longPnl, -shortPnl);
});
