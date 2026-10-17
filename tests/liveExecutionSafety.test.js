'use strict';

/**
 * LIVE execution safety tests. 100% mock-based: a scriptable fake Delta exchange
 * + in-memory models (tests/helpers/fakeLiveExchange.js). No network, no MongoDB,
 * no credentials, and NO real orders are ever sent.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build, entryParams } = require('./helpers/fakeLiveExchange');
const {
  classifyOrder, PHASE, contractsFromQuantity, quantityFromContracts,
} = require('../services/delta/deltaOrderState');

const rejects = async (p, code) => {
  await assert.rejects(p, (err) => { assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`); return true; });
};

// ---------------------------------------------------------------- pure helpers
test('classifyOrder: only exchange-reported data decides; no fabricated fill price', () => {
  assert.equal(classifyOrder({ size: 10, unfilled_size: 0, state: 'closed', average_fill_price: '63000.5' }).phase, PHASE.FILLED);
  assert.equal(classifyOrder({ size: 10, unfilled_size: 10, state: 'open', average_fill_price: null }).phase, PHASE.OPEN);
  assert.equal(classifyOrder({ size: 10, unfilled_size: 4, state: 'cancelled', average_fill_price: '1' }).phase, PHASE.CANCELLED_PARTIAL);
  assert.equal(classifyOrder({ size: 10, unfilled_size: 10, state: 'cancelled' }).phase, PHASE.CANCELLED_UNFILLED);
  // fills without a price, closed-with-unfilled, bad shapes => UNKNOWN (never assumed)
  assert.equal(classifyOrder({ size: 10, unfilled_size: 0, state: 'closed', average_fill_price: null }).phase, PHASE.UNKNOWN);
  assert.equal(classifyOrder({ size: 10, unfilled_size: 0, state: 'closed', average_fill_price: '0' }).phase, PHASE.UNKNOWN);
  assert.equal(classifyOrder({ size: 10, unfilled_size: 3, state: 'closed', average_fill_price: '5' }).phase, PHASE.UNKNOWN);
  assert.equal(classifyOrder({}).phase, PHASE.UNKNOWN);
  assert.equal(classifyOrder(null).phase, PHASE.UNKNOWN);
});

test('contract conversion: whole contracts only (Delta size is an integer), no silent rounding', () => {
  assert.equal(contractsFromQuantity(0.01, 0.001), 10);
  assert.equal(contractsFromQuantity(0.063, 0.001), 63); // float-safe
  assert.throws(() => contractsFromQuantity(0.0105, 0.001), /whole number of contracts/);
  assert.throws(() => contractsFromQuantity(0.0004, 0.001), /below one contract/);
  assert.equal(quantityFromContracts(3, 0.001), 0.003);
});

// ------------------------------------------------------------------ 1. rejected
test('1. entry order rejected: no position, order REJECTED, nothing protected', async () => {
  const { engine, ex, store } = build();
  ex.script.place.push({ type: 'reject' });
  await rejects(engine.openPosition(entryParams()), 'DELTA_ORDER_FAILED');
  assert.equal(store.Position.rows.length, 0);
  assert.equal(store.Order.rows[0].status, 'REJECTED');
  assert.equal(ex.calls.bracket.length, 0);
});

// ----------------------------------------------------------- 2. accepted, unfilled
test('2. entry accepted but never filled: remainder cancelled, NO position is created', async () => {
  const { engine, ex, store } = build();
  ex.script.place.push({ type: 'nofill' });
  await rejects(engine.openPosition(entryParams()), 'LIVE_ENTRY_NOT_FILLED');
  assert.equal(store.Position.rows.length, 0, 'acceptance must not be treated as a fill');
  assert.equal(ex.calls.cancel.length, 1);
  assert.equal(store.Order.rows[0].status, 'CANCELLED');
  assert.equal(ex.positionContracts, 0);
});

// ----------------------------------------------------------------- 3. partial fill
test('3. partial entry fill: position sized to ACTUAL fill, stop covers actual fill, order PARTIALLY_FILLED', async () => {
  const { engine, ex, store } = build();
  ex.script.place.push({ type: 'fill', filled: 3, price: 63010 });
  const r = await engine.openPosition(entryParams());
  assert.equal(r.position.quantity, 0.003);
  assert.equal(r.position.originalQuantity, 0.003);
  assert.equal(r.position.exchangeContracts, 3);
  assert.equal(r.position.protectionStatus, 'PROTECTED');
  assert.equal(store.Order.rows[0].status, 'PARTIALLY_FILLED');
  assert.equal(store.Order.rows[0].filledContracts, 3);
  assert.equal(ex.stopLegs.length, 1);
  assert.equal(ex.stopLegs[0].size, 3);
});

// ------------------------------------------------- 4. fill at different price
test('4. fill at a different price than expected: entryPrice is the exchange average, never 0 or a guess', async () => {
  const { engine, store } = build({ exchangeOpts: { price: 63000 } });
  const r = await engine.openPosition(entryParams());
  assert.equal(r.position.entryPrice, 63000);
  assert.ok(r.position.entryPrice > 0);
  assert.equal(store.Order.rows[0].executedPrice, 63000);
  assert.equal(store.Order.rows[0].fillVerified, true);
  assert.equal(r.position.quantity, 0.01); // 0.01 BTC -> 10 contracts, not "size 0.01"
  const sent = engine.d.adapter.calls.placeOrder[0];
  assert.equal(sent.size, 10, 'Delta size must be whole contracts (qty / contract_value)');
  assert.equal(sent.reduceOnly, false);
  assert.equal(r.position.protectionStatus, 'PROTECTED');
});

// -------------------------------------------------- 5. timeout after acceptance
test('5. timeout AFTER exchange accepted: found by client_order_id, one position, NO resubmission', async () => {
  const { engine, ex, store } = build();
  ex.script.place.push({ type: 'timeout', fills: true, price: 63123 });
  const r = await engine.openPosition(entryParams());
  assert.equal(ex.calls.placeOrder.length, 1, 'must never blindly resubmit after a timeout');
  assert.equal(r.position.entryPrice, 63123);
  assert.equal(store.Position.rows.length, 1);
  assert.equal(ex.positionContracts, 10);
});

test('5b. timeout and order NOT findable: state UNKNOWN, circuit breaker trips, no resubmit, retry blocked', async () => {
  const { engine, ex, store } = build();
  ex.script.place.push({ type: 'timeout', fills: false });
  await rejects(engine.openPosition(entryParams()), 'LIVE_ORDER_STATE_UNKNOWN');
  assert.equal(ex.calls.placeOrder.length, 1);
  assert.equal(store.Order.rows[0].status, 'UNKNOWN');
  assert.equal(store.SystemSetting.settings.liveTradingEnabled, false);
  await rejects(engine.openPosition(entryParams({ commandId: 'cmd_2' })), 'LIVE_TRADING_DISABLED');
});

// ----------------------------------------------------------- 6. stop-loss problems
test('6. stop-loss placement REJECTED: verified emergency reduce-only close, position CLOSED, exchange flat', async () => {
  const { engine, ex, store, logger } = build();
  ex.script.bracket.push({ type: 'reject' });
  await rejects(engine.openPosition(entryParams()), 'LIVE_PROTECTION_FAILED');
  const pos = store.Position.rows[0];
  assert.equal(pos.status, 'CLOSED');
  assert.equal(pos.closeReason, 'PROTECTION_FAILED_EMERGENCY_CLOSE');
  assert.equal(ex.positionContracts, 0, 'exposure must be verifiably gone');
  const close = ex.calls.placeOrder[1];
  assert.equal(close.reduceOnly, true);
  assert.equal(close.side, 'sell');
  assert.ok(logger.lines.some((l) => l.level === 'error' && /EMERGENCY/.test(l.msg)), 'operator alert logged');
});

test('6b. stop-loss accepted but never appears on the exchange: treated as UNPROTECTED -> emergency close', async () => {
  const { engine, ex, store } = build();
  ex.script.bracket.push({ type: 'silent' }, { type: 'silent' });
  await rejects(engine.openPosition(entryParams()), 'LIVE_PROTECTION_FAILED');
  assert.equal(store.Position.rows[0].status, 'CLOSED');
  assert.equal(ex.positionContracts, 0);
});

test('6c. emergency close ALSO fails: position flagged EMERGENCY, live trading disabled, error surfaced', async () => {
  const { engine, ex, store } = build();
  ex.script.bracket.push({ type: 'reject' });
  ex.script.place.push({ type: 'fill' }, { type: 'reject' }, { type: 'reject' }, { type: 'reject' }); // entry ok, 3 close attempts rejected
  await rejects(engine.openPosition(entryParams()), 'LIVE_PROTECTION_FAILED_UNCLOSED');
  const pos = store.Position.rows[0];
  assert.equal(pos.status, 'OPEN');
  assert.equal(pos.protectionStatus, 'EMERGENCY');
  assert.equal(pos.needsReconciliation, true);
  assert.equal(store.SystemSetting.settings.liveTradingEnabled, false);
  assert.equal(pos.closeInFlight, false);
});

test('6d. stop on the wrong side of entry is never sent to the exchange', async () => {
  const { engine, ex, store } = build();
  await rejects(engine.openPosition(entryParams({ stopLoss: 64000 })), 'LIVE_PROTECTION_FAILED'); // LONG with stop above entry
  assert.equal(ex.calls.bracket.length, 0);
  assert.equal(store.Position.rows[0].status, 'CLOSED');
});

test('7. protective stop partially/externally filled: reconciliation adopts the smaller exchange size and flags it', async () => {
  const { engine, reconciler, ex, store } = build();
  await engine.openPosition(entryParams());
  ex.positionContracts = 4; // exchange stop executed 6 of 10 contracts
  const rep = await reconciler.reconcile({ reason: 'MANUAL' });
  const pos = store.Position.rows[0];
  assert.equal(pos.exchangeContracts, 4);
  assert.equal(pos.quantity, 0.004);
  assert.equal(pos.needsReconciliation, true);
  assert.ok(rep.discrepancies.length >= 1);
  await engine.closePosition({ positionId: pos._id, productId: 27, reason: 'MANUAL' });
  assert.equal(ex.calls.placeOrder.at(-1).size, 4, 'close uses the REAL remaining exchange quantity');
  assert.equal(store.Position.rows[0].status, 'CLOSED');
});

// -------------------------------------------------------------- 8. target partial
test('8. target close partially filled: position keeps remainder, error carries filledQuantity, retry only sells the shortfall', async () => {
  const { engine, ex, store } = build();
  await engine.openPosition(entryParams());           // 10 contracts
  ex.script.place.push({ type: 'fill', filled: 2 }, { type: 'fill', filled: 1 }, { type: 'fill', filled: 1 });
  let err;
  try { await engine.partialClosePosition({ positionId: store.Position.rows[0]._id, productId: 27, quantity: 0.005, reason: 'TARGET_1' }); } catch (e) { err = e; }
  assert.equal(err.code, 'LIVE_CLOSE_PARTIAL');
  assert.equal(err.filledQuantity, 0.004);
  const pos = store.Position.rows[0];
  assert.equal(pos.status, 'OPEN');
  assert.equal(pos.exchangeContracts, 6);
  assert.equal(pos.quantity, 0.006);
  assert.equal(ex.positionContracts, 6);
  assert.equal(pos.closeInFlight, false);
  await engine.partialClosePosition({ positionId: pos._id, productId: 27, quantity: 0.001, reason: 'TARGET_1' });
  assert.equal(store.Position.rows[0].exchangeContracts, 5);
  assert.equal(ex.calls.placeOrder.at(-1).reduceOnly, true);
});

test('8b. sub-contract target slice sends no order and never over-sells', async () => {
  const { engine, ex, store } = build();
  await engine.openPosition(entryParams({ quantity: 0.003 })); // 3 contracts; 25% = 0.75 contract
  const before = ex.calls.placeOrder.length;
  const r = await engine.partialClosePosition({ positionId: store.Position.rows[0]._id, productId: 27, quantity: 0.00075, reason: 'TARGET_1' });
  assert.equal(r.skipped, true);
  assert.equal(ex.calls.placeOrder.length, before);
});

// -------------------------------------------------------------- 9. close rejected
test('9. close order rejected: position stays OPEN (never marked closed unconfirmed), flagged, lock released', async () => {
  const { engine, ex, store } = build();
  await engine.openPosition(entryParams());
  ex.script.place.push({ type: 'reject' }, { type: 'reject' }, { type: 'reject' });
  await rejects(engine.closePosition({ positionId: store.Position.rows[0]._id, productId: 27, reason: 'MANUAL' }), 'LIVE_CLOSE_INCOMPLETE');
  const pos = store.Position.rows[0];
  assert.equal(pos.status, 'OPEN');
  assert.equal(pos.needsReconciliation, true);
  assert.equal(pos.closeInFlight, false);
  assert.equal(store.Trade.rows.length, 0);
  assert.equal(ex.positionContracts, 10);
});

test('9b. successful close: realized P&L from real fills, Trade written, stale stop cancelled', async () => {
  const { engine, ex, store } = build();
  await engine.openPosition(entryParams());
  ex.price = 63500;
  ex.script.place.push({ type: 'fill', price: 63500 });
  await engine.closePosition({ positionId: store.Position.rows[0]._id, productId: 27, reason: 'MANUAL' });
  const pos = store.Position.rows[0];
  assert.equal(pos.status, 'CLOSED');
  const gross = (63500 - 63000) * 0.01;
  assert.ok(Math.abs(pos.realizedPnl - (gross - 0.05 - 0.05)) < 1e-9, `pnl ${pos.realizedPnl}`); // minus entry+exit commission
  assert.equal(store.Trade.rows.length, 1);
  assert.equal(store.Trade.rows[0].exitPrice, 63500);
  assert.equal(store.Trade.rows[0].priceVerified, true);
  assert.equal(ex.stopLegs.filter((l) => l.state === 'open').length, 0, 'stale stop orders must not survive a close');
});

// ------------------------------------------------------------- 10. duplicates
test('10. duplicate ENTRY (same command id) never places a second order', async () => {
  const { engine, ex, store } = build();
  const a = await engine.openPosition(entryParams());
  const b = await engine.openPosition(entryParams());
  assert.equal(b.duplicate, true);
  assert.equal(String(b.position._id), String(a.position._id));
  assert.equal(ex.calls.placeOrder.length, 1);
  assert.equal(store.Position.rows.length, 1);
});

test('10b. second live entry on a symbol that already has a position is refused (one net position per product)', async () => {
  const { engine, ex } = build();
  await engine.openPosition(entryParams());
  await rejects(engine.openPosition(entryParams({ commandId: 'cmd_other', instanceId: 'inst2' })), 'LIVE_POSITION_EXISTS');
  assert.equal(ex.calls.placeOrder.length, 1);
});

test('10c. concurrent duplicate EXIT events send exactly one close order', async () => {
  const { engine, ex, store } = build();
  await engine.openPosition(entryParams());
  const id = store.Position.rows[0]._id;
  const results = await Promise.allSettled([
    engine.closePosition({ positionId: id, productId: 27, reason: 'STOP_LOSS' }),
    engine.closePosition({ positionId: id, productId: 27, reason: 'TARGET_4' }),
    engine.closePosition({ positionId: id, productId: 27, reason: 'MANUAL' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(ex.calls.placeOrder.filter((c) => c.reduceOnly).length, 1);
  assert.equal(store.Trade.rows.length, 1);
});

test('10d. concurrent entries on one symbol: second is blocked while the first is in flight', async () => {
  const { engine, ex, store } = build();
  const [a, b] = await Promise.allSettled([
    engine.openPosition(entryParams({ commandId: 'c_a', instanceId: 'i1' })),
    engine.openPosition(entryParams({ commandId: 'c_b', instanceId: 'i2' })),
  ]);
  assert.equal([a, b].filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(ex.calls.placeOrder.length, 1);
  assert.equal(store.Position.rows.length, 1);
});

// --------------------------------------------------------------- 11. restart
test('11. restart with an open, protected position: reconciliation sends NO orders and keeps state', async () => {
  const first = build();
  await first.engine.openPosition(entryParams());
  // "restart": brand-new engine/reconciler objects over the same persisted store + exchange
  const { LiveEngine } = require('../services/liveEngine/LiveEngine');
  const { LiveReconciler } = require('../services/liveEngine/LiveReconciler');
  const engine2 = new LiveEngine().setDependencies({ ...first.engine.d });
  const rec2 = new LiveReconciler().setDependencies({ ...first.reconciler.d, engine: engine2 });
  const placeBefore = first.ex.calls.placeOrder.length;
  const bracketBefore = first.ex.calls.bracket.length;
  const rep = await rec2.reconcile({ reason: 'STARTUP' });
  assert.equal(first.ex.calls.placeOrder.length, placeBefore);
  assert.equal(first.ex.calls.bracket.length, bracketBefore, 'existing stop must be reused, not duplicated');
  assert.equal(first.store.Position.rows[0].status, 'OPEN');
  assert.equal(first.store.Position.rows[0].protectionStatus, 'PROTECTED');
  assert.equal(rep.discrepancies.length, 0);
});

test('11b. restart: exchange already closed the position while we were down -> closed locally from the stop fill', async () => {
  const { engine, reconciler, ex, store } = build();
  await engine.openPosition(entryParams());
  const leg = ex.stopLegs[0];
  ex.orders.set(leg.id, { ...leg, size: 10, unfilled_size: 0, state: 'closed', average_fill_price: '62890', paid_commission: '0.05' });
  store.Position.rows[0].protectionOrderId = String(leg.id);
  ex.positionContracts = 0; leg.state = 'closed';
  await reconciler.reconcile({ reason: 'STARTUP' });
  const pos = store.Position.rows[0];
  assert.equal(pos.status, 'CLOSED');
  assert.equal(pos.closeReason, 'STOP_LOSS');
  assert.equal(store.Trade.rows[0].exitPrice, 62890);
  assert.equal(store.Trade.rows[0].priceVerified, true);
  assert.equal(ex.calls.placeOrder.length, 1, 'no order is sent when the exchange is already flat');
});

test('11c. exchange flat with NO fill evidence: closed locally but flagged UNVERIFIED, never presented as verified', async () => {
  const { engine, reconciler, ex, store } = build();
  await engine.openPosition(entryParams());
  ex.positionContracts = 0; ex.stopLegs.length = 0;
  await reconciler.reconcile({ reason: 'MANUAL' });
  assert.equal(store.Position.rows[0].status, 'CLOSED');
  assert.equal(store.Position.rows[0].closeReason, 'RECONCILED_EXTERNALLY');
  assert.equal(store.Trade.rows[0].priceVerified, false);
  assert.equal(store.Position.rows[0].needsReconciliation, true);
});

// -------------------------------------------------- 12. missing protective order
test('12. missing protective stop detected by reconciliation is restored once, idempotently', async () => {
  const { engine, reconciler, ex, store } = build();
  await engine.openPosition(entryParams());
  ex.stopLegs.forEach((l) => { l.state = 'cancelled'; }); // someone cancelled the stop
  const rep = await reconciler.reconcile({ reason: 'PERIODIC' });
  assert.ok(rep.discrepancies.some((d) => d.issue === 'MISSING_PROTECTIVE_STOP'));
  assert.equal(ex.stopLegs.filter((l) => l.state === 'open').length, 1);
  assert.equal(store.Position.rows[0].protectionStatus, 'PROTECTED');
  const bracketCalls = ex.calls.bracket.length;
  await reconciler.reconcile({ reason: 'PERIODIC' });
  assert.equal(ex.calls.bracket.length, bracketCalls, 'second run must not create a duplicate stop');
});

test('12b. missing stop that cannot be restored triggers the verified emergency close', async () => {
  const { engine, reconciler, ex, store } = build();
  await engine.openPosition(entryParams());
  ex.stopLegs.forEach((l) => { l.state = 'cancelled'; });
  ex.script.bracket.push({ type: 'reject' });
  await reconciler.reconcile({ reason: 'PERIODIC' });
  assert.equal(store.Position.rows[0].status, 'CLOSED');
  assert.equal(ex.positionContracts, 0);
});

// ----------------------------------------------------------------- 13. auth failure
test('13. Delta auth failure on entry: order ERROR, no position, operator alerted', async () => {
  const { engine, ex, store, logger } = build();
  ex.script.place.push({ type: 'auth' });
  await rejects(engine.openPosition(entryParams()), 'DELTA_ORDER_FAILED');
  assert.equal(store.Position.rows.length, 0);
  assert.equal(store.Order.rows[0].status, 'ERROR');
  assert.ok(logger.lines.some((l) => /authentication/i.test(l.msg)));
});

test('13b. Delta auth failure during reconciliation: alert + circuit breaker, local state untouched', async () => {
  const { engine, reconciler, ex, store } = build();
  await engine.openPosition(entryParams());
  ex.authBroken = true;
  const rep = await reconciler.reconcile({ reason: 'PERIODIC' });
  assert.equal(rep.error, 'AUTH_FAILURE');
  assert.equal(store.SystemSetting.settings.liveTradingEnabled, false);
  assert.equal(store.Position.rows[0].status, 'OPEN');
});

// -------------------------------------------------------------------- 14. mismatch
test('14. exchange holds MORE than local books: flagged, NOT overwritten, circuit breaker trips', async () => {
  const { engine, reconciler, ex, store } = build();
  await engine.openPosition(entryParams());
  ex.positionContracts = 25;
  await reconciler.reconcile({ reason: 'MANUAL' });
  const pos = store.Position.rows[0];
  assert.equal(pos.exchangeContracts, 10, 'local state must not be silently overwritten');
  assert.equal(pos.needsReconciliation, true);
  assert.equal(store.SystemSetting.settings.liveTradingEnabled, false);
});

test('14b. orphan exchange position with no local record: alert + breaker, never auto-closed or auto-protected', async () => {
  const { reconciler, ex, store } = build();
  ex.positionContracts = 5; ex.positionSide = 'LONG';
  const rep = await reconciler.reconcile({ reason: 'STARTUP' });
  assert.ok(rep.discrepancies.some((d) => d.issue === 'ORPHAN_EXCHANGE_POSITION'));
  assert.equal(ex.calls.placeOrder.length, 0);
  assert.equal(ex.calls.bracket.length, 0);
  assert.equal(store.SystemSetting.settings.liveTradingEnabled, false);
});

test('14c. UNKNOWN entry later found filled on the exchange: adopted once, protected, never resubmitted', async () => {
  const { engine, reconciler, ex, store } = build();
  ex.script.place.push({ type: 'timeout', fills: false });
  await assert.rejects(engine.openPosition(entryParams()));
  // the exchange accepted it after all (late)
  const o = store.Order.rows[0];
  ex._record({ size: 10, side: 'buy', reduceOnly: false, clientOrderId: o.clientOrderId }, { price: 63050 }, 'closed');
  await reconciler.reconcile({ reason: 'MANUAL' });
  assert.equal(store.Position.rows.length, 1);
  assert.equal(store.Position.rows[0].entryPrice, 63050);
  assert.equal(store.Position.rows[0].protectionStatus, 'PROTECTED');
  assert.equal(ex.calls.placeOrder.length, 1);
  await reconciler.reconcile({ reason: 'MANUAL' });
  assert.equal(store.Position.rows.length, 1, 'adoption must be idempotent');
});

test('periodic reconciliation makes NO exchange calls when nothing is open or unresolved', async () => {
  const { reconciler, ex } = build();
  let called = 0;
  ex.getPositions = async () => { called += 1; return []; };
  const rep = await reconciler.reconcile({ reason: 'PERIODIC' });
  assert.equal(rep.skipped, true);
  assert.equal(called, 0);
});

test('stop-loss tick monitor: after a failed close it backs off instead of hammering the exchange', async () => {
  const { engine, ex, store } = build();
  await engine.openPosition(entryParams());
  ex.script.place.push({ type: 'reject' }, { type: 'reject' }, { type: 'reject' });
  await assert.rejects(engine.closeStopLossPositions('BTCUSD', 62000));
  const n = ex.calls.placeOrder.length;
  await engine.closeStopLossPositions('BTCUSD', 62000); // within backoff window: skipped
  assert.equal(ex.calls.placeOrder.length, n);
  assert.equal(store.Position.rows[0].status, 'OPEN');
});

test('no secrets are logged: lifecycle logs never contain key/secret/signature material', async () => {
  const { engine, ex, logger } = build();
  ex.script.place.push({ type: 'reject' });
  await assert.rejects(engine.openPosition(entryParams()));
  const blob = JSON.stringify(logger.lines);
  assert.ok(!/api[-_ ]?secret|signature|api-key|private/i.test(blob));
});
