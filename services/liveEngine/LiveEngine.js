'use strict';

const crypto = require('crypto');
const Order = require('../../models/Order');
const Position = require('../../models/Position');
const Trade = require('../../models/Trade');
const SystemSetting = require('../../models/SystemSetting');
const deltaAdapter = require('../delta/DeltaAdapter');
const { env } = require('../../config/env');
const { newOrderId } = require('../../utils/ids');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/apiResponse');
const {
  PHASE, classifyOrder, isTerminal, contractsFromQuantity, quantityFromContracts,
  findStopLossOrder, findTargetLikeOrders,
} = require('../delta/deltaOrderState');

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

// Delta Exchange restricts client_order_id to 32 characters. Keep a stable,
// deterministic exchange ID for command retries while retaining the full
// commandId in MongoDB for application-level idempotency.
function deltaClientOrderId(value) {
  const digest = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 29);
  return `nt_${digest}`; // exactly 32 ASCII characters
}

/**
 * LiveEngine — coordinates real-money execution. Talks to Delta ONLY through
 * DeltaAdapter. NEVER silently falls back to PaperEngine.
 *
 * Execution-safety guarantees (see LIVE_EXECUTION_SAFETY.md):
 *  - An HTTP-accepted order is NOT a fill. Fill quantity / average price come
 *    only from the exchange order object (size, unfilled_size,
 *    average_fill_price, state). No fill -> no Position.
 *  - Every filled entry gets an exchange-side stop-loss (POST /v2/orders/bracket)
 *    that is VERIFIED in GET /v2/orders before the position is "PROTECTED".
 *    If protection cannot be verified, a reduce-only emergency close runs and
 *    is itself verified against the exchange position.
 *  - Timeouts/5xx are "ambiguous": we look the order up by client_order_id and
 *    never blindly resubmit.
 *  - Closes are claimed atomically (closeInFlight), reduce-only, sized from the
 *    real exchange position, and a position is only marked CLOSED after the
 *    exchange confirms the fill (or confirms it is flat).
 */
class LiveEngine {
  constructor() {
    this.d = {
      Order, Position, Trade, SystemSetting, adapter: deltaAdapter, env, logger,
      sleep: sleepReal, newId: newOrderId,
    };
    this._symbolLocks = new Map();
    this._slBackoff = new Map();
  }

  /** Test seam: replace any dependency (models, adapter, env, sleep, ...). */
  setDependencies(overrides) { Object.assign(this.d, overrides); return this; }

  _assertConfigured() {
    if (!this.d.adapter.isConfigured()) {
      throw new AppError('Live trading is unavailable: Delta Exchange is not configured (missing API credentials).', 503, 'DELTA_NOT_CONFIGURED');
    }
  }

  async _assertLiveTradingEnabled() {
    const settings = await this.d.SystemSetting.getSingleton(this.d.env.LIVE_TRADING_DEFAULT_ENABLED);
    if (!settings.liveTradingEnabled) {
      throw new AppError('Live trading is globally disabled. Enable it via /api/safety before placing live trades.', 403, 'LIVE_TRADING_DISABLED');
    }
  }

  async _withSymbolLock(symbol, fn) {
    const prev = this._symbolLocks.get(symbol) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    const chained = prev.then(() => gate);
    this._symbolLocks.set(symbol, chained);
    await prev;
    try { return await fn(); } finally {
      release();
      if (this._symbolLocks.get(symbol) === chained) this._symbolLocks.delete(symbol);
    }
  }

  /** Operator alert: persisted SystemLog + socket room:logs (existing logger). Never throws. */
  async _alert(message, meta = {}) {
    try { await this.d.logger.error('SAFETY', `LIVE ALERT: ${message}`, meta); } catch (_) { /* logging must not break safety flow */ }
  }

  /** Circuit breaker: stop NEW live entries when exposure/state is uncertain. Existing positions stay manageable. */
  async _circuitBreak(reason) {
    try {
      const settings = await this.d.SystemSetting.getSingleton(this.d.env.LIVE_TRADING_DEFAULT_ENABLED);
      if (settings.liveTradingEnabled) {
        settings.liveTradingEnabled = false;
        settings.liveTradingDisabledAt = new Date();
        await settings.save();
      }
      await this._alert(`live trading DISABLED by circuit breaker: ${reason}`);
    } catch (err) {
      await this._alert(`circuit breaker failed to persist (${err.message}); reason: ${reason}`);
    }
  }

  async _contractValueFor(symbol, given) {
    const g = Number(given);
    if (g > 0) return g;
    const product = await this.d.adapter.getProductBySymbol(symbol);
    const cv = Number(product && product.contract_value);
    if (!(cv > 0)) throw new AppError(`Delta product ${symbol} has no usable contract_value`, 502, 'DELTA_PRODUCT_INVALID');
    return cv;
  }

