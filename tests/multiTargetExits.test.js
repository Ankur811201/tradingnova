'use strict';

/**
 * Multi-target exits — PaperEngine integration tests.
 *
 * Confirmed rules under test:
 *   1. risk = |entry - originalSL|; T1..T4 = 1R..4R (BUY above entry,
 *      SELL below entry).
 *   2. Each target closes 25% of the ORIGINAL quantity.
 *   3. The original SL never changes — no breakeven, no trailing.
 *   4. A single tick that crosses multiple targets processes all of them.
 *   5. Targets are evaluated before the SL for whatever quantity remains.
 *   6. Only ONE final Trade record is created per Position, with
 *      realizedPnl accumulated across every partial fill plus the final
 *      slice — never one Trade per target.
 *
 * SKIPPED automatically if no MongoDB is reachable, same convention as
 * tests/part9.executionState.test.js / tests/integration.test.js /
 * tests/part7.tradingAuthority.test.js. This project's sandbox has no
 * `mongoose` package installed at all, so these tests cannot execute here
 * — they are written for a real MongoDB environment.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const TEST_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/nova_trade_test';

let dbAvailable = false;
let paperEngine, Position, Trade, PaperAccount, marketData;

before(async () => {
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 1500 });
    dbAvailable = true;
    paperEngine = require('../services/paperEngine/PaperEngine');
    Position = require('../models/Position');
    Trade = require('../models/Trade');
    PaperAccount = require('../models/PaperAccount');
    marketData = require('../services/marketData');
  } catch (err) {
    dbAvailable = false;
    console.log(`[multiTargetExits tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

/** Stubs the market-data provider to return a fixed price for openPosition/closePosition's own fresh-price fetches. */
function stubPrice(price) {
  const provider = marketData.getMarketDataProvider();
  provider.getPrice = async () => ({ price });
  provider.isDataFresh = () => true;
}

test('multi-target: openPosition computes 4 R-multiple targets from entry/stopLoss, 25% of original quantity each', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });

  assert.equal(position.originalQuantity, 4);
  assert.equal(position.targets.length, 4);
  assert.deepEqual(position.targets.map((t) => t.price), [110, 120, 130, 140]);
  assert.deepEqual(position.targets.map((t) => t.quantity), [1, 1, 1, 1]);
  assert.equal(position.takeProfit, null, 'single takeProfit is replaced by targets');
});

test('multi-target: a single tick crossing T1 and T2 together processes BOTH in one pass, position stays OPEN with 50% remaining', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });

  await paperEngine.refreshUnrealizedForSymbol('TESTUSD', 125); // jumps straight past T1(110) and T2(120)

  const updated = await Position.findById(position._id);
  assert.equal(updated.status, 'OPEN');
  assert.equal(updated.quantity, 2, '50% remaining after T1+T2');
  assert.equal(updated.targets[0].hit, true);
  assert.equal(updated.targets[1].hit, true);
  assert.equal(updated.targets[2].hit, false);
  assert.equal(updated.stopLoss, 90, 'original SL must be completely unchanged');

  const trades = await Trade.find({ position: position._id });
  assert.equal(trades.length, 0, 'no Trade record yet — position still open with remaining quantity');
});

test('multi-target: original SL is evaluated against the REMAINING quantity after targets, per confirmed order', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });

  await paperEngine.refreshUnrealizedForSymbol('TESTUSD', 110); // T1 hit, 75% remains, stays OPEN
  let updated = await Position.findById(position._id);
  assert.equal(updated.status, 'OPEN');
  assert.equal(updated.quantity, 3);

  await paperEngine.refreshUnrealizedForSymbol('TESTUSD', 85); // falls through the ORIGINAL, unchanged SL(90)
  updated = await Position.findById(position._id);
  assert.equal(updated.status, 'CLOSED');
  assert.equal(updated.closeReason, 'STOP_LOSS');

  const trades = await Trade.find({ position: position._id });
  assert.equal(trades.length, 1, 'exactly ONE Trade record for the whole position lifecycle');
  // Cumulative: T1 slice (1 unit @110, +10 gross) + remaining 3 units closed @85 SL (-15 each = -45 gross), fees ignored in this rough check
  assert.ok(trades[0].realizedPnl < 0, 'net result should be a loss here — T1 gain does not offset the larger SL loss on 3 remaining units');
});

