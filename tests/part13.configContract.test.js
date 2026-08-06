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
} = require('../bot-models/model-001/configContract');
const Model001 = require('../bot-models/model-001/Model001');

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

// --- Model001 sizing / target / candle-metadata wiring --------------------

function makeCtx() {
  const ctx = { modelId: 'MODEL_001', modelVersion: '1.0.0', events: [], commands: [] };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => { ctx.commands.push(cmd); return { approved: true }; };
  return ctx;
}

test('PART13 Model001._buildCandleSummary: real bodySize + BULLISH direction (TEST 14)', () => {
  const model = new Model001(makeCtx());
  const summary = model._buildCandleSummary({ timestamp: 1, open: 100, high: 110, low: 95, close: 108 });
  assert.equal(summary.bodySize, 8);
  assert.equal(summary.direction, 'BULLISH');
});

test('PART13 Model001._buildCandleSummary: real bodySize + BEARISH direction (TEST 15)', () => {
  const model = new Model001(makeCtx());
  const summary = model._buildCandleSummary({ timestamp: 1, open: 108, high: 110, low: 95, close: 101 });
  assert.equal(summary.bodySize, 7);
  assert.equal(summary.direction, 'BEARISH');
});

test('PART13 Model001._buildCandleSummary: equal open/close is NEUTRAL, never fabricated', () => {
  const model = new Model001(makeCtx());
  const summary = model._buildCandleSummary({ timestamp: 1, open: 100, high: 105, low: 95, close: 100 });
  assert.equal(summary.bodySize, 0);
  assert.equal(summary.direction, 'NEUTRAL');
});

test('PART13 Model001 onStart: pre-Part-13 instanceConfig (no levels/targets/sizing) does not throw (backward compatibility, TEST 1)', async () => {
  const model = new Model001(makeCtx());
  await model.onStart({
    instanceId: 'inst_legacy',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '5m' },
    capitalAllocation: 100,
    leverage: 1,
    riskSettings: {},
    // levels/targets/sizing intentionally omitted, as a pre-Part-13 caller would
  });
  assert.equal(model.sizing.mode, 'CAPITAL');
  assert.deepEqual(model.targets, []);
  // Legacy hardcoded defaults from validators.js must still apply unchanged.
  assert.equal(model.params.topLevel, 64280);
  assert.equal(model.params.bottomLevel, 64024);
});

test('PART13 Model001 onStart: canonical levels override legacy parameters.topLevel/bottomLevel (PHASE D)', async () => {
  const model = new Model001(makeCtx());
  await model.onStart({
    instanceId: 'inst_levels',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '5m', topLevel: 111, bottomLevel: 99 },
    capitalAllocation: 100,
    leverage: 1,
    riskSettings: {},
    levels: { top: 70000, bottom: 60000 },
    targets: [],
    sizing: { mode: 'CAPITAL', value: null },
  });
  assert.equal(model.params.topLevel, 70000);
  assert.equal(model.params.bottomLevel, 60000);
});

test('PART13 Model001 onStart: falls back to legacy parameters.topLevel/bottomLevel when canonical levels are null (backward compatibility)', async () => {
  const model = new Model001(makeCtx());
  await model.onStart({
    instanceId: 'inst_legacy_levels',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '5m', topLevel: 111, bottomLevel: 99 },
    capitalAllocation: 100,
    leverage: 1,
    riskSettings: {},
    levels: { top: null, bottom: null },
    targets: [],
    sizing: { mode: 'CAPITAL', value: null },
  });
  assert.equal(model.params.topLevel, 111);
  assert.equal(model.params.bottomLevel, 99);
});

test('PART13 Model001._buildTradeCommand: LOT sizing overrides the dynamic lot table quantity (TEST 7 / PHASE H)', async () => {
  const model = new Model001(makeCtx());
  await model.onStart({
    instanceId: 'inst_lot',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '5m' },
    capitalAllocation: 100,
    leverage: 1,
    riskSettings: {},
    levels: { top: null, bottom: null },
    targets: [],
    sizing: { mode: 'LOT', value: 7 },
  });
  const decision = { action: 'LONG', ruleId: 'X', reason: 'test', lot: 999, slBufferPips: 10 };
  const candle = { timestamp: 1, open: 100, high: 105, low: 95, close: 102 };
  const cmd = model._buildTradeCommand(decision, candle);
  assert.equal(cmd.quantity, 7); // NOT 999 (the strategy's own dynamic lot)
});

test('PART13 Model001._buildTradeCommand: CAPITAL mode (default) reproduces exact pre-Part-13 quantity behavior', async () => {
  const model = new Model001(makeCtx());
  await model.onStart({
    instanceId: 'inst_capital',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '5m' },
    capitalAllocation: 100,
    leverage: 1,
    riskSettings: {},
  });
  const decision = { action: 'LONG', ruleId: 'X', reason: 'test', lot: 6, slBufferPips: 10 };
  const candle = { timestamp: 1, open: 100, high: 105, low: 95, close: 102 };
  const cmd = model._buildTradeCommand(decision, candle);
  assert.equal(cmd.quantity, 6);
});