  /** Exchange-authoritative open contracts for a product. { known:boolean, contracts:number } */
  async _exchangeContracts(productId) {
    try {
      let res = await this.d.adapter.getPosition(productId);
      if (Array.isArray(res)) res = res[0];
      const size = res ? Math.abs(Number(res.size)) : 0;
      if (!Number.isFinite(size)) return { known: false, contracts: null };
      return { known: true, contracts: size };
    } catch (err) {
      if (err && err.isAuthError) await this._alert('Delta authentication failed while reading position', { status: err.status });
      return { known: false, contracts: null };
    }
  }

  async _lookupByClientId(clientOrderId) {
    for (let i = 0; i < 3; i += 1) {
      try {
        const o = await this.d.adapter.getOrderByClientOrderId(clientOrderId);
        if (o && o.id) return o;
      } catch (err) {
        if (err && err.isAuthError) return null;
      }
      await this.d.sleep(this.d.env.LIVE_FILL_POLL_INTERVAL_MS);
    }
    return null;
  }

  /**
   * Submit a market order and drive it to a confirmed state using exchange data.
   * Returns { outcome, classified, deltaOrder, error }
   *  outcome: 'CONFIRMED' (classified is terminal, fills authoritative)
   *         | 'REJECTED'  (definitive exchange/client rejection, nothing placed)
   *         | 'UNKNOWN'   (cannot establish what happened; never resubmit)
   */
  async _submitAndConfirm({ productId, side, contracts, reduceOnly, clientOrderId }) {
    const adapter = this.d.adapter;
    let deltaOrder = null;
    try {
      deltaOrder = await adapter.placeOrder({
        productId, side, orderType: 'market_order', size: contracts, reduceOnly, clientOrderId,
        stopLossOrder: null, takeProfitOrder: null,
      });
    } catch (err) {
      if (!err.ambiguous) return { outcome: 'REJECTED', error: err };
      deltaOrder = await this._lookupByClientId(clientOrderId); // never blind-resubmit
      if (!deltaOrder) return { outcome: 'UNKNOWN', error: err, reason: 'timeout/5xx and order not found by client_order_id' };
    }

    let c = classifyOrder(deltaOrder);
    const deadline = Date.now() + this.d.env.LIVE_FILL_TIMEOUT_MS;
    let unknownTries = 0;
    let timedOut = false;
    while (!isTerminal(c.phase)) {
      if (Date.now() > deadline) { timedOut = true; break; }
      if (c.phase === PHASE.UNKNOWN && (unknownTries += 1) > 3) break;
      await this.d.sleep(this.d.env.LIVE_FILL_POLL_INTERVAL_MS);
      try {
        deltaOrder = await adapter.getOrderById(deltaOrder.id);
        c = classifyOrder(deltaOrder);
      } catch (err) {
        if (err && err.isAuthError) break;
      }
    }
    if (timedOut && c.phase !== PHASE.UNKNOWN) {
      // A market order should not rest. Cancel whatever is left, then re-read the final state.
      try { await adapter.cancelOrder({ id: deltaOrder.id, productId, clientOrderId }); } catch (_) { /* may already be terminal */ }
      for (let i = 0; i < 3 && !isTerminal(c.phase); i += 1) {
        await this.d.sleep(this.d.env.LIVE_FILL_POLL_INTERVAL_MS);
        try { deltaOrder = await adapter.getOrderById(deltaOrder.id); c = classifyOrder(deltaOrder); } catch (_) { /* retry */ }
      }
    }
    if (!isTerminal(c.phase)) return { outcome: 'UNKNOWN', classified: c, deltaOrder, reason: c.reason || `non-terminal state ${c.phase}` };
    return { outcome: 'CONFIRMED', classified: c, deltaOrder };
  }

  _applyOrderResult(orderRecord, result, cv) {
    const c = result.classified;
    orderRecord.externalOrderId = result.deltaOrder && result.deltaOrder.id != null ? String(result.deltaOrder.id) : orderRecord.externalOrderId;
    orderRecord.deltaState = result.deltaOrder ? result.deltaOrder.state : null;
    orderRecord.filledContracts = c.filledContracts;
    orderRecord.filledQuantity = quantityFromContracts(c.filledContracts, cv);
    orderRecord.executedPrice = c.avgFillPrice; // null unless exchange reported a positive price
    orderRecord.fees = c.commission;
    orderRecord.fillVerified = true;
    if (c.phase === PHASE.FILLED) orderRecord.status = 'FILLED';
    else if (c.phase === PHASE.CANCELLED_PARTIAL) orderRecord.status = 'PARTIALLY_FILLED';
    else orderRecord.status = 'CANCELLED';
    orderRecord.filledAt = c.filledContracts > 0 ? new Date() : null;
  }

  // ------------------------------------------------------------------ ENTRY
  /**
   * Opens a live position via a market order on Delta.
   * @param {object} params { userId, symbol, productId, contractValue?, side, quantity, leverage, stopLoss, takeProfit, source, modelId, instanceId, commandId }
   */
  async openPosition(params) {
    this._assertConfigured();
    await this._assertLiveTradingEnabled();
    return this._withSymbolLock(params.symbol, () => this._openPositionLocked(params));
  }

