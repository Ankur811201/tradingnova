'use strict';

const paperEngine = require('../services/paperEngine/PaperEngine');
const Position = require('../models/Position');
const { success, failure, AppError } = require('../utils/apiResponse');
const socketBus = require('../utils/socketBus');
const portfolioService = require('../services/portfolio/PortfolioService');

async function broadcastPaperPortfolio(userId) {
  try {
    const portfolio = await portfolioService.getPaperPortfolio(userId);
    socketBus.emitTo(`room:paper:${userId}`, 'paper:portfolio', portfolio);
  } catch (_err) {
    // best-effort broadcast only; REST responses remain the source of truth
  }
}

async function getAccount(req, res, next) {
  try {
    const account = await paperEngine.ensureAccount(req.session.userId);
    return success(res, account);
  } catch (err) {
    return next(err);
  }
}

async function addFunds(req, res, next) {
  try {
    const { amount, reason } = req.body;
    const account = await paperEngine.addFunds(req.session.userId, Number(amount), reason);
    await broadcastPaperPortfolio(req.session.userId);
    return success(res, account, 'Virtual funds added');
  } catch (err) {
    return next(err);
  }
}

async function openPosition(req, res, next) {
  try {
    const { symbol, side, quantity, leverage, stopLoss, takeProfit } = req.body;
    if (!symbol || !side || !quantity) throw new AppError('symbol, side, quantity are required', 400);
    const result = await paperEngine.openPosition({
      userId: req.session.userId,
      symbol, side, quantity: Number(quantity), leverage: leverage ? Number(leverage) : 1,
      stopLoss: stopLoss ? Number(stopLoss) : null,
      takeProfit: takeProfit ? Number(takeProfit) : null,
      source: 'MANUAL',
    });
    socketBus.emitTo(`room:paper:${req.session.userId}`, 'position:update', result.position);
    socketBus.emitTo(`room:paper:${req.session.userId}`, 'order:update', result.order);
    await broadcastPaperPortfolio(req.session.userId);
    return success(res, result, 'Paper position opened', 201);
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
    const result = await paperEngine.closePosition({ positionId, reason: 'MANUAL' });
    socketBus.emitTo(`room:paper:${req.session.userId}`, 'position:update', result.position);
    await broadcastPaperPortfolio(req.session.userId);
    return success(res, result, 'Paper position closed');
  } catch (err) {
    return next(err);
  }
}

module.exports = { getAccount, addFunds, openPosition, closePosition };
