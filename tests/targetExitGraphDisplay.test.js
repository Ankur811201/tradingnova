const test = require('node:test');
const assert = require('node:assert/strict');
const markers = require('../public/js/execution-markers');

test('target graph displays only TARGET_EXIT, never touch/confirmation', () => {
  assert.equal(markers.makeTargetMarker({ type: 'TARGET_TOUCHED', targetIndex: 1, candleStart: Date.now(), price: 100 }, 'LONG'), null);
  assert.equal(markers.makeTargetMarker({ type: 'TARGET_CONFIRMATION', stage: 'CT1', targetIndex: 1, candleStart: Date.now(), price: 100 }, 'LONG'), null);
  const m = markers.makeTargetMarker({ type: 'TARGET_EXIT', targetIndex: 1, candleStart: Date.now(), price: 100, quantity: 0.001 }, 'LONG');
  assert.ok(m);
  assert.equal(m.text, 'T1 EXIT · 1 LOT');
});

test('target graph lot label uses max 2 decimals and rounds up', () => {
  const m = markers.makeTargetMarker({ type: 'TARGET_EXIT', targetIndex: 2, candleStart: Date.now(), price: 100, quantity: 0.001234 }, 'SHORT');
  assert.equal(m.text, 'T2 EXIT · 1.24 LOT');
});
