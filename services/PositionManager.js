/**
 * Position Manager Service
 * Single source of truth for PnL calculations, position risk, and order boundaries
 */
class PositionManager {
  /**
   * Calculate Unrealized PnL and PnL Percentage for an Active Position
   * @param {Object} position Active position object
   * @param {number} currentPrice Latest market price tick
   */
  calculateUnrealizedPnL(position, currentPrice) {
    if (!position) return null;

    const { side, entryPrice, leverage = 1, quantity = 1 } = position;
    let pnl = 0;
    let pnlPct = 0;

    if (side === 'BUY' || side === 'LONG') {
      pnl = (currentPrice - entryPrice) * quantity;
      pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100 * leverage;
    } else if (side === 'SELL' || side === 'SHORT') {
      pnl = (entryPrice - currentPrice) * quantity;
      pnlPct = ((entryPrice - currentPrice) / entryPrice) * 100 * leverage;
    }

    return {
      ...position,
      currentPrice,
      pnl: Number(pnl.toFixed(2)),
      pnlPct: Number(pnlPct.toFixed(2))
    };
  }

  /**
   * Check if Current Market Price Triggers Stop Loss or Take Profit
   * @param {Object} position Active position with stopLoss and takeProfit bounds
   * @param {number} currentPrice Latest market price tick
   */
  checkExitConditions(position, currentPrice) {
    if (!position) return { shouldClose: false, reason: null };

    const { side, stopLoss, takeProfit } = position;

    if (side === 'BUY' || side === 'LONG') {
      if (stopLoss && currentPrice <= stopLoss) {
        return { shouldClose: true, reason: 'STOP_LOSS_HIT', price: stopLoss };
      }
      if (takeProfit && currentPrice >= takeProfit) {
        return { shouldClose: true, reason: 'TAKE_PROFIT_HIT', price: takeProfit };
      }
    } else if (side === 'SELL' || side === 'SHORT') {
      if (stopLoss && currentPrice >= stopLoss) {
        return { shouldClose: true, reason: 'STOP_LOSS_HIT', price: stopLoss };
      }
      if (takeProfit && currentPrice <= takeProfit) {
        return { shouldClose: true, reason: 'TAKE_PROFIT_HIT', price: takeProfit };
      }
    }

    return { shouldClose: false, reason: null };
  }

  /**
   * Calculate Position Size based on Capital, Risk %, and Leverage
   * @param {number} capital Total capital allocated to bot
   * @param {number} riskPct Percentage of capital to risk per trade (e.g. 2%)
   * @param {number} entryPrice Entry price of asset
   * @param {number} stopLoss Target stop loss price
   * @param {number} leverage Leverage multiplier (default 1)
   */
  calculatePositionSize(capital, riskPct, entryPrice, stopLoss, leverage = 1) {
    const riskAmount = capital * (riskPct / 100);
    const priceRiskPerUnit = Math.abs(entryPrice - stopLoss);

    if (priceRiskPerUnit === 0) return 0;

    let units = riskAmount / priceRiskPerUnit;
    const maxLeveragedCap = capital * leverage;
    const positionValue = units * entryPrice;

    // Cap at maximum allowable leverage limits
    if (positionValue > maxLeveragedCap) {
      units = maxLeveragedCap / entryPrice;
    }

    return Number(units.toFixed(4));
  }
}

module.exports = new PositionManager();