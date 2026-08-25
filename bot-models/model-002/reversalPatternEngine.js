'use strict';

/**
 * MODEL_002 — reversal pattern engine (A/B/C wick-trigger spec).
 *
 * Implements the NEW same-side pattern rule for:
 *   BULLISH + SUPPORT    -> BUY
 *   BEARISH + RESISTANCE -> SELL (exact mirror)
 *
 * This REPLACES the touch/Candle2-search/close-through logic in
 * sameSidePatternEngine.js for these two combinations only. The opposite-
 * side combinations (BULLISH+RESISTANCE, BEARISH+SUPPORT, with their R1/S1
 * one-time calibration) are explicitly out of scope for this spec and keep
 * using the existing sameSidePatternEngine.js logic unchanged — see
 * Model002.js's routing.
 *
 *   A = candle immediately BEFORE the Support/Resistance-touch candle
 *   B = the touch candle itself (becomes Candle 2, NOT Candle 1 — A is
 *       Candle 1)
 *   Validated by BODY only:
 *     BUY:  bodyHigh(B) > bodyHigh(A)
 *     SELL: bodyLow(B)  < bodyLow(A)
 *   Boundaries (WICK, +-5 points, fixed the moment B validates):
 *     upper = B.high + POINT_BUFFER
 *     lower = B.low  - POINT_BUFFER
 *   C = the very next candle after B. The ONLY trigger candle:
 *     BUY:  C.high >= upper -> BUY immediately (wick touch, no close needed)
 *           C.low  <= lower -> INVALID, restart
 *     SELL: C.low  <= lower -> SELL immediately
 *           C.high >= upper -> INVALID, restart
 *     Neither boundary touched -> INVALID, restart (C is the ONLY trigger
 *     candle for this attempt; there is no further waiting — this is an
 *     interpretation of "Candle 3 immediately triggers BUY OR invalidates
 *     the pattern", since the spec defines only these two outcomes for C).
 *   Both boundaries touched within the same candle C: cannot be resolved
 *     from OHLC alone. Reuses the existing live tick/price stream
 *     (type:'price' updates already dispatched by BotManager.dispatchMarketData
 *     to any instance on the symbol — see Model002.js) to see which
 *     boundary was actually touched first; if no live tick evidence reached
 *     this instance before C closed (e.g. replay/hydration, or a feed that
 *     never sent ticks), the ambiguous case conservatively resolves to
 *     INVALID rather than guessing a trade — a documented limitation, not a
 *     silent guess.
 *   Stop loss — tracks ONLY B and C (the pattern resolves in exactly one
 *   candle after B, so there is never a third candle in the sequence):
 *     BUY:  min(B.low, C.low)   - 10
 *     SELL: max(B.high, C.high) + 10
 */

const POINT_BUFFER = 5; // Candle 2 (B) boundary buffer, wick-based
const SL_BUFFER = 10;   // stop-loss buffer, wick-based

// --- Support/Resistance touch (per-candle wick test, single-sided) -----

/** BULLISH+SUPPORT: a wick OR body touch is valid whenever the candle's low reaches the level (does not also require high >= level). */
function touchesSupport(candle, level) {
  return candle.low <= level;
}

/** BEARISH+RESISTANCE mirror: candle's high reaches the level. */
function touchesResistance(candle, level) {
  return candle.high >= level;
}

/** Returns the first configured level (in given order) touched by `candle` for the given direction, or null. */
function findTouchedLevel(levels, candle, direction) {
  const test = direction === 'BUY' ? touchesSupport : touchesResistance;
  for (let i = 0; i < levels.length; i += 1) {
    if (test(candle, levels[i])) return { index: i + 1, price: levels[i] };
  }
  return null;
}

// --- A/B body validation --------------------------------------------------

function bodyHigh(candle) {
  return Math.max(candle.open, candle.close);
}

function bodyLow(candle) {
  return Math.min(candle.open, candle.close);
}

/**
 * BODY-ONLY validation of B (the touch candle) against A (the candle
 * immediately before it). Wick/high-low is never used here (§17 of the
 * spec draws this distinction explicitly).
 *   BUY:  B_bodyHigh > A_bodyHigh
 *   SELL: B_bodyLow  < A_bodyLow
 */
function validateAB(candleA, candleB, direction) {
  if (direction === 'BUY') {
    const aHigh = bodyHigh(candleA);
    const bHigh = bodyHigh(candleB);
    return { valid: bHigh > aHigh, aBodyHigh: aHigh, bBodyHigh: bHigh };
  }
  const aLow = bodyLow(candleA);
  const bLow = bodyLow(candleB);
  return { valid: aLow > bLow, aBodyLow: aLow, bBodyLow: bLow };
}

// --- Candle 2 (B) boundaries ------------------------------------------

/** Fixed the moment B validates. Actual wick high/low +-5, never body. */
function computeBoundaries(candleB) {
  return { upper: candleB.high + POINT_BUFFER, lower: candleB.low - POINT_BUFFER };
}

// --- Candle 3 (C) trigger ------------------------------------------------

/**
 * Evaluates C against the fixed boundaries.
 * `tieBreakSide` ('upper' | 'lower' | null) is the side the live tick
 * stream saw touched FIRST, if both boundaries fall within C's range and
 * tick evidence was actually available — see module docstring.
 *
 * Returns { outcome: 'BUY'|'SELL'|'INVALID', bothTouched: boolean, tieBreakUsed: boolean }
 */
function evaluateCandle3(candleC, boundaries, direction, tieBreakSide) {
  const upperTouched = candleC.high >= boundaries.upper;
  const lowerTouched = candleC.low <= boundaries.lower;
  const triggerSide = direction === 'BUY' ? 'upper' : 'lower'; // side that fires the trade for this direction
  const invalidSide = direction === 'BUY' ? 'lower' : 'upper'; // side that invalidates for this direction

  if (upperTouched && lowerTouched) {
    const winner = tieBreakSide === 'upper' || tieBreakSide === 'lower' ? tieBreakSide : invalidSide; // no tick evidence -> conservative INVALID
    const outcome = winner === triggerSide ? direction : 'INVALID';
    return { outcome, bothTouched: true, tieBreakUsed: tieBreakSide === 'upper' || tieBreakSide === 'lower' };
  }
  if (direction === 'BUY') {
    if (upperTouched) return { outcome: 'BUY', bothTouched: false, tieBreakUsed: false };
    return { outcome: 'INVALID', bothTouched: false, tieBreakUsed: false }; // lowerTouched, or neither (C is the only trigger candle)
  }
  if (lowerTouched) return { outcome: 'SELL', bothTouched: false, tieBreakUsed: false };
  return { outcome: 'INVALID', bothTouched: false, tieBreakUsed: false };
}

// --- Stop loss — tracks only B and C -------------------------------------

/** BUY: lowest wick LOW across B and C, minus 10 points. */
function computeBuyStopLoss(candleB, candleC) {
  return Math.min(candleB.low, candleC.low) - SL_BUFFER;
}

/** SELL: highest wick HIGH across B and C, plus 10 points. */
function computeSellStopLoss(candleB, candleC) {
  return Math.max(candleB.high, candleC.high) + SL_BUFFER;
}

module.exports = {
  POINT_BUFFER,
  SL_BUFFER,
  touchesSupport,
  touchesResistance,
  findTouchedLevel,
  bodyHigh,
  bodyLow,
  validateAB,
  computeBoundaries,
  evaluateCandle3,
  computeBuyStopLoss,
  computeSellStopLoss,
};
