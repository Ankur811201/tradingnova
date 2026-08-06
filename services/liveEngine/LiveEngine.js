'use strict';

const Order = require('../../models/Order');
const Position = require('../../models/Position');
const Trade = require('../../models/Trade');
const SystemSetting = require('../../models/SystemSetting');
const deltaAdapter = require('../delta/DeltaAdapter');
const { env } = require('../../config/env');
const { newOrderId } = require('../../utils/ids');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/apiResponse');

/**
 * LiveEngine — coordinates real-money execution. Talks to Delta ONLY through
 * DeltaAdapter. NEVER silently falls back to PaperEngine. If Delta is not
 * configured, every method throws a clear 503 configuration error.
 */
class LiveEngine {
  _assertConfigured() {
    if (!deltaAdapter.isConfigured()) {
      throw new AppError('Live trading is unavailable: Delta Exchange is not configured (missing API credentials).', 503, 'DELTA_NOT_CONFIGURED');
    }
  }

  async _assertLiveTradingEnabled() {
    const settings = await SystemSetting.getSingleton(env.LIVE_TRADING_DEFAULT_ENABLED);
    if (!settings.liveTradingEnabled) {
      throw new AppError('Live trading is globally disabled. Enable it via /api/safety before placing live trades.', 403, 'LIVE_TRADING_DISABLED');
    }
  }

  /**
   * Opens a live position via a market order on Delta.
   * @param {object} params { userId, symbol, productId, side: 'LONG'|'SHORT', quantity, leverage, stopLoss, takeProfit, source, modelId, instanceId, commandId }
   */
  async openPosition(params) {
    this._assertConfigured();
    await this._assertLiveTradingEnabled();

    const {
      userId, symbol, productId, side, quantity, leverage = 1,
      stopLoss = null, takeProfit = null,
      source = 'MANUAL', modelId = null, instanceId = null, commandId = null,
    } = params;

    if (!productId) throw new AppError('productId is required to place a live order (fetch via DeltaAdapter.getProductBySymbol)', 400);
    if (!['LONG', 'SHORT'].includes(side)) throw new AppError('side must be LONG or SHORT', 400);
    if (!quantity || quantity <= 0) throw new AppError('quantity must be positive', 400);

    const clientOrderId = commandId || newOrderId();
    const deltaSide = side === 'LONG' ? 'buy' : 'sell';

    const orderRecord = await Order.create({
      internalOrderId: newOrderId(),
      environment: 'LIVE',
      source,
      user: userId,
      modelId,
      instanceId,
      commandId,
      symbol,
      side: deltaSide,
      type: 'market',
      quantity,
      leverage,
      stopLoss,
      takeProfit,
      status: 'SUBMITTED',
      submittedAt: new Date(),
    });

    let deltaOrder;
    try {
      deltaOrder = await deltaAdapter.placeOrder({
        productId,
        side: deltaSide,
        orderType: 'market_order',
        size: quantity,
        clientOrderId,
        stopLossOrder: stopLoss ? { stopPrice: stopLoss } : null,
        takeProfitOrder: takeProfit ? { stopPrice: takeProfit } : null,
      });
    } catch (err) {
      orderRecord.status = 'ERROR';
      orderRecord.rejectionReason = err.message;
      await orderRecord.save();
      await logger.error('TRADING', `Live order failed for ${symbol}: ${err.message}`, { instanceId, commandId });
      throw new AppError(`Live order placement failed: ${err.message}`, err.status || 502, 'DELTA_ORDER_FAILED');
    }

    orderRecord.externalOrderId = String(deltaOrder.id);
    orderRecord.executedPrice = deltaOrder.limit_price ? Number(deltaOrder.limit_price) : null;
    orderRecord.status = deltaOrder.state === 'closed' ? 'FILLED' : 'SUBMITTED';
    orderRecord.filledAt = deltaOrder.state === 'closed' ? new Date() : null;
    await orderRecord.save();

    // Create a local Position record. Live position economics (entry price,
    // margin, PnL) should be reconciled against Delta's authoritative data via
    // syncPositions() — this local record is a best-effort mirror, not the
    // source of truth for live money.
    const position = await Position.create({
      environment: 'LIVE',
      source,
      user: userId,
      modelId,
      instanceId,
      symbol,
      side,
      entryPrice: orderRecord.executedPrice || 0,
      currentPrice: orderRecord.executedPrice || 0,
      quantity,
      leverage,
      margin: 0, // populated on next reconciliation from Delta
      stopLoss,
      takeProfit,
      status: 'OPEN',
    });

    orderRecord.relatedPosition = position._id;
    await orderRecord.save();

    await logger.info('TRADING', `LIVE order submitted: ${side} ${quantity} ${symbol}`, {
      externalOrderId: orderRecord.externalOrderId, instanceId,
    });

    return { order: orderRecord, position, deltaOrder };
  }