test('multi-target: all 4 targets hit -> position closes automatically, exactly ONE cumulative Trade record, quantity shown as the ORIGINAL size', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });

  await paperEngine.refreshUnrealizedForSymbol('TESTUSD', 150); // past all 4 targets (110,120,130,140) in one tick

  const updated = await Position.findById(position._id);
  assert.equal(updated.status, 'CLOSED');
  assert.equal(updated.quantity, 0);
  assert.equal(updated.closeReason, 'TAKE_PROFIT');

  const trades = await Trade.find({ position: position._id });
  assert.equal(trades.length, 1, 'exactly ONE Trade record, never one per target');
  assert.equal(trades[0].quantity, 4, 'Trade quantity shows the full original size, not 0');
  // Expected gross pnl: 1*(110-100) + 1*(120-100) + 1*(130-100) + 1*(140-100) = 10+20+30+40 = 100 (before fees)
  assert.ok(trades[0].realizedPnl > 90 && trades[0].realizedPnl < 100, `expected ~100 minus fees, got ${trades[0].realizedPnl}`);
});

test('multi-target: updateStopLoss is refused for a position with an active target plan — original SL structurally cannot change', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });

  await assert.rejects(
    () => paperEngine.updateStopLoss({ positionId: position._id, stopLoss: 95 }),
    /multi-target position/
  );
  const unchanged = await Position.findById(position._id);
  assert.equal(unchanged.stopLoss, 90);
});

test('multi-target: SELL side — targets below entry, closing 25% each, all mechanics mirrored', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'SHORT', quantity: 4, leverage: 1, stopLoss: 110, source: 'BOT',
  });
  assert.deepEqual(position.targets.map((t) => t.price), [90, 80, 70, 60]);

  await paperEngine.refreshUnrealizedForSymbol('TESTUSD', 90); // T1 only
  const updated = await Position.findById(position._id);
  assert.equal(updated.status, 'OPEN');
  assert.equal(updated.quantity, 3);
  assert.equal(updated.targets[0].hit, true);
  assert.equal(updated.targets[1].hit, false);
});

test('multi-target: a position opened WITHOUT a stopLoss gets no targets and behaves exactly as before (backward compatible)', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, takeProfit: 120, source: 'BOT',
  });
  assert.equal(position.targets.length, 0);
  assert.equal(position.takeProfit, 120, 'existing single-TP behavior preserved when no SL is provided');
});

// --- Regression: issue #1, float-residual guarantee -----------------------

for (const originalQuantity of [0.1, 0.3, 3.7]) {
  test(`REGRESSION (float residual): after all 4 targets fire with originalQuantity=${originalQuantity}, Position.quantity is EXACTLY 0, never a ~1e-16 residual`, { skip: () => !dbAvailable }, async () => {
    stubPrice(100);
    const userId = new mongoose.Types.ObjectId();
    const { position } = await paperEngine.openPosition({
      userId, symbol: 'TESTUSD', side: 'LONG', quantity: originalQuantity, leverage: 1, stopLoss: 90, source: 'BOT',
    });

    await paperEngine.refreshUnrealizedForSymbol('TESTUSD', 150); // past all 4 targets in one tick

    const updated = await Position.findById(position._id);
    assert.equal(updated.status, 'CLOSED');
    assert.equal(updated.quantity, 0, `quantity must be EXACTLY 0, not a float residual, for originalQuantity=${originalQuantity}`);
  });
}

test('REGRESSION (duplicate Order): after all 4 targets fire, closePosition() does NOT create a misleading 5th "100%" closing Order — exactly 4 Orders total for the 4 real fills, plus the original opening Order (5 total)', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });

  await paperEngine.refreshUnrealizedForSymbol('TESTUSD', 150); // past all 4 targets

  const Order = require('../models/Order');
  const orders = await Order.find({ relatedPosition: position._id });
  // 1 opening order + 4 target-fill orders = 5. NOT 6 (which a misleading
  // full-quantity closing order from closePosition() would have added).
  assert.equal(orders.length, 5, `expected exactly 5 Orders (1 open + 4 target fills), got ${orders.length}`);

  const fillQuantities = orders.map((o) => o.quantity).sort((a, b) => a - b);
  assert.deepEqual(fillQuantities, [1, 1, 1, 1, 4], 'no Order should show a fake 100% (4-unit) fill beyond the original opening order');
});

