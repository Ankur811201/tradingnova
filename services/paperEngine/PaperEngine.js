'use strict';

const mongoose = require('mongoose');
const { env } = require('../../config/env');
const PaperAccount = require('../../models/PaperAccount');
const Order = require('../../models/Order');
const Position = require('../../models/Position');
const Trade = require('../../models/Trade');
const { getMarketDataProvider } = require('../marketData');
const { newOrderId } = require('../../utils/ids');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/apiResponse');
const { computeNotional, computeMargin, computeFee, computePnl } = require('../../utils/pnl');

/**
 * PaperEngine — complete virtual execution engine. Paper trades NEVER reach
 * Delta Exchange. All balances/positions/orders are persisted in MongoDB.
 *
 * P&L formulas (documented assumptions):
 *   notional        = entryPrice * quantity
 *   margin          = notional / leverage
 *   fee             = notional * feeRate   (charged on open AND close, taker rate used for market orders)
 *   LONG  unrealizedPnl = (currentPrice - entryPrice) * quantity
 *   SHORT unrealizedPnl = (entryPrice - currentPrice) * quantity
 *   realizedPnl (on close) = the unrealized formula evaluated at exitPrice, minus total fees (open+close)
 *   equity = availableBalance + lockedMargin + sum(unrealizedPnl of open positions)
 *
 * This is a simplified (but internally consistent) model: it does not
 * simulate slippage, partial fills, order book depth, or funding payments.
 */
class PaperEngine {
  async ensureAccount(userId) {
    let account = await PaperAccount.findOne({ user: userId });
    if (!account) {
      account = await PaperAccount.create({
        user: userId,
        availableBalance: env.PAPER_INITIAL_BALANCE_USD,
        lockedMargin: 0,
      });
      await logger.info('TRADING', `Paper account initialized for user ${userId} with $${env.PAPER_INITIAL_BALANCE_USD}`);
    }
    return account;
  }

  async addFunds(userId, amount, reason = 'manual top-up') {
    if (!amount || amount <= 0) throw new AppError('amount must be positive', 400);
    const account = await this.ensureAccount(userId);
    account.availableBalance += amount;
    account.fundingHistory.push({ amount, reason, at: new Date() });
    await account.save();
    await logger.info('TRADING', `Added $${amount} virtual funds to user ${userId} paper account`, { reason });
    return account;
  }

  /**
   * Opens a paper position (LONG or SHORT) via a simulated market order.
   * @param {object} params { userId, symbol, side: 'LONG'|'SHORT', quantity, leverage, stopLoss, takeProfit, source, modelId, instanceId, commandId }
   */
  async openPosition(params) {
    const {
      userId, symbol, side, quantity, leverage = 1,
      stopLoss = null, takeProfit = null,
      source = 'MANUAL', modelId = null, instanceId = null, commandId = null,
    } = params;

    if (!['LONG', 'SHORT'].includes(side)) throw new AppError('side must be LONG or SHORT', 400);
    if (!quantity || quantity <= 0) throw new AppError('quantity must be positive', 400);
    if (leverage <= 0 || leverage > env.PAPER_MAX_LEVERAGE) {
      throw new AppError(`leverage must be between 0 and ${env.PAPER_MAX_LEVERAGE}`, 400);
    }

    const provider = getMarketDataProvider();
    let priceInfo;
    try {
      priceInfo = await provider.getPrice(symbol);
    } catch (err) {
      throw new AppError(`Cannot open paper position: no valid market price for ${symbol} (${err.message})`, 503);
    }
    if (!provider.isDataFresh(symbol)) {
      throw new AppError(`Cannot open paper position: market data for ${symbol} is stale`, 503);
    }

    const entryPrice = priceInfo.price;
    const notional = computeNotional(entryPrice, quantity);
    const margin = computeMargin(notional, leverage);
    const fee = computeFee(notional, env.PAPER_TAKER_FEE_RATE);

    const account = await this.ensureAccount(userId);
    const requiredFunds = margin + fee;
    if (account.availableBalance < requiredFunds) {
      const order = await Order.create({
        internalOrderId: newOrderId(),
        environment: 'PAPER',
        source,
        user: userId,
        modelId,
        instanceId,
        commandId,
        symbol,
        side: side === 'LONG' ? 'buy' : 'sell',
        type: 'market',
        quantity,
        requestedPrice: entryPrice,
        leverage,
        stopLoss,
        takeProfit,
        status: 'REJECTED',
        rejectionReason: 'Insufficient paper balance',
      });
      await logger.warn('TRADING', `Paper order ${order.internalOrderId} rejected: insufficient balance`);
      throw new AppError(`Insufficient paper balance: available=${account.availableBalance.toFixed(2)}, required=${requiredFunds.toFixed(2)}`, 400);
    }

    const session = await mongoose.startSession();
    let position;
    let order;
    try {
      await session.withTransaction(async () => {
        account.availableBalance -= requiredFunds;
        account.lockedMargin += margin;
        account.totalFeesPaid += fee;
        await account.save({ session });

        const positions = await Position.create(
          [{
            environment: 'PAPER',
            source,
            user: userId,
            modelId,
            instanceId,
            symbol,
            side,
            entryPrice,
            currentPrice: entryPrice,
            quantity,
            leverage,
            margin,
            stopLoss,
            takeProfit,
            unrealizedPnl: 0,
            feesPaid: fee,
            status: 'OPEN',
          }],
          { session }
        );
        position = positions[0];

        const orders = await Order.create(
          [{
            internalOrderId: newOrderId(),
            environment: 'PAPER',
            source,
            user: userId,
            modelId,
            instanceId,
            commandId,
            symbol,
            side: side === 'LONG' ? 'buy' : 'sell',
            type: 'market',
            quantity,
            requestedPrice: entryPrice,
            executedPrice: entryPrice,
            leverage,
            stopLoss,
            takeProfit,
            fees: fee,
            status: 'FILLED',
            relatedPosition: position._id,
            submittedAt: new Date(),
            filledAt: new Date(),
          }],
          { session }
        );
        order = orders[0];
      });
    } finally {
      session.endSession();
    }

    await logger.info('TRADING', `Paper position opened: ${side} ${quantity} ${symbol} @ ${entryPrice}`, {
      positionId: position._id.toString(), source, instanceId,
    });

    return { position, order, account };
  }