  async closePosition({ positionId, productId, reason = 'MANUAL' }) {
    this._assertConfigured();

    const position = await Position.findById(positionId);
    if (!position) throw new AppError('Position not found', 404);
    if (position.environment !== 'LIVE') throw new AppError('Not a live position', 400);
    if (position.status !== 'OPEN') throw new AppError('Position is not open', 400);
    if (!productId) throw new AppError('productId is required to close a live position', 400);

    const closingSide = position.side === 'LONG' ? 'sell' : 'buy';

    let deltaOrder;
    try {
      deltaOrder = await deltaAdapter.placeOrder({
        productId,
        side: closingSide,
        orderType: 'market_order',
        size: position.quantity,
        reduceOnly: true,
        clientOrderId: newOrderId(),
      });
    } catch (err) {
      await logger.error('TRADING', `Live close order failed for position ${positionId}: ${err.message}`);
      throw new AppError(`Live close order failed: ${err.message}`, err.status || 502, 'DELTA_ORDER_FAILED');
    }

    const exitPrice = deltaOrder.limit_price ? Number(deltaOrder.limit_price) : position.currentPrice;
    const grossPnl = position.side === 'LONG'
      ? (exitPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - exitPrice) * position.quantity;

    position.status = 'CLOSED';
    position.currentPrice = exitPrice;
    position.realizedPnl = grossPnl; // fees reconciled from Delta fills separately
    position.closedAt = new Date();
    position.closeReason = reason;
    await position.save();

    await Order.create({
      internalOrderId: newOrderId(),
      externalOrderId: String(deltaOrder.id),
      environment: 'LIVE',
      source: position.source,
      user: position.user,
      modelId: position.modelId,
      instanceId: position.instanceId,
      symbol: position.symbol,
      side: closingSide,
      type: 'market',
      quantity: position.quantity,
      executedPrice: exitPrice,
      status: 'FILLED',
      relatedPosition: position._id,
      submittedAt: new Date(),
      filledAt: new Date(),
    });

    await Trade.create({
      environment: 'LIVE',
      source: position.source,
      user: position.user,
      modelId: position.modelId,
      instanceId: position.instanceId,
      position: position._id,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      leverage: position.leverage,
      realizedPnl: grossPnl,
      fees: 0,
      reason,
      openedAt: position.openedAt,
      closedAt: position.closedAt,
    });

    await logger.info('TRADING', `LIVE position closed: ${position.side} ${position.quantity} ${position.symbol} @ ${exitPrice}`, { positionId });

    return { position, deltaOrder };
  }

  /** Closes every open LIVE position by iterating verified single-close calls. */
  async closeAllPositions(productIdResolver) {
    this._assertConfigured();
    const openPositions = await Position.find({ environment: 'LIVE', status: 'OPEN' });
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
    return deltaAdapter.cancelOrder({ id, productId, clientOrderId });
  }

  async getOpenOrders() {
    this._assertConfigured();
    return deltaAdapter.getActiveOrders();
  }

  async getAccountBalance() {
    this._assertConfigured();
    return deltaAdapter.getWalletBalances();
  }

  /**
   * Reconciles local Position/Order records against Delta's authoritative
   * open-positions data. Does not assume MongoDB is the source of truth.
   */
  async syncPositions() {
    this._assertConfigured();
    const deltaPositions = await deltaAdapter.getPositions();
    const localOpen = await Position.find({ environment: 'LIVE', status: 'OPEN' });

    const bySymbol = new Map(deltaPositions.filter((p) => p.size !== 0).map((p) => [p.product_symbol, p]));

    for (const local of localOpen) {
      const remote = bySymbol.get(local.symbol);
      if (!remote) {
        // Position closed on exchange but still marked OPEN locally (e.g. liquidation).
        local.status = 'CLOSED';
        local.closeReason = local.closeReason || 'RECONCILED_EXTERNALLY';
        local.closedAt = new Date();
        await local.save();
        await logger.warn('TRADING', `Reconciliation: local LIVE position ${local._id} marked CLOSED (not found on exchange)`);
      } else {
        local.currentPrice = Number(remote.entry_price) || local.currentPrice;
        local.margin = Number(remote.margin) || local.margin;
        local.realizedPnl = Number(remote.realized_pnl) || local.realizedPnl;
        await local.save();
      }
    }
    return { reconciled: localOpen.length, exchangePositionCount: deltaPositions.length };
  }
}

module.exports = new LiveEngine();
