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
 *   A = Candle 1 — the candle immediately BEFORE the Support/Resistance-
 *       touch candle
 *   B = Candle 2 — the level-touch candle itself (it is Candle 2, NOT
 *       Candle 1)
 *   Validated by BODY only:
 *     BUY:  bodyHigh(B) > bodyHigh(A)
 *     SELL: bodyLow(B)  < bodyLow(A)
 *   Boundaries (WICK, +-5 points, fixed the moment B validates):
 *     upper = B.high + POINT_BUFFER
 *     lower = B.low  - POINT_BUFFER
 *   C = Candle 3, the first candle evaluated after B — and then Candle 4,
 *   Candle 5, ... every later candle, against the SAME fixed boundaries.
 *   The boundaries are computed ONCE from B and are never recomputed from
 *   a later candle, no matter how many candles the pattern waits:
 *     BUY:  candle.high >= upper -> BUY immediately (wick touch, no close needed)
 *           candle.low  <= lower -> INVALID, restart
 *     SELL: candle.low  <= lower -> SELL immediately
 *           candle.high >= upper -> INVALID, restart
 *     Neither boundary touched -> WAIT. The pattern stays active and the
 *     next candle is evaluated against the same boundaries; "no trigger"
 *     is explicitly NOT "invalid" (confirmed correction). The boundaries
 *     are never recomputed from a later candle.
 *   Both boundaries touched within the same candle C: cannot be resolved
 *     from OHLC alone. Reuses the existing live tick/price stream
 *     (type:'price' updates already dispatched by BotManager.dispatchMarketData
 *     to any instance on the symbol — see Model002.js) to see which
 *     boundary was actually touched first; if no live tick evidence reached
 *     this instance before C closed (e.g. replay/hydration, or a feed that
 *     never sent ticks), the ambiguous case conservatively resolves to
 *     INVALID rather than guessing a trade — a documented limitation, not a
 *     silent guess.
 *   Stop loss — a running extreme across the WHOLE evaluation window, not
 *   just two candles. Because a pattern may WAIT through Candle 3, 4,
 *   5, ..., the caller (Model002._confirmAndSubmitNew) passes the running
 *   low/high accumulated from Candle 2 up to and including the triggering
 *   candle, and these helpers apply the buffer to it:
 *     BUY:  min(low  over B..trigger candle) - 10
 *     SELL: max(high over B..trigger candle) + 10
 *   The two-argument shape below is kept as-is (first argument carries the
 *   running window extreme, second the triggering candle); the formula
 *   itself is unchanged and is INDEPENDENT of the OLD engine's SL — the
 *   two must never be merged.
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
 * Evaluates one candle against the fixed boundaries.
 * `tieBreakSide` ('upper' | 'lower' | null) is the side the live tick
 * stream saw touched FIRST, if both boundaries fall within the candle's
 * range and tick evidence was actually available — see module docstring.
 *
 * Returns { outcome: 'BUY'|'SELL'|'INVALID'|'WAIT', bothTouched: boolean, tieBreakUsed: boolean }
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
  // CONFIRMED CORRECTION: "no trigger" is NOT "invalid". A candle that
  // stays strictly between the two boundaries resolves to WAIT — the
  // pattern stays active, the boundaries stay fixed at Candle 2's own
  // high/low +-5, and the NEXT candle is evaluated against those same
  // boundaries. Only a WRONG-boundary touch/cross invalidates.
  if (!upperTouched && !lowerTouched) {
    return { outcome: 'WAIT', bothTouched: false, tieBreakUsed: false };
  }
  if (direction === 'BUY') {
    if (upperTouched) return { outcome: 'BUY', bothTouched: false, tieBreakUsed: false };
    return { outcome: 'INVALID', bothTouched: false, tieBreakUsed: false }; // wrong boundary (lower) touched
  }
  if (lowerTouched) return { outcome: 'SELL', bothTouched: false, tieBreakUsed: false };
  return { outcome: 'INVALID', bothTouched: false, tieBreakUsed: false }; // wrong boundary (upper) touched
}

// --- Stop loss — running extreme across B .. trigger candle --------------

/** BUY: lowest wick LOW across the evaluation window (B up to and including the triggering candle), minus 10 points. Caller passes the running window low as `candleB`. */
function computeBuyStopLoss(candleB, candleC) {
  return Math.min(candleB.low, candleC.low) - SL_BUFFER;
}

/** SELL: highest wick HIGH across the evaluation window (B up to and including the triggering candle), plus 10 points. Caller passes the running window high as `candleB`. */
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
