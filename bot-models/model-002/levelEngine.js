'use strict';

/**
 * MODEL_002 — user-configured support/resistance level engine.
 *
 * Per the confirmed requirements: support/resistance levels are supplied
 * directly by the user (up to 3 each) and are NEVER auto-detected or
 * replaced. This module only detects whether a closed candle touches one
 * or more of the configured levels, and — per the confirmed rule "if
 * multiple levels are reached, use the last level" — resolves which one
 * to use.
 *
 * "Last level" is implemented literally as stated: iterating the user's
 * configured level list in the order given (index 0..2, i.e. S1/R1 first,
 * S3/R3 last) and keeping the LAST one whose zone the candle's range
 * intersects. No other priority scheme (closest level, first level, etc.)
 * is invented. This is isolated in its own function specifically so the
 * client can change the tie-break rule later without touching anything
 * else (per the confirmed requirement to keep this replaceable).
 */

const { touchesZone } = require('./patternEngine');

/**
 * @param {number[]} levels up to 3 configured levels (support or resistance), in user-given order
 * @param {object} candle the candle to test
 * @param {number} touchTolerancePct
 * @returns {{index:number, price:number}|null} the matched level (1-based index) or null if none touched
 */
function resolveTouchedLevel(levels, candle, touchTolerancePct) {
  if (!Array.isArray(levels) || !levels.length) return null;

  let matched = null;
  for (let i = 0; i < levels.length; i += 1) {
    const price = levels[i];
    if (typeof price !== 'number' || !Number.isFinite(price)) continue;
    if (touchesZone(price, touchTolerancePct, candle)) {
      matched = { index: i + 1, price }; // "last level" wins — keep overwriting as we scan forward
    }
  }
  return matched;
}

module.exports = { resolveTouchedLevel };