test('PART13 Model001._buildTradeCommand: attaches nearest direction-valid target as takeProfit (PHASE F/G/S)', async () => {
  const model = new Model001(makeCtx());
  await model.onStart({
    instanceId: 'inst_target',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '5m' },
    capitalAllocation: 100,
    leverage: 1,
    riskSettings: {},
    targets: [{ price: 65000 }, { price: 66000 }],
  });
  const decision = { action: 'LONG', ruleId: 'X', reason: 'test', lot: 1, slBufferPips: 10 };
  const candle = { timestamp: 1, open: 64000, high: 64100, low: 63900, close: 64050 };
  const cmd = model._buildTradeCommand(decision, candle);
  assert.equal(cmd.takeProfit, 65000);
});

test('PART13 Model001._buildTradeCommand: no valid directional target -> takeProfit stays null (never fabricated, PHASE G)', async () => {
  const model = new Model001(makeCtx());
  await model.onStart({
    instanceId: 'inst_target_invalid',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '5m' },
    capitalAllocation: 100,
    leverage: 1,
    riskSettings: {},
    targets: [{ price: 60000 }], // below entry -> invalid for LONG
  });
  const decision = { action: 'LONG', ruleId: 'X', reason: 'test', lot: 1, slBufferPips: 10 };
  const candle = { timestamp: 1, open: 64000, high: 64100, low: 63900, close: 64050 };
  const cmd = model._buildTradeCommand(decision, candle);
  assert.equal(cmd.takeProfit, null);
});

test('PART13 Model001._emitDecision: DECISION payload carries real candle body/direction + configured levels/targets (PHASE U)', async () => {
  const ctx = makeCtx();
  const model = new Model001(ctx);
  await model.onStart({
    instanceId: 'inst_decision',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: { timeframe: '5m' },
    capitalAllocation: 100,
    leverage: 1,
    riskSettings: {},
    levels: { top: 70000, bottom: 60000 },
    targets: [{ price: 71000 }],
  });
  const candle = { timestamp: 123, open: 100, high: 110, low: 95, close: 108 };
  model._emitDecision({ action: 'NO_ACTION', reason: 'no_level_touch', analysis: null }, candle);
  const decisionEvent = ctx.events.find((e) => e.eventType === 'DECISION');
  assert.ok(decisionEvent, 'DECISION event should have been emitted');
  assert.equal(decisionEvent.payload.candle.bodySize, 8);
  assert.equal(decisionEvent.payload.candle.direction, 'BULLISH');
  assert.equal(decisionEvent.payload.levels.top, 70000);
  assert.equal(decisionEvent.payload.levels.bottom, 60000);
  assert.deepEqual(decisionEvent.payload.levels.targets, [71000]);
});

// ---------------------------------------------------------------------
// GROUP 2 — BotManager-level tests (require a real MongoDB; skip cleanly
// if unreachable, exactly like tests/integration.test.js)
// ---------------------------------------------------------------------

const TEST_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/nova_trade_test';
let dbAvailable = false;

