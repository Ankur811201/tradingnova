'use strict';

/**
 * Integration tests exercising RiskEngine + PaperEngine + ExecutionRouter
 * end-to-end against a real (local/test) MongoDB instance.
 *
 * These are automatically SKIPPED if no MongoDB is reachable at
 * MONGODB_URI (default mongodb://127.0.0.1:27017/nova_trade_test) within
 * a short timeout, so `npm test` still passes in environments without a
 * database (e.g. this sandbox). To run them for real:
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017/nova_trade_test npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const TEST_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/nova_trade_test';

let dbAvailable = false;

before(async () => {
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 1500 });
    dbAvailable = true;
  } catch (err) {
    dbAvailable = false;
    console.log(`[integration tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('RiskEngine rejects LONG when market data is stale, PaperEngine LONG/SHORT PnL and duplicate command rejection work end-to-end', async (t) => {
  if (!dbAvailable) {
    t.skip('MongoDB not available in this environment');
    return;
  }

  // Lazy-require after connection so models bind to the active mongoose connection.
  const User = require('../models/User');
  const BotInstance = require('../models/BotInstance');
  const PaperAccount = require('../models/PaperAccount');
  const riskEngine = require('../services/riskEngine/RiskEngine');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const marketData = require('../services/marketData');
  const MockProvider = require('./helpers/mockProvider');

  const mockProvider = new MockProvider();
  marketData._setProviderForTesting(mockProvider);

  const user = await User.create({ username: 'integration_test_user', passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const instance = await BotInstance.create({
    instanceId: 'inst_test_1',
    user: user._id,
    modelId: 'model-001',
    modelVersion: '1.0.0',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    status: 'RUNNING',
    capitalAllocation: 10000,
    leverage: 2,
  });

  // 1. No price set at all yet -> stale/unavailable -> rejected
  const staleResult = await riskEngine.evaluate({
    commandId: 'cmd_stale_1',
    modelId: 'model-001',
    instanceId: instance.instanceId,
    symbol: 'BTCUSD',
    environment: 'PAPER',
    action: 'LONG',
    quantity: 0.1,
  });
  assert.equal(staleResult.approved, false);

  // 2. Set a fresh price -> approved
  mockProvider.setPrice('BTCUSD', 50000, Date.now());
  const approvedResult = await riskEngine.evaluate({
    commandId: 'cmd_ok_1',
    modelId: 'model-001',
    instanceId: instance.instanceId,
    symbol: 'BTCUSD',
    environment: 'PAPER',
    action: 'LONG',
    quantity: 0.1,
  });
  assert.equal(approvedResult.approved, true);

  // 3. Duplicate commandId immediately after -> rejected
  const dupResult = await riskEngine.evaluate({
    commandId: 'cmd_ok_1',
    modelId: 'model-001',
    instanceId: instance.instanceId,
    symbol: 'BTCUSD',
    environment: 'PAPER',
    action: 'LONG',
    quantity: 0.1,
  });
  assert.equal(dupResult.approved, false);
  assert.match(dupResult.reason, /Duplicate/);

  // 4. PaperEngine LONG P&L: open at 50000, price rises to 51000 -> positive PnL
  const { position } = await paperEngine.openPosition({
    userId: user._id, symbol: 'BTCUSD', side: 'LONG', quantity: 0.1, leverage: 2, source: 'MANUAL',
  });
  await paperEngine.refreshUnrealizedForSymbol('BTCUSD', 51000);
  const Position = require('../models/Position');
  const refreshed = await Position.findById(position._id);
  assert.equal(refreshed.unrealizedPnl, (51000 - 50000) * 0.1);

  const closeResult = await paperEngine.closePosition({ positionId: position._id, reason: 'MANUAL' });
  assert.ok(closeResult.realizedPnl > 0, 'LONG position closed in profit should have positive realized PnL');

  // 5. SHORT P&L: open short, price falls -> positive PnL
  mockProvider.setPrice('BTCUSD', 50000, Date.now());
  const shortOpen = await paperEngine.openPosition({
    userId: user._id, symbol: 'BTCUSD', side: 'SHORT', quantity: 0.1, leverage: 2, source: 'MANUAL',
  });
  mockProvider.setPrice('BTCUSD', 49000, Date.now());
  const shortClose = await paperEngine.closePosition({ positionId: shortOpen.position._id, reason: 'MANUAL' });
  assert.ok(shortClose.realizedPnl > 0, 'SHORT position closed after price drop should have positive realized PnL');

  // 6. Environment isolation: a LIVE-environment command against a PAPER instance is rejected
  const envMismatch = await riskEngine.evaluate({
    commandId: 'cmd_env_mismatch',
    modelId: 'model-001',
    instanceId: instance.instanceId,
    symbol: 'BTCUSD',
    environment: 'LIVE',
    action: 'LONG',
    quantity: 0.1,
  });
  assert.equal(envMismatch.approved, false);
  assert.match(envMismatch.reason, /environment/);

  // 7. Insufficient balance is rejected cleanly (no fake fill)
  const account = await PaperAccount.findOne({ user: user._id });
  account.availableBalance = 1; // effectively nothing left
  await account.save();
  await assert.rejects(() =>
    paperEngine.openPosition({ userId: user._id, symbol: 'BTCUSD', side: 'LONG', quantity: 100, leverage: 2, source: 'MANUAL' })
  );
});
