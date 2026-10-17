'use strict';

const Position = require('../../models/Position');
const Order = require('../../models/Order');
const deltaAdapter = require('../delta/DeltaAdapter');
const liveEngine = require('./LiveEngine');
const { env } = require('../../config/env');
const logger = require('../../utils/logger');
const {
  classifyOrder, PHASE, isTerminal, quantityFromContracts, findStopLossOrder,
} = require('../delta/deltaOrderState');

/**
 * Exchange <-> local reconciliation for LIVE trading.
 *
 * Policy (never silently overwrite important state):
 *  - Exchange flat, local OPEN         -> close locally using the stop-order fill when the
 *                                         exchange confirms one; otherwise close flagged UNVERIFIED + alert.
 *  - Exchange > local contracts        -> UNKNOWN EXPOSURE: flag, alert, circuit-break. Local size NOT overwritten.
 *  - Exchange < local contracts        -> adopt exchange size (risk-reducing), flag + alert.
 *  - Exchange position with no local   -> orphan: alert + circuit-break. Never auto-closed (could be a
 *                                         manual position on the same account) and never auto-protected
 *                                         (no authoritative stop price).
 *  - Missing protective stop           -> ensureProtection() (idempotent); on failure the verified emergency close.
 *  - UNKNOWN entry orders              -> looked up by client_order_id; a confirmed fill is adopted through
 *                                         the same position+protection path as a normal entry. Nothing is resubmitted.
 *  - Auth failure                      -> alert + circuit-break (new entries stop; nothing else is touched).
 * API cost: positions(3) + active orders(3) per run; periodic runs make NO calls when nothing is open/unknown.
 */
class LiveReconciler {
  constructor() {
    this.d = { Position, Order, adapter: deltaAdapter, engine: liveEngine, env, logger };
    this._running = false;
    this._timer = null;
  }

  setDependencies(o) { Object.assign(this.d, o); return this; }