before(async () => {
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 1500 });
    }
    dbAvailable = true;
  } catch (err) {
    dbAvailable = false;
    console.log(`[part13 tests] Skipping DB-backed tests: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable && mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('PART13 BotInstance: pre-Part-13 document (no levels/targets/sizing/configVersion) loads with safe schema defaults (TEST 1)', async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not available in this environment'); return; }
  const BotInstance = require('../models/BotInstance');
  const { ObjectId } = mongoose.Types;

  const legacy = await BotInstance.create({
    instanceId: 'legacy_bot_part12',
    user: new ObjectId(),
    name: 'Legacy Bot',
    modelId: 'MODEL_001',
    modelVersion: '1.0.0',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    status: 'STOPPED',
    parameters: { timeframe: '5m' },
    capitalAllocation: 500,
    leverage: 3,
    riskSettings: {},
    // configVersion/sizing/levels/targets intentionally omitted
  });

  const reloaded = await BotInstance.findOne({ instanceId: 'legacy_bot_part12' });
  assert.equal(reloaded.capitalAllocation, 500);
  assert.equal(reloaded.leverage, 3);
  assert.equal(reloaded.sizing.mode, 'CAPITAL');
  assert.equal(reloaded.levels.top, null);
  assert.equal(reloaded.levels.bottom, null);
  assert.deepEqual(reloaded.targets, []);
  await BotInstance.deleteOne({ instanceId: 'legacy_bot_part12' });
});

test('PART13 BotManager.createInstance: rejects leverage above global max (TEST 9)', async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not available in this environment'); return; }
  const botManager = require('../services/botManager/BotManager');
  const User = require('../models/User');
  const BotModelMetadata = require('../models/BotModelMetadata');

  await BotModelMetadata.findOneAndUpdate(
    { modelId: 'MODEL_001' },
    { modelId: 'MODEL_001', name: 'Model 001', version: '1.0.0', isEnabled: true },
    { upsert: true }
  );
  const user = await User.create({ username: `p13-${Date.now()}`, passwordHash: 'x' });

  await assert.rejects(
    botManager.createInstance({
      userId: user._id, name: 'Bad Leverage Bot', modelId: 'MODEL_001', symbol: 'BTCUSD',
      environment: 'PAPER', capitalAllocation: 100, leverage: 9999,
    }),
    /leverage/i
  );
});

test('PART13 BotManager.createInstance: rejects invalid levels (bottom >= top) (TEST 3)', async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not available in this environment'); return; }
  const botManager = require('../services/botManager/BotManager');
  const User = require('../models/User');
  const BotModelMetadata = require('../models/BotModelMetadata');

  await BotModelMetadata.findOneAndUpdate(
    { modelId: 'MODEL_001' },
    { modelId: 'MODEL_001', name: 'Model 001', version: '1.0.0', isEnabled: true },
    { upsert: true }
  );
  const user = await User.create({ username: `p13-${Date.now()}b`, passwordHash: 'x' });

  await assert.rejects(
    botManager.createInstance({
      userId: user._id, name: 'Bad Levels Bot', modelId: 'MODEL_001', symbol: 'BTCUSD',
      environment: 'PAPER', capitalAllocation: 100, leverage: 1,
      levels: { top: 100, bottom: 200 },
    }),
    /levels/i
  );
});

test('PART13 BotManager: valid levels/targets persist and reload identically (TEST 2 / TEST 4)', async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not available in this environment'); return; }
  const botManager = require('../services/botManager/BotManager');
  const BotInstance = require('../models/BotInstance');
  const User = require('../models/User');
  const BotModelMetadata = require('../models/BotModelMetadata');

  await BotModelMetadata.findOneAndUpdate(
    { modelId: 'MODEL_001' },
    { modelId: 'MODEL_001', name: 'Model 001', version: '1.0.0', isEnabled: true },
    { upsert: true }
  );
  const user = await User.create({ username: `p13-${Date.now()}c`, passwordHash: 'x' });

  const created = await botManager.createInstance({
    userId: user._id, name: 'Good Bot', modelId: 'MODEL_001', symbol: 'BTCUSD',
    environment: 'PAPER', capitalAllocation: 100, leverage: 2,
    levels: { top: 70000, bottom: 60000 },
    targets: [{ price: 72000 }, { price: 71000 }],
    sizing: { mode: 'LOT', value: 3 },
  });

  const reloaded = await BotInstance.findOne({ instanceId: created.instanceId });
  assert.equal(reloaded.levels.top, 70000);
  assert.equal(reloaded.levels.bottom, 60000);
  assert.deepEqual(reloaded.targets.map((t) => t.price), [71000, 72000]); // deterministic ascending order
  assert.equal(reloaded.sizing.mode, 'LOT');
  assert.equal(reloaded.sizing.value, 3);
});

test('PART13 BotManager.updateConfiguration: rejects strategy-sensitive changes while RUNNING (TEST 11)', async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not available in this environment'); return; }
  const botManager = require('../services/botManager/BotManager');
  const BotInstance = require('../models/BotInstance');
  const User = require('../models/User');
  const BotModelMetadata = require('../models/BotModelMetadata');

  await BotModelMetadata.findOneAndUpdate(
    { modelId: 'MODEL_001' },
    { modelId: 'MODEL_001', name: 'Model 001', version: '1.0.0', isEnabled: true },
    { upsert: true }
  );
  const user = await User.create({ username: `p13-${Date.now()}d`, passwordHash: 'x' });

  const created = await botManager.createInstance({
    userId: user._id, name: 'Running Bot', modelId: 'MODEL_001', symbol: 'BTCUSD',
    environment: 'PAPER', capitalAllocation: 100, leverage: 1,
  });
  await BotInstance.updateOne({ instanceId: created.instanceId }, { status: 'RUNNING' });

  await assert.rejects(
    botManager.updateConfiguration(created.instanceId, { levels: { top: 100, bottom: 50 } }),
    /RUNNING/
  );
  await assert.rejects(
    botManager.updateConfiguration(created.instanceId, { leverage: 5 }),
    /RUNNING/
  );
  await assert.rejects(
    botManager.updateConfiguration(created.instanceId, { sizing: { mode: 'LOT', value: 2 } }),
    /RUNNING/
  );
  await assert.rejects(
    botManager.updateConfiguration(created.instanceId, { targets: [{ price: 100 }] }),
    /RUNNING/
  );

  // Stop it, then the same changes must succeed.
  await BotInstance.updateOne({ instanceId: created.instanceId }, { status: 'STOPPED' });
  const updated = await botManager.updateConfiguration(created.instanceId, { levels: { top: 100, bottom: 50 } });
  assert.equal(updated.levels.top, 100);
  assert.equal(updated.levels.bottom, 50);
});
