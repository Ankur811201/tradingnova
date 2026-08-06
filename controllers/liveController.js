'use strict';

const liveEngine = require('../services/liveEngine/LiveEngine');
const deltaAdapter = require('../services/delta/DeltaAdapter');
const Position = require('../models/Position');
const { success, AppError } = require('../utils/apiResponse');
const socketBus = require('../utils/socketBus');
const portfolioService = require('../services/portfolio/PortfolioService');

async function broadcastLivePortfolio() {
  try {
    const portfolio = await portfolioService.getLivePortfolio();
    socketBus.emitTo('room:live', 'live:portfolio', portfolio);
  } catch (_err) {
    // best-effort only (e.g. Delta not configured) - REST remains source of truth
  }
}

async function getStatus(req, res, next) {
  try {
    return success(res, { configured: deltaAdapter.isConfigured() });
  } catch (err) {
    return next(err);
  }
}

async function getBalance(req, res, next) {
  try {
    const balances = await liveEngine.getAccountBalance();
    return success(res, balances);
  } catch (err) {
    return next(err);
  }
}

async function openPosition(req, res, next) {
  try {
    const { symbol, side, quantity, leverage, stopLoss, takeProfit } = req.body;
    if (!symbol || !side || !quantity) throw new AppError('symbol, side, quantity are required', 400);

    const product = await deltaAdapter.getProductBySymbol(symbol);
    if (!product || !product.id) throw new AppError(`Unable to resolve Delta product for symbol ${symbol}`, 502);

    const result = await liveEngine.openPosition({
      userId: req.session.userId,
      symbol,
      productId: product.id,
      side,
      quantity: Number(quantity),
      leverage: leverage ? Number(leverage) : 1,
      stopLoss: stopLoss ? Number(stopLoss) : null,
      takeProfit: takeProfit ? Number(takeProfit) : null,
      source: 'MANUAL',
    });
    socketBus.emitTo('room:live', 'position:update', result.position);
    socketBus.emitTo('room:live', 'order:update', result.order);
    await broadcastLivePortfolio();
    return success(res, result, 'Live position opened', 201);
  } catch (err) {
    return next(err);
  }
}

async function closePosition(req, res, next) {
  try {
    const { positionId } = req.params;
    const position = await Position.findById(positionId);
    if (!position) throw new AppError('Position not found', 404);
    if (String(position.user) !== req.session.userId) throw new AppError('Forbidden', 403);

    const product = await deltaAdapter.getProductBySymbol(position.symbol);
    const result = await liveEngine.closePosition({ positionId, productId: product.id, reason: 'MANUAL' });
    socketBus.emitTo('room:live', 'position:update', result.position);
    await broadcastLivePortfolio();
    return success(res, result, 'Live position closed');
  } catch (err) {
    return next(err);
  }
}

async function syncPositions(req, res, next) {
  try {
    const result = await liveEngine.syncPositions();
    return success(res, result, 'Live positions reconciled');
  } catch (err) {
    return next(err);
  }
}

async function getOpenOrders(req, res, next) {
  try {
    const orders = await liveEngine.getOpenOrders();
    return success(res, orders);
  } catch (err) {
    return next(err);
  }
}

async function cancelOrder(req, res, next) {
  try {
    const { id, productId, clientOrderId } = req.body;
    if (!id || !productId) throw new AppError('id and productId are required', 400);
    const result = await liveEngine.cancelOrder({ id, productId, clientOrderId });
    return success(res, result, 'Order cancelled');
  } catch (err) {
    return next(err);
  }
}

module.exports = { getStatus, getBalance, openPosition, closePosition, syncPositions, getOpenOrders, cancelOrder };
