'use strict';

/**
 * NOVA TRADE -- PART 13.1: Full Pipeline Audit, Bug Fixing & Stability
 * Hardening. Regression tests for the two real (non-obsolete-spec) bugs
 * found during this audit:
 *
 *  1. PHASE D — an existing bot with a missing/invalid timeframe could
 *     silently start and run as if it were configured for '5m', because
 *     validateAndMergeParameters() (bot-models/model-001/validators.js)
 *     merged a hardcoded `timeframe: '5m'` default over any missing value.
 *     Fixed by removing that default entirely: timeframe is now an
 *     identity-defining field that must already be explicit by the time
 *     onStart() reaches the validator. A deliberate '5m' default is
 *     chosen exactly once, at creation time, in
 *     BotManager.createInstance() -- covered by the DB-backed group in
 *     tests/part13.configContract.test.js (TEST 2).
 *
 *  2. PHASE F — BotInstance.configVersion had `default: 2` in the Mongoose
 *     schema. Mongoose applies `default` to ANY hydrated document whose
 *     stored field is undefined, not only to newly-created ones, so a
 *     pre-Part-13 document that never persisted configVersion would read
 *     back as 2 (falsely claiming migration) the moment it was loaded
 *     through a non-.lean() query. Fixed by removing the schema default;
 *     BotManager.createInstance still explicitly writes configVersion: 2
 *     for every new instance.
 *
 * These are pure, no-DB tests (mirroring the "Group 1" pattern already
 * used in tests/part13.configContract.test.js) so they run unconditionally
 * in any environment, including one with no MongoDB available.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAndMergeParameters } = require('../bot-models/model-001/validators');
const BotInstance = require('../models/BotInstance');

// ---------------------------------------------------------------------
// PHASE D — timeframe must never be silently guessed
// ---------------------------------------------------------------------

test('PART13.1 TEST 1/32: missing timeframe is rejected, never silently defaulted to 5m', () => {
  // Simulates a pre-Part-13/pre-this-fix persisted bot: parameters object
  // with everything else set, but no timeframe key at all.
  assert.throws(
    () => validateAndMergeParameters({ historySize: 100, topLevel: 65000, bottomLevel: 64000 }),
    /no configured timeframe/i,
  );
});

test('PART13.1 TEST 1: explicit null/empty-string timeframe is also rejected, not defaulted', () => {
  assert.throws(() => validateAndMergeParameters({ timeframe: null }), /no configured timeframe/i);
  assert.throws(() => validateAndMergeParameters({ timeframe: '' }), /no configured timeframe/i);
});

test('PART13.1 TEST 3: an explicitly invalid timeframe is still rejected with a clear message (unchanged behavior)', () => {
  assert.throws(
    () => validateAndMergeParameters({ timeframe: '4h' }),
    /Invalid timeframe: 4h/,
  );
});

test('PART13.1: a bot with a real, explicit, supported timeframe starts normally (no regression)', () => {
  const params = validateAndMergeParameters({ timeframe: '5m', historySize: 100 });
  assert.equal(params.timeframe, '5m');
});

test('PART13.1: DEFAULT_RULESET-era "timeframe" default no longer exists in validators.js defaults', () => {
  // Guards against someone re-adding `timeframe: '5m'` to the defaults
  // object directly (as opposed to the explicit missing-value check),
  // which would silently reopen this bug.
  const path = require('path');
  const fs = require('fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot-models', 'model-001', 'validators.js'),
    'utf8',
  );
  assert.doesNotMatch(src, /timeframe:\s*'5m'/);
});

// ---------------------------------------------------------------------
// PHASE F — configVersion must represent reality
// ---------------------------------------------------------------------

test('PART13.1 TEST 5: configVersion has no schema default (does not falsely claim migration)', () => {
  // `new Model()` applies schema defaults exactly the same way loading an
  // existing document with a missing field would (both are "the stored
  // value is undefined" from Mongoose's point of view) -- this does not
  // require a DB connection.
  const doc = new BotInstance({
    instanceId: 'test_only_never_saved',
    user: new (require('mongoose').Types.ObjectId)(),
    name: 'Test',
    modelId: 'MODEL_001',
    modelVersion: '1.0.0',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    capitalAllocation: 100,
    // configVersion intentionally omitted, exactly like a pre-Part-13 doc.
  });
  assert.equal(doc.configVersion, undefined);
});

test('PART13.1: a NEW instance can still explicitly be constructed with configVersion 2 (unchanged capability)', () => {
  const doc = new BotInstance({
    instanceId: 'test_only_never_saved_2',
    user: new (require('mongoose').Types.ObjectId)(),
    name: 'Test',
    modelId: 'MODEL_001',
    modelVersion: '1.0.0',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    capitalAllocation: 100,
    configVersion: 2,
  });
  assert.equal(doc.configVersion, 2);
});
