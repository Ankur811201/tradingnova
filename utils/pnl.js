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

/**
 * Multi-target exit plan — confirmed rules (unchanged, not invented here):
 *   risk = |entryPrice - stopLoss|
 *   T1..T4 = entry +/- (1..4)*risk  (BUY: above entry; SELL: below entry)
 *   each target closes 25% of the ORIGINAL quantity; T4's slice is
 *   whatever remains after T1-T3 (originalQuantity - 3*floor slice),
 *   so the four slices always sum to EXACTLY originalQuantity — no
 *   floating-point drift leaving a nonzero residual after all 4 fire.
 * Returns null if stopLoss is not provided (risk is undefined without it).
 */
function computeMultiTargets(side, entryPrice, stopLoss, originalQuantity) {
  if (stopLoss === null || stopLoss === undefined || !Number.isFinite(stopLoss)) return null;
  if (side !== 'LONG' && side !== 'SHORT') throw new Error(`Unknown side: ${side}`);

  const risk = Math.abs(entryPrice - stopLoss);
  if (!(risk > 0)) return null; // zero/invalid risk distance — cannot derive R-multiples

  const perTargetQuantity = originalQuantity * 0.25;
  const quantities = [perTargetQuantity, perTargetQuantity, perTargetQuantity];
  quantities.push(originalQuantity - quantities.reduce((sum, q) => sum + q, 0)); // T4 = exact remainder

  return [1, 2, 3, 4].map((rMultiple, idx) => ({
    rMultiple,
    price: side === 'LONG' ? entryPrice + rMultiple * risk : entryPrice - rMultiple * risk,
    quantity: quantities[idx],
    hit: false,
    hitAt: null,
  }));
}

module.exports = { computeNotional, computeMargin, computeFee, computePnl, computeMultiTargets };