  /**
   * Closes an open paper position at current market price.
   * @param {object} params { positionId, reason }
   */
  async closePosition({ positionId, reason = 'MANUAL' }) {
    const position = await Position.findById(positionId);
    if (!position) throw new AppError('Position not found', 404);
    if (position.environment !== 'PAPER') throw new AppError('Not a paper position', 400);
    if (position.status !== 'OPEN') throw new AppError('Position is not open', 400);

    const provider = getMarketDataProvider();
    let priceInfo;
    try {
      priceInfo = await provider.getPrice(position.symbol);
    } catch (err) {
      throw new AppError(`Cannot close paper position: no valid market price (${err.message})`, 503);
    }

    const exitPrice = priceInfo.price;
    const notional = computeNotional(exitPrice, position.quantity);
    const closeFee = computeFee(notional, env.PAPER_TAKER_FEE_RATE);

    const grossPnl = computePnl(position.side, position.entryPrice, exitPrice, position.quantity);

    const totalFees = position.feesPaid + closeFee;
    const realizedPnl = grossPnl - closeFee; // open fee already deducted from balance at open time

    const account = await this.ensureAccount(position.user);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        account.lockedMargin -= position.margin;
        account.availableBalance += position.margin + realizedPnl;
        account.totalRealizedPnl += realizedPnl;
        account.totalFeesPaid += closeFee;
        await account.save({ session });

        position.status = 'CLOSED';
        position.currentPrice = exitPrice;
        position.unrealizedPnl = 0;
        position.realizedPnl = realizedPnl;
        position.feesPaid = totalFees;
        position.closedAt = new Date();
        position.closeReason = reason;
        await position.save({ session });

        await Trade.create(
          [{
            environment: 'PAPER',
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
            realizedPnl,
            fees: totalFees,
            reason,
            openedAt: position.openedAt,
            closedAt: position.closedAt,
          }],
          { session }
        );

        await Order.create(
          [{
            internalOrderId: newOrderId(),
            environment: 'PAPER',
            source: position.source,
            user: position.user,
            modelId: position.modelId,
            instanceId: position.instanceId,
            symbol: position.symbol,
            side: position.side === 'LONG' ? 'sell' : 'buy',
            type: 'market',
            quantity: position.quantity,
            requestedPrice: exitPrice,
            executedPrice: exitPrice,
            leverage: position.leverage,
            fees: closeFee,
            status: 'FILLED',
            relatedPosition: position._id,
            submittedAt: new Date(),
            filledAt: new Date(),
          }],
          { session }
        );
      });
    } finally {
      session.endSession();
    }

    await logger.info('TRADING', `Paper position closed: ${position.side} ${position.quantity} ${position.symbol} @ ${exitPrice}, pnl=${realizedPnl.toFixed(2)}`, {
      positionId: position._id.toString(), reason,
    });

    return { position, realizedPnl, account };
  }

  /**
   * Refreshes unrealizedPnl for all open paper positions of a symbol using the
   * latest market price. Called from a market-data subscription callback or
   * on an interval. Also checks stop-loss / take-profit triggers.
   */
  async refreshUnrealizedForSymbol(symbol, currentPrice) {
    const openPositions = await Position.find({ environment: 'PAPER', symbol, status: 'OPEN' });
    for (const position of openPositions) {
      const unrealizedPnl = computePnl(position.side, position.entryPrice, currentPrice, position.quantity);
      position.currentPrice = currentPrice;
      position.unrealizedPnl = unrealizedPnl;
      await position.save();

      // Stop loss / take profit monitoring
      let triggerReason = null;
      if (position.stopLoss != null) {
        if (position.side === 'LONG' && currentPrice <= position.stopLoss) triggerReason = 'STOP_LOSS';
        if (position.side === 'SHORT' && currentPrice >= position.stopLoss) triggerReason = 'STOP_LOSS';
      }
      if (!triggerReason && position.takeProfit != null) {
        if (position.side === 'LONG' && currentPrice >= position.takeProfit) triggerReason = 'TAKE_PROFIT';
        if (position.side === 'SHORT' && currentPrice <= position.takeProfit) triggerReason = 'TAKE_PROFIT';
      }
      if (triggerReason) {
        try {
          await this.closePosition({ positionId: position._id, reason: triggerReason });
        } catch (err) {
          await logger.error('TRADING', `Failed to auto-close position ${position._id} on ${triggerReason}: ${err.message}`);
        }
      }
    }
  }
}

module.exports = new PaperEngine();