  async _openPositionLocked(params) {
    const {
      userId, symbol, productId, side, quantity, leverage = 1,
      stopLoss = null, takeProfit = null,
      source = 'MANUAL', modelId = null, instanceId = null, commandId = null, entryLevelKey = null,
    } = params;

    if (!productId) throw new AppError('productId is required to place a live order (fetch via DeltaAdapter.getProductBySymbol)', 400);
    if (!['LONG', 'SHORT'].includes(side)) throw new AppError('side must be LONG or SHORT', 400);
    if (!quantity || quantity <= 0) throw new AppError('quantity must be positive', 400);

    const cv = await this._contractValueFor(params.symbol, params.contractValue);
    let contracts;
    try { contracts = contractsFromQuantity(quantity, cv); } catch (err) {
      throw new AppError(`Live order not sent: ${err.message}`, 400, 'INVALID_CONTRACT_SIZE');
    }

    // --- idempotency / exposure guards (all before any money-moving call) ---
    if (commandId) {
      const dup = await this.d.Order.findOne({ environment: 'LIVE', commandId, purpose: 'ENTRY' });
      if (dup) {
        if (dup.relatedPosition) {
          const existing = await this.d.Position.findById(dup.relatedPosition);
          return { order: dup, position: existing, deltaOrder: null, duplicate: true };
        }
        throw new AppError(`Duplicate entry for command ${commandId} (order status ${dup.status}); not resubmitting`, 409, 'DUPLICATE_ENTRY');
      }
    }
    const openOnSymbol = await this.d.Position.findOne({ environment: 'LIVE', symbol, status: 'OPEN' });
    if (openOnSymbol) {
      throw new AppError(`A live position already exists on ${symbol}; the exchange holds one net position per product`, 409, 'LIVE_POSITION_EXISTS');
    }
    const unresolved = await this.d.Order.findOne({ environment: 'LIVE', symbol, status: 'UNKNOWN' });
    if (unresolved) {
      throw new AppError(`An earlier live order on ${symbol} has unknown exchange state; reconcile before trading it again`, 409, 'LIVE_UNRESOLVED_ORDER');
    }

    const clientOrderId = deltaClientOrderId(commandId || this.d.newId());
    const deltaSide = side === 'LONG' ? 'buy' : 'sell';
    const orderRecord = await this.d.Order.create({
      internalOrderId: this.d.newId(), environment: 'LIVE', source, user: userId, modelId, instanceId, commandId,
      clientOrderId, purpose: 'ENTRY', reduceOnly: false, requestedContracts: contracts,
      symbol, side: deltaSide, type: 'market', quantity, originalQuantity: quantity, leverage,
      stopLoss, takeProfit, status: 'SUBMITTED', submittedAt: new Date(),
    });

    const result = await this._submitAndConfirm({ productId, side: deltaSide, contracts, reduceOnly: false, clientOrderId });

    if (result.outcome === 'REJECTED') {
      orderRecord.status = result.error.isAuthError ? 'ERROR' : 'REJECTED';
      orderRecord.rejectionReason = result.error.message;
      await orderRecord.save();
      await this.d.logger.error('TRADING', `Live entry rejected for ${symbol}: ${result.error.message}`, { instanceId, commandId });
      if (result.error.isAuthError) await this._alert('Delta authentication failure on entry order', { symbol });
      throw new AppError(`Live order placement failed: ${result.error.message}`, result.error.status || 502, 'DELTA_ORDER_FAILED');
    }

    if (result.outcome === 'UNKNOWN') {
      orderRecord.status = 'UNKNOWN';
      orderRecord.rejectionReason = result.reason || 'exchange state could not be established';
      if (result.deltaOrder && result.deltaOrder.id != null) orderRecord.externalOrderId = String(result.deltaOrder.id);
      await orderRecord.save();
      await this._alert(`entry order ${clientOrderId} on ${symbol} has UNKNOWN exchange state; manual/automatic reconciliation required`, { instanceId, commandId });
      await this._circuitBreak(`unknown entry order state on ${symbol}`);
      this._kickReconcile('UNKNOWN_ORDER');
      throw new AppError('Live entry state unknown (possible fill). Live trading disabled pending reconciliation.', 504, 'LIVE_ORDER_STATE_UNKNOWN');
    }

    this._applyOrderResult(orderRecord, result, cv);
    if (result.classified.filledContracts <= 0) {
      orderRecord.rejectionReason = `not filled (exchange state: ${orderRecord.deltaState})`;
      await orderRecord.save();
      throw new AppError('Live entry order was accepted but not filled; no position opened', 409, 'LIVE_ENTRY_NOT_FILLED');
    }
    await orderRecord.save();

    const position = await this._createEntryPosition(orderRecord, cv, result.classified, entryLevelKey);

    const partialNote = result.classified.phase === PHASE.CANCELLED_PARTIAL
      ? ` (PARTIAL: ${result.classified.filledContracts}/${contracts} contracts; remainder cancelled)` : '';
    await this.d.logger.info('TRADING', `LIVE entry filled: ${side} ${orderRecord.filledQuantity} ${symbol} @ ${orderRecord.executedPrice}${partialNote}`, {
      externalOrderId: orderRecord.externalOrderId, instanceId,
    });

    // --- protection for the ACTUAL filled quantity (bracket follows position size) ---
    let protection = { protected: false, reason: 'no stop-loss supplied' };
    if (stopLoss != null && Number(stopLoss) > 0) {
      protection = await this.ensureProtection(position, { productId });
      if (!protection.protected) {
        await this._handleProtectionFailure(position, productId, protection.reason);
        // _handleProtectionFailure throws
      }
    } else {
      position.protectionStatus = 'UNPROTECTED';
      await position.save();
      await this._alert(`LIVE position ${position._id} on ${symbol} opened WITHOUT a stop-loss (none supplied)`, { instanceId });
    }

    return { order: orderRecord, position, deltaOrder: result.deltaOrder, protection };
  }

