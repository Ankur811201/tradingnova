'use strict';

/**
 * MODEL_002 — risk/sizing math. Pure functions, no I/O. Implements
 * MODEL_002_SPEC.md §12 (structural stop loss), §13 (risk-based
 * quantity), §14 (take profit), §15 (trailing stop).
 */

/**
 * Structural stop loss — spec §12. `swingPrice` is the same swing that
 * defined the traded support/resistance level (structureEngine's
 * mostRecentSwing result).
 */
function computeStopLoss(direction, swingPrice, slBufferPct) {
  return direction === 'LONG'
    ? swingPrice * (1 - slBufferPct)
    : swingPrice * (1 + slBufferPct);
}

/**
 * Validates the SL risk distance falls within the configured min/max
 * band (spec §12). Never clamps — a setup outside this band is rejected
 * entirely.
 */
function validateSlDistance(entryPrice, stopLossPrice, minPct, maxPct) {
  const riskDistance = Math.abs(entryPrice - stopLossPrice);
  const riskDistancePct = entryPrice > 0 ? riskDistance / entryPrice : Infinity;
  const valid = riskDistancePct >= minPct && riskDistancePct <= maxPct;
  return { valid, riskDistance, riskDistancePct };
}

/**
 * Risk-based quantity — spec §13 (PAPER-only formula, verified/approved;
 * no Delta contract-size conversion — out of scope per MODEL_002_SPEC.md
 * §0). Returns null (not 0, not fabricated) when the risk distance is
 * zero/invalid so callers never divide by zero.
 */
function computeQuantity(capitalAllocation, riskPercent, entryPrice, stopLossPrice, decimalPrecision) {
  const riskAmountUsd = capitalAllocation * riskPercent;
  const riskDistance = Math.abs(entryPrice - stopLossPrice);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
    return { quantity: null, riskAmountUsd, rawQuantity: null };
  }
  const rawQuantity = riskAmountUsd / riskDistance;
  const scale = Math.pow(10, decimalPrecision);
  const quantity = Math.floor(rawQuantity * scale) / scale;
  return { quantity, riskAmountUsd, rawQuantity };
}

/**
 * Take profit — spec §14. Default RR = 2 (1:2), configurable.
 */
function computeTakeProfit(direction, entryPrice, stopLossPrice, riskRewardRatio) {
  const riskDistance = Math.abs(entryPrice - stopLossPrice);
  return direction === 'LONG'
    ? entryPrice + riskRewardRatio * riskDistance
    : entryPrice - riskRewardRatio * riskDistance;
}

/**
 * Trailing-stop trigger price — spec §15. Begins trailing once unrealized
 * profit reaches +1R (configurable via trailingTriggerR).
 */
function computeTrailingTrigger(direction, entryPrice, riskDistance, trailingTriggerR) {
  return direction === 'LONG'
    ? entryPrice + trailingTriggerR * riskDistance
    : entryPrice - trailingTriggerR * riskDistance;
}

/**
 * Trailing-stop movement — spec §15. Monotonic, one-directional only:
 * LONG only ever moves up, SHORT only ever moves down. `currentTrailingStop`
 * is the trail's current value (initialized to the original structural SL
 * at trigger time by the caller); `latestConfirmedSwingPrice` is the most
 * recently confirmed 1M swing low (LONG) / swing high (SHORT).
 */
function updateTrailingStop(direction, currentTrailingStop, latestConfirmedSwingPrice, slBufferPct) {
  if (latestConfirmedSwingPrice === null || latestConfirmedSwingPrice === undefined) {
    return currentTrailingStop;
  }
  const candidate = direction === 'LONG'
    ? latestConfirmedSwingPrice * (1 - slBufferPct)
    : latestConfirmedSwingPrice * (1 + slBufferPct);

  return direction === 'LONG'
    ? Math.max(currentTrailingStop, candidate)
    : Math.min(currentTrailingStop, candidate);
}

module.exports = {
  computeStopLoss,
  validateSlDistance,
  computeQuantity,
  computeTakeProfit,
  computeTrailingTrigger,
  updateTrailingStop,
};
