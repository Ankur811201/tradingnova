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

/**
 * Maximum allowed notional exposure — confirmed formula:
 *   maximumAllowedNotional = maximumCapital x leverage
 * (maximumCapital is NOT itself the notional ceiling — leverage multiplies it.)
 */
function computeMaxAllowedNotional(maximumCapital, leverage) {
  if (!Number.isFinite(maximumCapital) || maximumCapital <= 0) return null;
  if (!Number.isFinite(leverage) || leverage <= 0) return null;
  return maximumCapital * leverage;
}

/**
 * Caps position exposure to maximumAllowedNotional (= maximumCapital x
 * leverage, confirmed §1/§1.2). If the risk-sized quantity's notional
 * (entryPrice x quantity) exceeds it, quantity is reduced so notional
 * never exceeds the ceiling — recomputed and re-verified after rounding
 * so floating-point precision can never push it back above the limit.
 * Never increases quantity beyond what the risk formula already computed.
 */
function capExposureToMaxNotional(quantity, entryPrice, maximumCapital, leverage, decimalPrecision) {
  if (quantity === null || !Number.isFinite(quantity) || quantity <= 0) {
    return { quantity, notional: null, capped: false, maximumAllowedNotional: null };
  }
  const maximumAllowedNotional = computeMaxAllowedNotional(maximumCapital, leverage);
  const notional = entryPrice * quantity;

  if (maximumAllowedNotional === null) {
    // No usable max-capital/leverage configured — nothing to cap against.
    return { quantity, notional, capped: false, maximumAllowedNotional: null };
  }
  if (notional <= maximumAllowedNotional) {
    return { quantity, notional, capped: false, maximumAllowedNotional };
  }

  const scale = Math.pow(10, decimalPrecision);
  let cappedQuantity = Math.floor((maximumAllowedNotional / entryPrice) * scale) / scale;
  let finalNotional = entryPrice * cappedQuantity;

  // Guard against floating-point rounding pushing finalNotional back above
  // the ceiling (confirmed §1.2: "never allow floating-point rounding to
  // push it above the limit") — step down by one precision unit until it
  // genuinely fits, or until quantity hits zero.
  while (finalNotional > maximumAllowedNotional && cappedQuantity > 0) {
    cappedQuantity = Math.round((cappedQuantity - 1 / scale) * scale) / scale;
    finalNotional = entryPrice * cappedQuantity;
  }

  return {
    quantity: cappedQuantity > 0 ? cappedQuantity : null,
    notional: cappedQuantity > 0 ? finalNotional : null,
    capped: true,
    maximumAllowedNotional,
  };
}

module.exports = {
  computeStopLoss,
  validateSlDistance,
  computeQuantity,
  computeTakeProfit,
  computeTrailingTrigger,
  updateTrailingStop,
  computeMaxAllowedNotional,
  capExposureToMaxNotional,
};
