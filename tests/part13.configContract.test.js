'use strict';

/**
 * NOVA TRADE -- PART 13: Client Trading Configuration Foundation.
 *
 * Two groups of tests:
 *  1. Pure-function tests (configContract.js validators, Model001 sizing/
 *     target/candle-metadata logic) — run unconditionally, no DB required.
 *  2. BotManager-level tests (createInstance/updateConfiguration validation,
 *     RUNNING-state guards, backward compatibility of a pre-Part-13 bot
 *     document) — require a real MongoDB and follow the exact same
 *     skip-if-unreachable pattern as tests/integration.test.js.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  validateLevels, validateTargets, validateSizing, validateLeverage, resolveDirectionalTarget,
} = require('../utils/botConfigValidators');

// ---------------------------------------------------------------------
// GROUP 1 — pure-function tests (no DB)
// ---------------------------------------------------------------------

test('PART13 validateLevels: accepts finite positive bottom < top', () => {
  const out = validateLevels({ top: 65000, bottom: 64000 });
  assert.deepEqual(out, { top: 65000, bottom: 64000 });
});

test('PART13 validateLevels: rejects bottom >= top (TEST 3)', () => {
  assert.throws(() => validateLevels({ top: 64000, bottom: 65000 }), /strictly less than/);
  assert.throws(() => validateLevels({ top: 64000, bottom: 64000 }), /strictly less than/);
});

test('PART13 validateLevels: rejects NaN, negative, empty-string values', () => {
  assert.throws(() => validateLevels({ top: NaN, bottom: 1 }));
  assert.throws(() => validateLevels({ top: -100, bottom: -200 }));
  assert.throws(() => validateLevels({ top: '', bottom: 100 }));
});

test('PART13 validateLevels: never silently swaps values', () => {
  // bottom > top must throw, not get flipped into a "valid" pair.
  assert.throws(() => validateLevels({ top: 100, bottom: 200 }));
});

test('PART13 validateLevels: null/undefined input means "not supplied" (no-op)', () => {
  assert.equal(validateLevels(null), null);
  assert.equal(validateLevels(undefined), null);
});

test('PART13 validateTargets: accepts valid, dedupes ordering deterministically (TEST 4)', () => {
  const out = validateTargets([{ price: 66000 }, { price: 65000 }]);
  assert.deepEqual(out, [{ price: 65000 }, { price: 66000 }]);
});

test('PART13 validateTargets: rejects duplicate/NaN/negative/malformed (TEST 5)', () => {
  assert.throws(() => validateTargets([{ price: 65000 }, { price: 65000 }]), /duplicate/);
  assert.throws(() => validateTargets([{ price: NaN }]));
  assert.throws(() => validateTargets([{ price: -1 }]));
  assert.throws(() => validateTargets(['not-a-price']));
});

test('PART13 validateSizing: CAPITAL mode requires no value; LOT mode requires positive value (TEST 7)', () => {
  assert.deepEqual(validateSizing({ mode: 'CAPITAL' }), { mode: 'CAPITAL', value: null });
  assert.deepEqual(validateSizing({ mode: 'LOT', value: 4 }), { mode: 'LOT', value: 4 });
  assert.throws(() => validateSizing({ mode: 'LOT' }));
  assert.throws(() => validateSizing({ mode: 'LOT', value: -1 }));
  assert.throws(() => validateSizing({ mode: 'BOGUS' }));
});

test('PART13 validateLeverage: rejects unsupported leverage (TEST 9)', () => {
  assert.equal(validateLeverage(10, 20), 10);
  assert.throws(() => validateLeverage(50, 20), /between 1 and 20/);
  assert.throws(() => validateLeverage(0, 20));
  assert.throws(() => validateLeverage('nope', 20));
});

test('PART13 resolveDirectionalTarget: LONG picks nearest target above entry (PHASE G)', () => {
  const targets = [{ price: 65000 }, { price: 66000 }, { price: 64000 }];
  assert.equal(resolveDirectionalTarget(targets, 'LONG', 64500), 65000);
});

test('PART13 resolveDirectionalTarget: SHORT picks nearest target below entry (PHASE G)', () => {
  const targets = [{ price: 65000 }, { price: 63000 }, { price: 64000 }];
  assert.equal(resolveDirectionalTarget(targets, 'SHORT', 64500), 64000);
});

test('PART13 resolveDirectionalTarget: no target on the correct side returns null (does not invent one)', () => {
  const targets = [{ price: 63000 }];
  assert.equal(resolveDirectionalTarget(targets, 'LONG', 64500), null);
});
