'use strict';

/**
 * Pure trading math functions. No I/O, no DB — kept separate so they can be
 * unit tested in isolation and reused consistently by Paper/Live engines.
 *
 * Documented assumptions:
 *   notional = price * quantity
 *   margin   = notional / leverage
 *   fee      = notional * feeRate
 *   LONG  PnL(at price P) = (P - entryPrice) * quantity
 *   SHORT PnL(at price P) = (entryPrice - P) * quantity
 */

function computeNotional(price, quantity) {
  return price * quantity;
}

function computeMargin(notional, leverage) {
  if (!leverage || leverage <= 0) throw new Error('leverage must be positive');
  return notional / leverage;
}

function computeFee(notional, feeRate) {
  return notional * feeRate;
}

function computePnl(side, entryPrice, currentPrice, quantity) {
  if (side === 'LONG') return (currentPrice - entryPrice) * quantity;
  if (side === 'SHORT') return (entryPrice - currentPrice) * quantity;
  throw new Error(`Unknown side: ${side}`);
}

module.exports = { computeNotional, computeMargin, computeFee, computePnl };
