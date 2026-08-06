'use strict';

const PaperAccount = require('../../models/PaperAccount');
const Position = require('../../models/Position');
const deltaAdapter = require('../delta/DeltaAdapter');
const { AppError } = require('../../utils/apiResponse');

class PortfolioService {
  async getPaperPortfolio(userId) {
    const account = await PaperAccount.findOne({ user: userId });
    if (!account) {
      throw new AppError('Paper account not found; it initializes automatically on first paper action', 404);
    }
    const openPositions = await Position.find({ environment: 'PAPER', user: userId, status: 'OPEN' }).lean();
    const sumUnrealized = openPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);

    return {
      environment: 'PAPER',
      availableBalance: account.availableBalance,
      lockedMargin: account.lockedMargin,
      equity: account.availableBalance + account.lockedMargin + sumUnrealized,
      totalRealizedPnl: account.totalRealizedPnl,
      totalFeesPaid: account.totalFeesPaid,
      unrealizedPnl: sumUnrealized,
      openPositions,
      initializedAt: account.initializedAt,
    };
  }

  async getLivePortfolio() {
    if (!deltaAdapter.isConfigured()) {
      throw new AppError('Live trading is unavailable: Delta Exchange is not configured.', 503, 'DELTA_NOT_CONFIGURED');
    }
    const [balances, deltaPositions, localPositions, openOrders] = await Promise.all([
      deltaAdapter.getWalletBalances(),
      deltaAdapter.getPositions(),
      Position.find({ environment: 'LIVE', status: 'OPEN' }).lean(),
      deltaAdapter.getActiveOrders(),
    ]);

    return {
      environment: 'LIVE',
      exchangeBalances: balances,
      exchangePositions: deltaPositions,
      localPositions,
      openOrders,
    };
  }
}

module.exports = new PortfolioService();