  start() {
    if (this._timer || !(this.d.env.LIVE_RECONCILE_INTERVAL_MS > 0)) return;
    this._timer = setInterval(() => {
      this.reconcile({ reason: 'PERIODIC' }).catch((err) => this.d.logger.error('SAFETY', `periodic reconcile failed: ${err.message}`));
    }, this.d.env.LIVE_RECONCILE_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  async reconcile({ reason = 'MANUAL' } = {}) {
    if (this._running) return { skipped: true, reason: 'already running' };
    if (!this.d.adapter.isConfigured()) return { skipped: true, reason: 'delta not configured' };
    this._running = true;
    const report = { reason, reconciled: 0, exchangePositionCount: 0, actions: [], discrepancies: [] };
    try {
      const localOpen = await this.d.Position.find({ environment: 'LIVE', status: 'OPEN' });
      const unknownOrders = await this.d.Order.find({ environment: 'LIVE', status: 'UNKNOWN', purpose: 'ENTRY' });
      if (reason === 'PERIODIC' && !localOpen.length && !unknownOrders.length) return { ...report, skipped: true };

      let exchangePositions;
      try { exchangePositions = await this.d.adapter.getPositions(); } catch (err) {
        if (err && err.isAuthError) {
          await this.d.engine._alert('Delta API authentication FAILED during reconciliation; open positions cannot be verified', { status: err.status });
          await this.d.engine._circuitBreak('Delta authentication failure');
          return { ...report, error: 'AUTH_FAILURE' };
        }
        await this.d.logger.warn('SAFETY', `reconcile: exchange positions unavailable (${err.message}); skipping`, {});
        return { ...report, error: 'EXCHANGE_UNAVAILABLE' };
      }
      const open = (Array.isArray(exchangePositions) ? exchangePositions : []).filter((p) => Number(p.size) !== 0);
      report.exchangePositionCount = open.length;

      for (const order of unknownOrders) await this._resolveUnknownEntry(order, report);

      const stillOpen = await this.d.Position.find({ environment: 'LIVE', status: 'OPEN' });
      const remoteBySymbol = new Map(open.map((p) => [p.product_symbol, p]));
      let activeOrders = null;

      for (const local of stillOpen) {
        if (local.closeInFlight) continue; // a close is mid-flight; do not race it
        const remote = remoteBySymbol.get(local.symbol);
        remoteBySymbol.delete(local.symbol);
        try {
          if (!remote) {
            const product = await this.d.adapter.getProductBySymbol(local.symbol);
            await this.d.engine._closeFromExchangeFlat(local, product.id, 'RECONCILED_EXTERNALLY');
            report.actions.push({ positionId: String(local._id), action: 'CLOSED_LOCALLY_EXCHANGE_FLAT' });
            report.reconciled += 1;
            continue;
          }
          const remoteContracts = Math.abs(Number(remote.size));
          const localContracts = Number(local.exchangeContracts);
          if (Number.isFinite(localContracts) && remoteContracts !== localContracts) {
            const cv = Number(local.contractValue);
            report.discrepancies.push({ positionId: String(local._id), symbol: local.symbol, exchangeContracts: remoteContracts, localContracts });
            local.needsReconciliation = true;
            if (remoteContracts > localContracts) {
              local.reconciliationNote = `exchange holds MORE (${remoteContracts}) than local books (${localContracts}); local NOT overwritten`;
              await local.save();
              await this.d.engine._alert(local.reconciliationNote, { positionId: String(local._id), symbol: local.symbol });
              await this.d.engine._circuitBreak(`exchange exposure exceeds local books on ${local.symbol}`);
            } else {
              local.reconciliationNote = `exchange holds LESS (${remoteContracts}) than local books (${localContracts}); adopted exchange size`;
              local.exchangeContracts = remoteContracts;
              if (cv > 0) local.quantity = quantityFromContracts(remoteContracts, cv);
              await local.save();
              await this.d.engine._alert(local.reconciliationNote, { positionId: String(local._id), symbol: local.symbol });
            }
          }
          const margin = Number(remote.margin);
          if (Number.isFinite(margin) && margin > 0) { local.margin = margin; await local.save(); }

          if (Number(local.stopLoss) > 0) {
            if (!activeOrders) activeOrders = await this.d.adapter.getActiveOrders({ states: 'open,pending' });
            const productId = Number(remote.product_id);
            const sl = findStopLossOrder(activeOrders, { productId, positionSide: local.side });
            if (sl) {
              if (local.protectionStatus !== 'PROTECTED' || local.protectionOrderId !== String(sl.id)) {
                local.protectionStatus = 'PROTECTED'; local.protectionOrderId = String(sl.id); local.protectionVerifiedAt = new Date();
                await local.save();
              }
            } else {
              report.discrepancies.push({ positionId: String(local._id), symbol: local.symbol, issue: 'MISSING_PROTECTIVE_STOP' });
              await this.d.engine._alert(`protective stop MISSING for ${local.side} ${local.symbol}; re-establishing`, { positionId: String(local._id) });
              const prot = await this.d.engine.ensureProtection(local, { productId });
              if (prot.protected) report.actions.push({ positionId: String(local._id), action: 'PROTECTION_RESTORED' });
              else {
                report.actions.push({ positionId: String(local._id), action: 'EMERGENCY_CLOSE_ATTEMPTED', reason: prot.reason });
                try { await this.d.engine._handleProtectionFailure(local, productId, prot.reason); } catch (_) { /* outcome already alerted/recorded */ }
              }
            }
          }
          report.reconciled += 1;
        } catch (err) {
          report.discrepancies.push({ positionId: String(local._id), error: err.message });
          await this.d.logger.error('SAFETY', `reconcile failed for position ${local._id}: ${err.message}`, { positionId: String(local._id) });
        }
      }

      for (const [symbol, p] of remoteBySymbol) {
        report.discrepancies.push({ symbol, issue: 'ORPHAN_EXCHANGE_POSITION', exchangeContracts: Math.abs(Number(p.size)) });
        await this.d.engine._alert(`exchange position on ${symbol} (${p.size} contracts) has NO local record; not auto-closed (may be manual)`, { symbol });
        await this.d.engine._circuitBreak(`orphan exchange position on ${symbol}`);
      }
      return report;
    } finally {
      this._running = false;
    }
  }

  async _resolveUnknownEntry(order, report) {
    let found = null;
    let definitiveMiss = false;
    try { found = await this.d.adapter.getOrderByClientOrderId(order.clientOrderId); } catch (err) { definitiveMiss = err && err.status === 404; }
    if (!found) {
      const ageMs = Date.now() - new Date(order.submittedAt || order.createdAt || 0).getTime();
      if (definitiveMiss && ageMs > 60000) {
        order.status = 'CANCELLED'; order.rejectionReason = 'not found on exchange during reconciliation'; await order.save();
        report.actions.push({ orderId: order.clientOrderId, action: 'UNKNOWN_ORDER_NOT_ON_EXCHANGE' });
      }
      return;
    }
    const c = classifyOrder(found);
    if (!isTerminal(c.phase)) {
      try { await this.d.adapter.cancelOrder({ id: found.id, productId: found.product_id, clientOrderId: order.clientOrderId }); } catch (_) { /* re-read next cycle */ }
      return;
    }
    if (c.phase === PHASE.UNKNOWN) return;
    const cv = (await this.d.engine._contractValueFor(order.symbol, null));
    this.d.engine._applyOrderResult(order, { classified: c, deltaOrder: found }, cv);
    await order.save();
    if (c.filledContracts <= 0) { report.actions.push({ orderId: order.clientOrderId, action: 'UNKNOWN_ORDER_RESOLVED_UNFILLED' }); return; }
    const position = await this.d.engine._createEntryPosition(order, cv, c, null);
    report.actions.push({ orderId: order.clientOrderId, positionId: String(position._id), action: 'ADOPTED_LATE_FILL' });
    if (Number(position.stopLoss) > 0) {
      const prot = await this.d.engine.ensureProtection(position, { productId: Number(found.product_id) });
      if (!prot.protected) {
        try { await this.d.engine._handleProtectionFailure(position, Number(found.product_id), prot.reason); } catch (_) { /* recorded */ }
      }
    }
  }
}

module.exports = new LiveReconciler();
module.exports.LiveReconciler = LiveReconciler;
