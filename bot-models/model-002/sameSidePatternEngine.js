'use strict';

/**
 * MODEL_002 — same-side pattern engine.
 *
 * Implements the fully confirmed same-side patterns:
 *   BULLISH + SUPPORT    -> BUY
 *   BEARISH + RESISTANCE -> SELL
 *
 * The two opposite-side combinations (BULLISH+RESISTANCE, BEARISH+SUPPORT)
 * are explicitly NOT implemented here — Model002.js routes them to an
 * honest WAIT, per the current requirement.
 *
 * The Candle 2 boundary confirmation formula (computeBoundaries /
 * evaluateBoundaryBreak) is now confirmed: fixed at Candle2.high/low the
 * moment Candle 2 validates, monitored across as many future candles as
 * needed (not only the immediate next one), triggering on a strict
 * close-through — touching a boundary or closing exactly at it is never
 * enough on its own.
 */

const POINT_BUFFER = 5; // confirmed fixed 5-point SL buffer

// --- Step 1: Support/Resistance touch (Candle 1) ------------------------

/**
 * A candle "touches" a configured level if its range intersects the exact
 * level price. No tolerance percentage is specified for this pattern (the
 * touch-zone tolerance used elsewhere in MODEL_002 is a distinct concept
 * for a different, already-confirmed rule) — so this is an exact-price
 * range test, not padded with an invented tolerance.
 */
function touchesLevelExact(level, candle) {
  return candle.low <= level && candle.high >= level;
}

/** Returns the first configured level (in given order) touched by `candle`, or null. */
function findTouchedLevel(levels, candle) {
  for (let i = 0; i < levels.length; i += 1) {
    if (touchesLevelExact(levels[i], candle)) {
      return { index: i + 1, price: levels[i] };
    }
  }
  return null;
}

// --- Step 2 (BUY) / Step 1 (SELL): Stop Loss -----------------------------

/** BULLISH+SUPPORT: stopLoss = Candle1.low - 5 points (confirmed fixed buffer). */
function computeBuyStopLoss(candle1) {
  return candle1.low - POINT_BUFFER;
}

/** BEARISH+RESISTANCE: stopLoss = Candle1.high + 5 points (confirmed fixed buffer). */
function computeSellStopLoss(candle1) {
  return candle1.high + POINT_BUFFER;
}

// --- Step 3 (BUY) / Step 2 (SELL): Candle 2 body-high/body-low touch ----

function bodyHigh(candle) {
  return Math.max(candle.open, candle.close);
}

function bodyLow(candle) {
  return Math.min(candle.open, candle.close);
}

/** Candle 2 must touch Candle 1's body-high (BUY) — same exact-price range test as level touches, no invented tolerance. */
function candle2TouchesBodyHigh(candle1, candle2) {
  const target = bodyHigh(candle1);
  return candle2.low <= target && candle2.high >= target;
}

/** Candle 2 must touch Candle 1's body-low (SELL). */
function candle2TouchesBodyLow(candle1, candle2) {
  const target = bodyLow(candle1);
  return candle2.low <= target && candle2.high >= target;
}

// --- Step 4 (BUY) / Step 3 (SELL): Candle 2 point calculation -----------

/**
 * Computes UpperP/LowerP/Body/BodyP for Candle 2, per the confirmed
 * formulas. Body is always abs(close-open) regardless of direction
 * (explicitly stated as the general rule); UpperP/LowerP use the
 * direction-specific formulas from the requirement (verified against both
 * worked examples below).
 *
 * BUY (bullish Candle 2):  UpperP = High-Close,  LowerP = Open-Low
 * SELL (bearish Candle 2): UpperP = High-Open,   LowerP = Close-Low
 */
function computeCandle2Points(candle2, direction) {
  const body = Math.abs(candle2.close - candle2.open);
  const bodyP = 2.5 * body;
  const upperP = direction === 'BUY'
    ? candle2.high - candle2.close
    : candle2.high - candle2.open;
  const lowerP = direction === 'BUY'
    ? candle2.open - candle2.low
    : candle2.close - candle2.low;
  return { upperP, lowerP, body, bodyP };
}

/** Step 5 (BUY) / Step 4 (SELL): BodyP must be the maximum of the three. */
function isBodyPMaximum(points) {
  return points.bodyP >= points.upperP && points.bodyP >= points.lowerP;
}

/** Step 6 (BUY) / Step 5 (SELL): Candle 2 nature must match the trade direction. */
function isCorrectCandleNature(candle2, direction) {
  return direction === 'BUY' ? candle2.close > candle2.open : candle2.close < candle2.open;
}

/**
 * Full Candle 2 validation for a given direction ('BUY' or 'SELL').
 * Stops at the first failing check and reports which one, per "discard
 * candidate, do not force a trade."
 */