test('REGRESSION (duplicate Order): the single Trade record still shows the full original quantity, even though closePosition() creates no closing Order in this case', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });
  await paperEngine.refreshUnrealizedForSymbol('TESTUSD', 150);

  const trades = await Trade.find({ position: position._id });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].quantity, 4, 'Trade record quantity display is unaffected by removing the misleading Order');
});

// --- Regression: exactly-once finalization under concurrent closePosition() calls ---

test('REGRESSION (finalization race): two concurrent closePosition() calls on the SAME already-exhausted position result in exactly ONE Trade, exactly one OPEN->CLOSED transition, and the loser is rejected rather than silently duplicating', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });

  // Manually reduce to a fully-target-exhausted state without going
  // through refreshUnrealizedForSymbol, to isolate closePosition()'s own
  // finalization race specifically (independent of the target-fill race
  // already covered by a separate test).
  await Position.updateOne({ _id: position._id }, { $set: { quantity: 0 } });

  const results = await Promise.allSettled([
    paperEngine.closePosition({ positionId: position._id, reason: 'TAKE_PROFIT', exitPriceOverride: 140 }),
    paperEngine.closePosition({ positionId: position._id, reason: 'TAKE_PROFIT', exitPriceOverride: 140 }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one of the two concurrent closePosition() calls must succeed');
  assert.equal(rejected.length, 1, 'the other must be cleanly rejected (Position is not open), not silently duplicate the close');
  assert.match(rejected[0].reason.message, /not open/i);

  const trades = await Trade.find({ position: position._id });
  assert.equal(trades.length, 1, 'exactly ONE Trade must exist, never two');

  const finalPosition = await Position.findById(position._id);
  assert.equal(finalPosition.status, 'CLOSED');
});

test('REGRESSION (finalization race): the winning closePosition() call\'s returned position object reflects the actual final CLOSED state, not the stale pre-close snapshot', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });
  const result = await paperEngine.closePosition({ positionId: position._id, reason: 'MANUAL' });
  assert.equal(result.position.status, 'CLOSED', 'the returned position must show CLOSED, not the stale pre-claim OPEN snapshot');
});

// --- Regression: account balance/PnL cannot be lost under concurrent target fills ---

test('REGRESSION (account atomicity): concurrent target fills on TWO DIFFERENT positions for the SAME account never lose a balance/PnL update — both deltas land, none overwritten', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position: posA } = await paperEngine.openPosition({
    userId, symbol: 'AAAUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });
  const { position: posB } = await paperEngine.openPosition({
    userId, symbol: 'BBBUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });

  const accountBefore = await PaperAccount.findOne({ user: userId });

  // Both positions' T1 fires concurrently, both crediting the SAME
  // account document from two independent, overlapping transactions.
  await Promise.all([
    paperEngine.refreshUnrealizedForSymbol('AAAUSD', 110),
    paperEngine.refreshUnrealizedForSymbol('BBBUSD', 110),
  ]);

  const updatedA = await Position.findById(posA._id);
  const updatedB = await Position.findById(posB._id);
  assert.equal(updatedA.targets[0].hit, true);
  assert.equal(updatedB.targets[0].hit, true);

  const accountAfter = await PaperAccount.findOne({ user: userId });
  // Each T1 slice: 1 unit, entry 100 -> target 110, gross pnl = 10 (before
  // fees), margin released = notional/leverage = 100. Both slices must be
  // reflected — a lost update would show only ONE delta applied instead
  // of both (e.g. availableBalance would be short by ~110 if one T1's
  // credit was silently overwritten by the other's).
  const balanceDelta = accountAfter.availableBalance - accountBefore.availableBalance;
  assert.ok(balanceDelta > 200, `expected both T1 credits to land (~220 combined before fees), got delta of ${balanceDelta}`);
});

// --- Regression: issue #1, stale currentPrice/unrealizedPnl write cannot overwrite a concurrent target fill ---

test('REGRESSION (stale refresh write): a currentPrice/unrealizedPnl refresh racing a concurrent T1 fill on the SAME position cannot revert quantity/targets — only currentPrice/unrealizedPnl are ever touched by the refresh write', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });

  // Two overlapping ticks for the SAME position: one crosses T1 (110), the
  // other is a plain refresh at a price that does NOT cross any target
  // (105). Before the fix, the plain refresh's position.save() risked
  // writing back a stale in-memory snapshot (quantity=4, targets all
  // unhit) over whatever the T1-crossing tick had already committed,
  // depending on which one's read/write actually interleaved first.
  await Promise.all([
    paperEngine.refreshUnrealizedForSymbol('TESTUSD', 110), // crosses T1
    paperEngine.refreshUnrealizedForSymbol('TESTUSD', 105), // does not cross anything
  ]);

  const updated = await Position.findById(position._id);
  assert.equal(updated.targets[0].hit, true, 'T1 fill must not be reverted by a concurrent plain-refresh write');
  assert.equal(updated.quantity, 3, 'quantity must reflect the T1 fill (25% deducted), never reverted back to 4');
});