  /** Local Position mirroring ONLY what the exchange confirmed filled. Also used by reconciliation to adopt a late-discovered fill. */
  async _createEntryPosition(orderRecord, cv, classified, entryLevelKey = null) {
    const side = orderRecord.side === 'buy' ? 'LONG' : 'SHORT';
    const filledQty = orderRecord.filledQuantity;
    const position = await this.d.Position.create({
      environment: 'LIVE', source: orderRecord.source, user: orderRecord.user, modelId: orderRecord.modelId,
      instanceId: orderRecord.instanceId, entryLevelKey: entryLevelKey || null,
      symbol: orderRecord.symbol, side,
      entryPrice: orderRecord.executedPrice, currentPrice: orderRecord.executedPrice,
      quantity: filledQty,
      originalQuantity: filledQty, // fixes T1-T3 sizing: percentages are of the ORIGINAL quantity
      leverage: orderRecord.leverage,
      margin: 0, // populated on reconciliation from Delta's margin field
      stopLoss: orderRecord.stopLoss, takeProfit: orderRecord.takeProfit, status: 'OPEN',
      protectionStatus: 'NONE', exchangeContracts: classified.filledContracts, contractValue: cv,
      entryOrderId: orderRecord.externalOrderId, entryFee: orderRecord.fees, feesPaid: orderRecord.fees,
    });
    orderRecord.relatedPosition = position._id;
    await orderRecord.save();
    return position;
  }

  // ------------------------------------------------------------- PROTECTION
  async _activeOrders(productId) {
    return this.d.adapter.getActiveOrders({ productIds: String(productId), states: 'open,pending' });
  }

