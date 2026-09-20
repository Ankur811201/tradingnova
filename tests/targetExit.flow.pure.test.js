'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const TF = 60_000;
const stageFor = (touchCandle, closedCandle) => {
  const count = Math.floor((closedCandle - touchCandle) / TF) + 1;
  return count >= 1 && count <= 3 ? `CT${count}` : null;
};
const crossed = (side, price, target, previous) =>
  side === 'LONG' ? previous < target && price >= target : previous > target && price <= target;

test('target flow: touch candle -> CT1 -> CT2 -> CT3', () => {
  const touch = 120_000;
  assert.equal(stageFor(touch, 120_000), 'CT1');
  assert.equal(stageFor(touch, 180_000), 'CT2');
  assert.equal(stageFor(touch, 240_000), 'CT3');
  assert.equal(stageFor(touch, 300_000), null);
});

test('target flow: targets are independent', () => {
  const t1 = 120_000;
  const t2 = 180_000;
  assert.equal(stageFor(t1, 240_000), 'CT3');
  assert.equal(stageFor(t2, 240_000), 'CT2');
  assert.equal(stageFor(t2, 300_000), 'CT3');
});

test('target flow: crossing is directional and only a new crossing', () => {
  assert.equal(crossed('LONG', 110, 110, 109), true);
  assert.equal(crossed('LONG', 111, 110, 110), false);
  assert.equal(crossed('SHORT', 90, 95, 96), true);
  assert.equal(crossed('SHORT', 89, 95, 95), false);
});