function evaluateCandle2(candle1, candle2, direction) {
  const touched = direction === 'BUY'
    ? candle2TouchesBodyHigh(candle1, candle2)
    : candle2TouchesBodyLow(candle1, candle2);
  if (!touched) {
    return { valid: false, reason: direction === 'BUY' ? 'candle2_did_not_touch_body_high' : 'candle2_did_not_touch_body_low' };
  }

  const points = computeCandle2Points(candle2, direction);
  const bodyPIsMax = isBodyPMaximum(points);
  if (!bodyPIsMax) {
    return { valid: false, reason: 'bodyP_not_maximum', points };
  }

  const correctNature = isCorrectCandleNature(candle2, direction);
  if (!correctNature) {
    return { valid: false, reason: direction === 'BUY' ? 'candle2_not_bullish' : 'candle2_not_bearish', points };
  }

  return { valid: true, reason: 'candle2_confirmed', points };
}

// --- Step 8+: Candle 2 boundaries + confirmation/invalidation/WAIT -------

/**
 * CONFIRMED: the boundaries are fixed at Candle 2's own high/low the
 * moment Candle 2 validates — they never move with later candles.
 * Same formula for both directions (only the confirmation/invalidation
 * meaning of "close through upper" vs "close through lower" differs).
 */
function computeBoundaries(candle2) {
  return { upper: candle2.high, lower: candle2.low };
}

/**
 * Evaluates one future candle against the fixed boundaries. Confirmed
 * rules (strict close-through, touching alone is never enough, exactly-at
 * the boundary is WAIT not a trigger):
 *
 * BUY:  close >  boundaries.upper -> 'BUY'
 *       close <  boundaries.lower -> 'INVALID'
 *       otherwise (including close === upper or === lower, or any touch
 *       without closing through)                -> 'WAIT'
 *
 * SELL (mirror): close < boundaries.lower -> 'SELL'
 *                close > boundaries.upper -> 'INVALID'
 *                otherwise                -> 'WAIT'
 */
function evaluateBoundaryBreak(candle, boundaries, direction) {
  if (direction === 'BUY') {
    if (candle.close > boundaries.upper) return { outcome: 'BUY' };
    if (candle.close < boundaries.lower) return { outcome: 'INVALID' };
    return { outcome: 'WAIT' };
  }
  if (candle.close < boundaries.lower) return { outcome: 'SELL' };
  if (candle.close > boundaries.upper) return { outcome: 'INVALID' };
  return { outcome: 'WAIT' };
}

// --- Risk length -> lot mapping ------------------------------------------

/**
 * Confirmed project rule: 1 lot = 0.001 BTC. computeLotFromRiskLength below
 * returns a lot COUNT (an integer 4-10, or null) — it is NOT a tradable
 * quantity by itself. Every caller must convert lot count -> BTC quantity
 * via computeQuantityFromLot before it reaches a TradeCommand, RiskEngine,
 * or PaperEngine (all of which treat `quantity` as base-asset units, i.e.
 * notional = referencePrice * quantity — see RiskEngine.js and
 * PaperEngine.js's documented P&L formulas).
 */
const LOT_SIZE_BTC = 0.001;

/**
 * Converts a lot COUNT (from computeLotFromRiskLength) into a BTC quantity.
 * Returns null unchanged (never fabricates a quantity for an invalid lot).
 * Rounded to kill floating-point dust (e.g. 9 * 0.001 !== 0.009 in IEEE754)
 * while keeping the exact 3-decimal-place value the lot table implies.
 */
function computeQuantityFromLot(lot) {
  if (lot === null || lot === undefined || !Number.isFinite(lot)) return null;
  return Number((lot * LOT_SIZE_BTC).toFixed(8));
}

/** BUY: riskLength = Entry - StopLoss. */
function computeBuyRiskLength(entryPrice, stopLoss) {
  return entryPrice - stopLoss;
}

/** SELL: riskLength = StopLoss - Entry. */
function computeSellRiskLength(entryPrice, stopLoss) {
  return stopLoss - entryPrice;
}

/**
 * Confirmed natural-number lot mapping. Boundaries taken literally from
 * the requirement: BUY-side table uses inclusive lower/upper bounds per
 * band as written (330<=x<=360 -> 4; 280<=x<330 -> 5; ...; 0<=x<90 -> 10);
 * riskLength > 360 -> null (NO TRADE). Always returns an integer, never a
 * decimal.
 */
function computeLotFromRiskLength(riskLength) {
  if (!Number.isFinite(riskLength) || riskLength < 0) return null;
  if (riskLength > 360) return null;
  if (riskLength >= 330) return 4;
  if (riskLength >= 280) return 5;
  if (riskLength >= 200) return 6;
  if (riskLength >= 140) return 7;
  if (riskLength >= 110) return 8;
  if (riskLength >= 90) return 9;
  return 10;
}

module.exports = {
  POINT_BUFFER,
  touchesLevelExact,
  findTouchedLevel,
  computeBuyStopLoss,
  computeSellStopLoss,
  bodyHigh,
  bodyLow,
  candle2TouchesBodyHigh,
  candle2TouchesBodyLow,
  computeCandle2Points,
  isBodyPMaximum,
  isCorrectCandleNature,
  evaluateCandle2,
  computeBoundaries,
  evaluateBoundaryBreak,
  computeBuyRiskLength,
  computeSellRiskLength,
  computeLotFromRiskLength,
  LOT_SIZE_BTC,
  computeQuantityFromLot,
};