  /**
   * Establish AND VERIFY an exchange-side stop-loss for a position. Idempotent:
   * an existing matching stop leg is reused (Delta allows only one bracket per
   * open position), a mismatching one is reported, never duplicated.
   * Returns { protected, orderId, stopPrice, reason }.
   */
  async ensureProtection(position, { productId }) {
    const sl = Number(position.stopLoss);
    const entry = Number(position.entryPrice);
    if (!(sl > 0)) return { protected: false, reason: 'position has no stop-loss price' };
    if ((position.side === 'LONG' && !(sl < entry)) || (position.side === 'SHORT' && !(sl > entry))) {
      return { protected: false, reason: `stop ${sl} is on the wrong side of entry ${entry} for ${position.side}` };
    }
    const match = (o) => o && Math.abs(Number(o.stop_price) - sl) <= Math.max(1e-8, sl * 1e-6);
    const persist = async (o) => {
      position.protectionStatus = 'PROTECTED';
      position.protectionOrderId = String(o.id);
      position.protectionVerifiedAt = new Date();
      await position.save();
      return { protected: true, orderId: String(o.id), stopPrice: Number(o.stop_price) };
    };
    const readStop = async () => {
      try { return findStopLossOrder(await this._activeOrders(productId), { productId, positionSide: position.side }); }
      catch (err) { if (err && err.isAuthError) await this._alert('Delta authentication failed while verifying protection'); return undefined; }
    };

    let existing = await readStop();
    if (existing) {
      if (match(existing)) return persist(existing);
      return { protected: false, reason: `an existing stop order at ${existing.stop_price} differs from intended ${sl}; not duplicating` };
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.d.adapter.placeBracketOrder({
          productId, productSymbol: position.symbol,
          stopLoss: { stopPrice: sl, orderType: this.d.env.DELTA_BRACKET_SL_ORDER_TYPE },
          triggerMethod: this.d.env.DELTA_BRACKET_TRIGGER_METHOD,
        });
        lastErr = null;
      } catch (err) {
        lastErr = err;
        if (err.isAuthError || !err.ambiguous) break; // definitive rejection: retrying would not help
      }
      // verify (also resolves the ambiguous-timeout case without re-placing)
      for (let v = 0; v < 3; v += 1) {
        await this.d.sleep(this.d.env.LIVE_FILL_POLL_INTERVAL_MS);
        existing = await readStop();
        if (existing) break;
      }
      if (existing) {
        if (match(existing)) return persist(existing);
        return { protected: false, reason: `stop order verified at ${existing.stop_price}, expected ${sl}` };
      }
      if (lastErr && !lastErr.ambiguous) break;
    }
    const why = lastErr ? `bracket order failed: ${lastErr.message}` : 'bracket order accepted but no active stop_loss_order found on the exchange';
    position.protectionStatus = 'UNPROTECTED';
    await position.save();
    return { protected: false, reason: why };
  }

  /** Protection could not be verified -> emergency reduce-only close, itself verified. Always throws. */
  async _handleProtectionFailure(position, productId, reason) {
    await this._alert(`EMERGENCY: no verified stop-loss for ${position.side} ${position.quantity} ${position.symbol}; closing. Reason: ${reason}`, { positionId: String(position._id) });
    let closed = false;
    try {
      await this.closePosition({ positionId: position._id, productId, reason: 'PROTECTION_FAILED_EMERGENCY_CLOSE' });
      closed = true;
    } catch (err) {
      await this._alert(`emergency close NOT confirmed for position ${position._id}: ${err.message}`, { positionId: String(position._id) });
    }
    if (closed) {
      throw new AppError(`Entry aborted: stop-loss could not be verified (${reason}); position was closed`, 502, 'LIVE_PROTECTION_FAILED');
    }
    const fresh = await this.d.Position.findById(position._id);
    if (fresh && fresh.status === 'OPEN') {
      fresh.protectionStatus = 'EMERGENCY';
      fresh.needsReconciliation = true;
      fresh.reconciliationNote = `unprotected and emergency close unconfirmed: ${reason}`;
      await fresh.save();
    }
    await this._circuitBreak(`unprotected live position ${position._id} could not be closed`);
    this._kickReconcile('EMERGENCY');
    throw new AppError(`UNPROTECTED POSITION: stop-loss unverified (${reason}) and emergency close not confirmed. Live trading disabled; operator action required.`, 502, 'LIVE_PROTECTION_FAILED_UNCLOSED');
  }

  async _cancelStaleLegs(productId) {
    try {
      const legs = findTargetLikeOrders(await this._activeOrders(productId), { productId });
      for (const leg of legs) {
        try { await this.d.adapter.cancelOrder({ id: leg.id, productId }); } catch (_) { /* verified below */ }
      }
      if (legs.length) {
        const left = findTargetLikeOrders(await this._activeOrders(productId), { productId });
        if (left.length) await this._alert(`${left.length} stale stop/target order(s) remain on product ${productId} after position close`, { productId });
      }
    } catch (err) {
      await this._alert(`could not verify/cancel stale protective orders on product ${productId}: ${err.message}`, { productId });
    }
  }

  // ------------------------------------------------------------------ EXITS
  _kickReconcile(reason) {
    try {
      const reconciler = require('./LiveReconciler');
      setImmediate(() => { reconciler.reconcile({ reason }).catch(() => {}); });
    } catch (_) { /* reconciler optional in unit tests */ }
  }

  /**
   * Reduce-only market closing loop. Re-reads the real exchange position before
   * every attempt and never exceeds it. Returns
   * { fills:[{contracts,avgPrice,fee,orderId}], remaining, flat, unknown, rejection }.
   */
  async _reduceOnlyClose(position, productId, wantContracts, purpose) {
    const cv = Number(position.contractValue) || await this._contractValueFor(position.symbol, null);
    const closingSide = position.side === 'LONG' ? 'sell' : 'buy';
    const fills = [];
    let remaining = wantContracts;
    let flat = false;
    let unknown = false;
    let rejection = null;
    for (let attempt = 0; attempt < this.d.env.LIVE_CLOSE_MAX_ATTEMPTS && remaining > 0; attempt += 1) {
      const exch = await this._exchangeContracts(productId);
      if (exch.known) {
        if (exch.contracts === 0) { flat = true; break; }
        remaining = Math.min(remaining, exch.contracts);
      }
      const clientOrderId = deltaClientOrderId(this.d.newId());
      const rec = await this.d.Order.create({
        internalOrderId: this.d.newId(), environment: 'LIVE', source: position.source, user: position.user,
        modelId: position.modelId, instanceId: position.instanceId, clientOrderId, purpose, reduceOnly: true,
        requestedContracts: remaining, symbol: position.symbol, side: closingSide, type: 'market',
        quantity: quantityFromContracts(remaining, cv), status: 'SUBMITTED', submittedAt: new Date(),
        relatedPosition: position._id,
      });
      const r = await this._submitAndConfirm({ productId, side: closingSide, contracts: remaining, reduceOnly: true, clientOrderId });
      if (r.outcome === 'REJECTED') {
        rec.status = 'REJECTED'; rec.rejectionReason = r.error.message; await rec.save();
        rejection = r.error;
        if (r.error.isAuthError) { await this._alert('Delta authentication failure on close order', { positionId: String(position._id) }); break; }
        continue; // loop re-reads exchange size (a reduce-only reject often means already flat)
      }
      if (r.outcome === 'UNKNOWN') {
        rec.status = 'UNKNOWN'; rec.rejectionReason = r.reason || 'unknown state'; await rec.save();
        unknown = true;
        break; // never stack another close on an order whose result we cannot see
      }
      this._applyOrderResult(rec, r, cv);
      await rec.save();
      const c = r.classified;
      if (c.filledContracts > 0) {
        fills.push({ contracts: c.filledContracts, avgPrice: c.avgFillPrice, fee: c.commission, orderId: rec.externalOrderId });
        remaining -= c.filledContracts;
      }
    }
    if (!flat && !unknown && remaining > 0) {
      const exch = await this._exchangeContracts(productId);
      if (exch.known && exch.contracts === 0) flat = true;
    }
    return { fills, remaining: Math.max(0, remaining), flat, unknown, rejection, cv };
  }

  _summarizeFills(position, fills, cv) {
    let qtyBtc = 0; let notional = 0; let fee = 0; let gross = 0;
    for (const f of fills) {
      const q = quantityFromContracts(f.contracts, cv);
      qtyBtc += q; notional += q * f.avgPrice; fee += f.fee;
      gross += position.side === 'LONG' ? (f.avgPrice - position.entryPrice) * q : (position.entryPrice - f.avgPrice) * q;
    }
    return { qtyBtc, avgPrice: qtyBtc > 0 ? notional / qtyBtc : null, fee, gross };
  }

  async _claimClose(positionId) {
    const claimed = await this.d.Position.findOneAndUpdate(
      { _id: positionId, environment: 'LIVE', status: 'OPEN', closeInFlight: { $ne: true } },
      { $set: { closeInFlight: true } }, { new: true },
    );
    if (claimed) return claimed;
    const p = await this.d.Position.findById(positionId);
    if (!p) throw new AppError('Position not found', 404);
    if (p.environment !== 'LIVE') throw new AppError('Not a live position', 400);
    if (p.status !== 'OPEN') throw new AppError('Position is not open', 400);
    throw new AppError('A close for this position is already in flight', 409, 'CLOSE_IN_FLIGHT');
  }

  async _release(positionId) {
    try { await this.d.Position.updateOne({ _id: positionId }, { $set: { closeInFlight: false } }); } catch (_) { /* best effort */ }
  }

  async _finalizeClosed(position, { reason, exitPrice, closedQtyBtc, finalGross, finalFee, priceVerified = true }) {
    position.status = 'CLOSED';
    position.currentPrice = exitPrice;
    position.quantity = 0;
    position.exchangeContracts = 0;
    position.realizedPnl = Number(position.realizedPnl || 0) + finalGross - finalFee - Number(position.entryFee || 0);
    position.feesPaid = Number(position.feesPaid || 0) + finalFee;
    position.closedAt = new Date();
    position.closeReason = reason;
    position.closeInFlight = false;
    position.protectionStatus = 'NONE';
    if (!priceVerified) { position.needsReconciliation = true; position.reconciliationNote = 'exit price not confirmed from exchange fills'; }
    await position.save();
    await this.d.Trade.create({
      environment: 'LIVE', source: position.source, user: position.user, modelId: position.modelId,
      instanceId: position.instanceId, entryLevelKey: position.entryLevelKey || null, position: position._id,
      symbol: position.symbol, side: position.side, entryPrice: position.entryPrice, exitPrice,
      quantity: closedQtyBtc, leverage: position.leverage, realizedPnl: position.realizedPnl,
      fees: position.feesPaid, reason, openedAt: position.openedAt, closedAt: position.closedAt, priceVerified,
    });
    await this.d.logger.info('TRADING', `LIVE position closed: ${position.side} ${closedQtyBtc} ${position.symbol} @ ${exitPrice}`, { positionId: String(position._id), reason, priceVerified });
  }

  /** Exchange is flat but local says OPEN (e.g. the exchange-side stop fired). No order is sent. */
  async _closeFromExchangeFlat(position, productId, reason) {
    const cv = Number(position.contractValue) || await this._contractValueFor(position.symbol, null);
    let exitPrice = null; let fee = 0; let verified = false; let finalReason = reason;
    if (position.protectionOrderId) {
      try {
        const c = classifyOrder(await this.d.adapter.getOrderById(position.protectionOrderId));
        if (c.filledContracts > 0 && c.avgFillPrice > 0) { exitPrice = c.avgFillPrice; fee = c.commission; verified = true; finalReason = 'STOP_LOSS'; }
      } catch (_) { /* fall through to unverified */ }
    }
    if (!verified) {
      exitPrice = Number(position.currentPrice) || Number(position.entryPrice);
      finalReason = 'RECONCILED_EXTERNALLY';
      await this._alert(`position ${position._id} found flat on exchange with no fill evidence; exit price UNVERIFIED`, { positionId: String(position._id) });
    }
    const qty = Number(position.quantity);
    const gross = position.side === 'LONG' ? (exitPrice - position.entryPrice) * qty : (position.entryPrice - exitPrice) * qty;
    await this._finalizeClosed(position, { reason: finalReason, exitPrice, closedQtyBtc: qty, finalGross: gross, finalFee: fee, priceVerified: verified });
    await this._cancelStaleLegs(productId);
    return { position, deltaOrder: null, exchangeAlreadyFlat: true };
  }

  async closePosition({ positionId, productId, reason = 'MANUAL' }) {
    this._assertConfigured();
    if (!productId) throw new AppError('productId is required to close a live position', 400);
    const position = await this._claimClose(positionId);
    try {
      const exch = await this._exchangeContracts(productId);
      if (exch.known && exch.contracts === 0) return await this._closeFromExchangeFlat(position, productId, reason);

      const cv = Number(position.contractValue) || await this._contractValueFor(position.symbol, null);
      const localContracts = Number(position.exchangeContracts) || Math.round(Number(position.quantity) / cv);
      const want = exch.known ? exch.contracts : localContracts; // exchange-authoritative when readable
      if (exch.known && exch.contracts !== localContracts) {
        await this._alert(`size mismatch before close: exchange ${exch.contracts} vs local ${localContracts} contracts on ${position.symbol}; closing the exchange amount`, { positionId: String(position._id) });
      }

      const res = await this._reduceOnlyClose(position, productId, want, 'CLOSE');
      const s = this._summarizeFills(position, res.fills, res.cv);
      if (res.flat || res.remaining === 0) {
        let exitPrice = s.avgPrice; let verified = true;
        if (exitPrice === null) { // flat with no fills of ours (stop fired during our attempts)
          return await this._closeFromExchangeFlat(position, productId, reason);
        }
        await this._finalizeClosed(position, { reason, exitPrice, closedQtyBtc: s.qtyBtc, finalGross: s.gross, finalFee: s.fee, priceVerified: verified });
        await this._cancelStaleLegs(productId);
        return { position, deltaOrder: null, fills: res.fills };
      }

      // Not flat: record what DID fill, keep the rest OPEN (never mark CLOSED unconfirmed).
      if (res.fills.length) {
        position.realizedPnl = Number(position.realizedPnl || 0) + s.gross - s.fee;
        position.feesPaid = Number(position.feesPaid || 0) + s.fee;
        position.exchangeContracts = Math.max(0, localContracts - res.fills.reduce((a, f) => a + f.contracts, 0));
        position.quantity = quantityFromContracts(position.exchangeContracts, cv);
      }
      position.needsReconciliation = true;
      position.reconciliationNote = res.unknown ? 'close order state unknown' : `close incomplete: ${res.remaining} contracts remain`;
      position.closeInFlight = false;
      await position.save();
      await this._alert(`close of position ${position._id} NOT confirmed (${position.reconciliationNote})`, { positionId: String(position._id) });
      this._kickReconcile('CLOSE_INCOMPLETE');
      throw new AppError(`Live close not confirmed: ${position.reconciliationNote}`, res.unknown ? 504 : 502, 'LIVE_CLOSE_INCOMPLETE');
    } finally {
      await this._release(positionId);
    }
  }

  async closeStopLossPositions(symbol, currentPrice) {
    const openPositions = await this.d.Position.find({ environment: 'LIVE', symbol, status: 'OPEN' }).select('_id side stopLoss closeInFlight');
    const results = [];
    for (const position of openPositions) {
      const sl = Number(position.stopLoss);
      if (!(sl > 0) || position.closeInFlight) continue;
      const hit = position.side === 'LONG' ? Number(currentPrice) <= sl : Number(currentPrice) >= sl;
      if (!hit) continue;
      const key = String(position._id);
      if ((this._slBackoff.get(key) || 0) > Date.now()) continue; // avoid hammering the exchange every tick after a failure
      try {
        const product = await this.d.adapter.getProductBySymbol(symbol);
        const result = await this.closePosition({ positionId: position._id, productId: product.id, reason: 'STOP_LOSS' });
        this._slBackoff.delete(key);
        results.push({ positionId: key, closed: true, result });
      } catch (err) {
        if (err && (err.message === 'Position is not open' || err.code === 'CLOSE_IN_FLIGHT')) continue;
        this._slBackoff.set(key, Date.now() + 5000);
        throw err;
      }
    }
    return results;
  }

  /**
   * Partial reduce-only close for a target exit. Quantity is converted to WHOLE
   * contracts (Delta size is an integer); sub-contract remainders are absorbed by
   * T4 (an all-remaining close). Throws LIVE_CLOSE_PARTIAL with err.filledQuantity
   * if the requested slice could not be completed, so the caller does not mark the
   * target executed.
   */
  async partialClosePosition({ positionId, productId, quantity, reason = 'TARGET' }) {
    this._assertConfigured();
    const pre = await this.d.Position.findById(positionId);
    if (!pre || pre.status !== 'OPEN') return null;
    if (!productId) throw new AppError('productId is required to close a live position', 400);
    const position = await this._claimClose(positionId).catch((e) => { if (e.code === 'CLOSE_IN_FLIGHT' || e.message === 'Position is not open') return null; throw e; });
    if (!position) return null;
    try {
      const cv = Number(position.contractValue) || await this._contractValueFor(position.symbol, null);
      const exch = await this._exchangeContracts(productId);
      if (exch.known && exch.contracts === 0) { await this._closeFromExchangeFlat(position, productId, reason); return null; }
      const localContracts = Number(position.exchangeContracts) || Math.round(Number(position.quantity) / cv);
      const available = exch.known ? Math.min(localContracts, exch.contracts) : localContracts;
      const wanted = Math.min(Math.floor(Number(quantity) / cv + 1e-9), available);
      if (!(wanted >= 1)) {
        await this.d.logger.warn('TRADING', `Target slice ${quantity} is below one contract (${cv}); no live order sent for ${reason}`, { positionId: String(positionId) });
        return { position, deltaOrder: null, quantity: 0, exitPrice: null, skipped: true };
      }
      const res = await this._reduceOnlyClose(position, productId, wanted, 'TARGET');
      const s = this._summarizeFills(position, res.fills, cv);
      const filledContracts = res.fills.reduce((a, f) => a + f.contracts, 0);
      if (filledContracts > 0) {
        position.exchangeContracts = Math.max(0, localContracts - filledContracts);
        position.quantity = quantityFromContracts(position.exchangeContracts, cv);
        position.margin = Math.max(0, Number(position.margin) - ((position.entryPrice * s.qtyBtc) / Math.max(1, position.leverage)));
        position.currentPrice = s.avgPrice;
        position.realizedPnl = Number(position.realizedPnl || 0) + s.gross - s.fee;
        position.feesPaid = Number(position.feesPaid || 0) + s.fee;
      }
      if (res.flat && filledContracts === 0) { await this._closeFromExchangeFlat(position, productId, reason); return null; }
      if (position.exchangeContracts === 0 && filledContracts > 0) {
        position.realizedPnl = Number(position.realizedPnl || 0) - Number(position.entryFee || 0);
        position.status = 'CLOSED'; position.closedAt = new Date(); position.closeReason = reason;
        position.protectionStatus = 'NONE'; position.closeInFlight = false;
        await position.save();
        await this._cancelStaleLegs(productId);
        return { position, deltaOrder: null, quantity: s.qtyBtc, exitPrice: s.avgPrice };
      }
      if (res.remaining > 0 && !res.flat) {
        position.needsReconciliation = true;
        position.reconciliationNote = res.unknown ? 'target close order state unknown' : `target close short by ${res.remaining} contracts`;
        position.closeInFlight = false;
        await position.save();
        await this._alert(`target close ${reason} incomplete on ${position.symbol}: ${position.reconciliationNote}`, { positionId: String(position._id) });
        const err = new AppError(`Live target close incomplete: ${position.reconciliationNote}`, res.unknown ? 504 : 502, 'LIVE_CLOSE_PARTIAL');
        err.filledQuantity = s.qtyBtc;
        throw err;
      }
      position.closeInFlight = false;
      await position.save();
      return { position, deltaOrder: null, quantity: s.qtyBtc, exitPrice: s.avgPrice };
    } finally {
      await this._release(positionId);
    }
  }

  /** Closes every open LIVE position by iterating verified single-close calls. */
  async closeAllPositions(productIdResolver) {
    this._assertConfigured();
    const openPositions = await this.d.Position.find({ environment: 'LIVE', status: 'OPEN' });
    const results = [];
    for (const position of openPositions) {
      try {
        const productId = await productIdResolver(position.symbol);
        const result = await this.closePosition({ positionId: position._id, productId, reason: 'SAFETY_CLOSE_ALL' });
        results.push({ positionId: position._id, ok: true, result });
      } catch (err) {
        results.push({ positionId: position._id, ok: false, error: err.message });
      }
    }
    return results;
  }

  async cancelOrder({ id, productId, clientOrderId }) {
    this._assertConfigured();
    return this.d.adapter.cancelOrder({ id, productId, clientOrderId });
  }

  async getOpenOrders() {
    this._assertConfigured();
    return this.d.adapter.getActiveOrders();
  }

  async getAccountBalance() {
    this._assertConfigured();
    return this.d.adapter.getWalletBalances();
  }

  /** Kept for API compatibility (/api/live/sync): now runs the full exchange/local reconciliation. */
  async syncPositions() {
    this._assertConfigured();
    return require('./LiveReconciler').reconcile({ reason: 'MANUAL_SYNC' });
  }
}

module.exports = new LiveEngine();
module.exports.LiveEngine = LiveEngine;