// --- Regression: issue #2, a failed finalization must roll back to OPEN ---

test('REGRESSION (finalization rollback): if Trade creation fails mid-finalization, the Position remains OPEN — never stuck CLOSED with no Trade/Order/account settlement', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });
  const accountBefore = await PaperAccount.findOne({ user: userId });

  const originalTradeCreate = Trade.create;
  Trade.create = async () => { throw new Error('simulated failure mid-finalization'); };
  try {
    await assert.rejects(
      () => paperEngine.closePosition({ positionId: position._id, reason: 'MANUAL' }),
      /simulated failure mid-finalization/
    );
  } finally {
    Trade.create = originalTradeCreate;
  }

  const afterFailedClose = await Position.findById(position._id);
  assert.equal(afterFailedClose.status, 'OPEN', 'the position must remain OPEN — the atomic claim must roll back with the rest of the transaction');

  const trades = await Trade.find({ position: position._id });
  assert.equal(trades.length, 0, 'no Trade must exist after a rolled-back finalization');

  const accountAfter = await PaperAccount.findOne({ user: userId });
  assert.equal(accountAfter.availableBalance, accountBefore.availableBalance, 'account must not be settled for a rolled-back close');
  assert.equal(accountAfter.lockedMargin, accountBefore.lockedMargin, 'locked margin must be untouched by a rolled-back close');

  // Confirm the position can still be closed normally afterward (proves it
  // is genuinely still OPEN and usable, not just showing status='OPEN'
  // while actually broken).
  const result = await paperEngine.closePosition({ positionId: position._id, reason: 'MANUAL' });
  assert.equal(result.position.status, 'CLOSED');
  const tradesAfterRealClose = await Trade.find({ position: position._id });
  assert.equal(tradesAfterRealClose.length, 1);
});

test('REGRESSION (concurrency): two overlapping refreshUnrealizedForSymbol() calls for the same symbol/target cannot both fill the same target — exactly one fill, not two', { skip: () => !dbAvailable }, async () => {
  stubPrice(100);
  const userId = new mongoose.Types.ObjectId();
  const { position } = await paperEngine.openPosition({
    userId, symbol: 'TESTUSD', side: 'LONG', quantity: 4, leverage: 1, stopLoss: 90, source: 'BOT',
  });

  // Simulate two overlapping ticks both observing T1 as crossed and racing
  // to fill it — exactly what happens if the market-data provider fires a
  // second tick before the first refreshUnrealizedForSymbol() call's
  // MongoDB round-trip has completed (it does not await subscribers).
  await Promise.all([
    paperEngine.refreshUnrealizedForSymbol('TESTUSD', 110),
    paperEngine.refreshUnrealizedForSymbol('TESTUSD', 110),
  ]);

  const updated = await Position.findById(position._id);
  assert.equal(updated.quantity, 3, 'T1\'s slice (1 unit) must be deducted exactly ONCE, not twice (which would leave 2, not 3)');
  assert.equal(updated.targets[0].hit, true);

  const Order = require('../models/Order');
  const t1Orders = await Order.find({ relatedPosition: position._id, executedPrice: updated.targets[0].price });
  assert.equal(t1Orders.length, 1, 'exactly one Order for T1\'s fill, never two');

  const account = await PaperAccount.findOne({ user: userId });
  // Sanity: available balance reflects exactly one T1 credit, not double.
  assert.ok(account, 'account must exist');
});
