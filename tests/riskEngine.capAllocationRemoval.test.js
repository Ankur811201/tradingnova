'use strict';

/**
 * RiskEngine — capital-allocation notional cap REMOVAL test.
 *
 * RiskEngine previously rejected LONG/SHORT commands whenever
 * `allocatedNotional + notional > instance.capitalAllocation` — a
 * capital-based position-value ceiling that didn't even factor in
 * leverage (the strictest form of the removed maximum-capital x leverage
 * cap). That block has been removed.
 *
 * This environment ships without node_modules (mongoose/dotenv not
 * installed, network disabled), so instead of a real MongoDB connection
 * this test injects lightweight fakes directly into Node's require cache
 * for RiskEngine's model/config/provider dependencies — RiskEngine.js
 * itself is required and executed completely unmodified.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

function fakeModule(relPathFromHere, exportsObj) {
  const id = require.resolve(relPathFromHere);
  const mod = new Module(id, module);
  mod.filename = id;
  mod.loaded = true;
  mod.exports = exportsObj;
  require.cache[id] = mod;
  return id;
}

// --- Install fakes for every dependency RiskEngine.js requires, BEFORE
// requiring RiskEngine itself, so the real (mongoose/dotenv-based) files
// are never loaded. -----------------------------------------------------

const fakeEnv = {
  RISK_MAX_LEVERAGE: 20,
  RISK_MAX_POSITION_SIZE_USD: 100000,
  RISK_MAX_DAILY_LOSS_USD: 5000,
  RISK_ALLOWED_SYMBOLS: ['BTCUSD', 'ETHUSD'],
  RISK_DUPLICATE_SIGNAL_WINDOW_MS: 5000,
  PAPER_TAKER_FEE_RATE: 0.0005,
  LIVE_TRADING_DEFAULT_ENABLED: false,
};
fakeModule('../config/env.js', { env: fakeEnv });

let fakeInstance = null;
fakeModule('../models/BotInstance.js', { findOne: async () => fakeInstance });

let fakeOpenPosition = null; // set per-test to simulate an already-open position
fakeModule('../models/Position.js', {
  findOne: async () => fakeOpenPosition,
  find: async () => [],
});

let fakePaperAccount = { availableBalance: 1_000_000_000 };
fakeModule('../models/PaperAccount.js', { findOne: async () => fakePaperAccount });

const riskEventsLogged = [];
fakeModule('../models/RiskEvent.js', { create: async (doc) => { riskEventsLogged.push(doc); return doc; } });

fakeModule('../models/SystemSetting.js', { getSingleton: async (fallback) => ({ liveTradingEnabled: fallback }) });

// RiskEngine's daily-loss check lazily requires('../../models/Trade') inside
// _computeInstanceDailyLoss — must be faked too, or any LONG/SHORT command
// that reaches step 11 throws MODULE_NOT_FOUND in this dependency-free sandbox.
fakeModule('../models/Trade.js', { find: async () => [] });

let fakePrice = 60000;
fakeModule('../services/marketData/index.js', {
  getMarketDataProvider: () => ({
    getConnectionStatus: () => ({ connected: true, configured: true }),
    isDataFresh: () => true,
    getPrice: async () => ({ price: fakePrice }),
  }),
});

fakeModule('../utils/logger.js', {
  info: async () => {}, warn: async () => {}, error: async () => {},
});

// pnl.js and duplicateSignalDetector.js are pure, dependency-free — load for real.
const RiskEngine = require('../services/riskEngine/RiskEngine');

function makeInstance(overrides) {
  return Object.assign({
    instanceId: 'inst1', status: 'RUNNING', environment: 'PAPER', symbol: 'BTCUSD',
    leverage: 2, capitalAllocation: 100, user: 'user1', riskSettings: {},
  }, overrides);
}

function makeCommand(overrides) {
  return Object.assign({
    commandId: `cmd-${Math.random()}`, instanceId: 'inst1', symbol: 'BTCUSD',
    environment: 'PAPER', action: 'LONG', quantity: 10, stopLoss: 59000,
  }, overrides);
}

test('CAP REMOVAL: RiskEngine no longer rejects a trade whose notional vastly exceeds capitalAllocation (with or without leverage applied)', async () => {
  fakeInstance = makeInstance({ capitalAllocation: 100, leverage: 2 }); // old cap would have been 200
  fakeOpenPosition = null;
  fakePrice = 60000; // notional = 60000 * 1 = 60,000 — 300x the old capitalAllocation(200), still under the unrelated global RISK_MAX_POSITION_SIZE_USD(100,000)

  const result = await RiskEngine.evaluate(makeCommand({ quantity: 1 }));

  assert.equal(result.approved, true, `expected approval, got rejection: ${result.reason}`);
  assert.equal(result.metadata.notional, 60000);
});

test('CAP REMOVAL: same result even with leverage=1 and tiny capitalAllocation', async () => {
  fakeInstance = makeInstance({ capitalAllocation: 1, leverage: 1 });
  fakeOpenPosition = null;
  fakePrice = 60000;

  const result = await RiskEngine.evaluate(makeCommand({ quantity: 1 }));
  assert.equal(result.approved, true, `expected approval, got rejection: ${result.reason}`);
});

test('unrelated protections still work: RISK_MAX_POSITION_SIZE_USD global notional cap still rejects (this is NOT the removed cap)', async () => {
  fakeInstance = makeInstance({ capitalAllocation: 100000, leverage: 20 }); // plenty of "capital"
  fakeOpenPosition = null;
  fakePrice = 60000; // notional = 60000 * 10 = 600,000 > RISK_MAX_POSITION_SIZE_USD (100,000)

  const result = await RiskEngine.evaluate(makeCommand({ quantity: 10 }));
  assert.equal(result.approved, false);
  assert.match(result.reason, /exceeds global max position size/);
});

test('unrelated protections still work: invalid/zero quantity still rejected', async () => {
  fakeInstance = makeInstance();
  fakeOpenPosition = null;
  const result = await RiskEngine.evaluate(makeCommand({ quantity: 0 }));
  assert.equal(result.approved, false);
  assert.match(result.reason, /Invalid quantity/);
});

test('unrelated protections still work: duplicate open position of the same side still rejected', async () => {
  fakeInstance = makeInstance();
  fakeOpenPosition = { side: 'LONG' };
  fakePrice = 60000;
  const result = await RiskEngine.evaluate(makeCommand({ action: 'LONG', quantity: 1 }));
  assert.equal(result.approved, false);
  assert.match(result.reason, /already exists/);
});

test('unrelated protections still work: leverage above global RISK_MAX_LEVERAGE still rejected', async () => {
  fakeInstance = makeInstance({ leverage: 999 });
  fakeOpenPosition = null;
  const result = await RiskEngine.evaluate(makeCommand({ quantity: 1 }));
  assert.equal(result.approved, false);
  assert.match(result.reason, /exceeds global max/);
});
