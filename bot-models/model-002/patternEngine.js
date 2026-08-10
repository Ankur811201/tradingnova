'use strict';

const { bodySize, bodyHigh, bodyLow } = require('./indicators');

/**
 * MODEL_002 — user-level touch zone + the client's confirmed counter-trend
 * confirmation formulas. Implements ONLY what is confirmed; the two
 * "direct-entry" formulas (BULLISH+SUPPORT, BEARISH+RESISTANCE) are
 * intentionally NOT implemented here — see Model002.js, which routes those
 * cases to an honest WAIT('direct_entry_pending_client_confirmation')
 * rather than inventing a rule.
 */

/** Zone-intersection touch test (kept from the prior implementation — it's a generic, correct geometric test, not strategy-specific). */
function touchesZone(level, touchTolerancePct, candle) {
  const zoneUpper = level * (1 + touchTolerancePct);
  const zoneLower = level * (1 - touchTolerancePct);
  return candle.low <= zoneUpper && candle.high >= zoneLower;
}

/**
 * Counter-trend BUY confirmation (BEARISH trend + SUPPORT touch) — client's
 * confirmed formula:
 *   Level 1:    confirmationCandle.close > bodyHigh(referenceCandle=candle before the touch candle)
 *               AND bodySize(confirmationCandle) >= 1.5 * bodySize(referenceCandle)
 *   Levels 2/3: confirmationCandle.close > bodyHigh(referenceCandle=the touch candle itself)
 *               AND bodySize(confirmationCandle) >= 1.5 * bodySize(referenceCandle)
 *
 * @param {number} levelIndex 1, 2, or 3 (which configured level was touched)
 */
function evaluateCounterTrendBuy(levelIndex, referenceCandle, confirmationCandle) {
  const refBodyHigh = bodyHigh(referenceCandle);
  const refBody = bodySize(referenceCandle);
  const confBody = bodySize(confirmationCandle);

  const closeAboveRefBodyHigh = confirmationCandle.close > refBodyHigh;
  const bodyRulePassed = confBody >= 1.5 * refBody;
  const passed = closeAboveRefBodyHigh && bodyRulePassed;

  return {
    passed,
    levelIndex,
    referenceBodyHigh: refBodyHigh,
    referenceBodySize: refBody,
    confirmationBodySize: confBody,
    closeAboveRefBodyHigh,
    bodyRulePassed,
    reason: passed
      ? 'Counter-trend BUY confirmation satisfied'
      : !closeAboveRefBodyHigh
        ? `Confirmation close (${confirmationCandle.close}) did not close above reference body high (${refBodyHigh})`
        : `Confirmation body (${confBody}) did not reach 1.5x reference body (${refBody})`,
  };
}

/**
 * Counter-trend SELL confirmation (BULLISH trend + RESISTANCE touch) —
 * exact mirror of evaluateCounterTrendBuy using bodyLow / close-below.
 */
function evaluateCounterTrendSell(levelIndex, referenceCandle, confirmationCandle) {
  const refBodyLow = bodyLow(referenceCandle);
  const refBody = bodySize(referenceCandle);
  const confBody = bodySize(confirmationCandle);

  const closeBelowRefBodyLow = confirmationCandle.close < refBodyLow;
  const bodyRulePassed = confBody >= 1.5 * refBody;
  const passed = closeBelowRefBodyLow && bodyRulePassed;

  return {
    passed,
    levelIndex,
    referenceBodyLow: refBodyLow,
    referenceBodySize: refBody,
    confirmationBodySize: confBody,
    closeBelowRefBodyLow,
    bodyRulePassed,
    reason: passed
      ? 'Counter-trend SELL confirmation satisfied'
      : !closeBelowRefBodyLow
        ? `Confirmation close (${confirmationCandle.close}) did not close below reference body low (${refBodyLow})`
        : `Confirmation body (${confBody}) did not reach 1.5x reference body (${refBody})`,
  };
}

module.exports = {
  touchesZone,
  evaluateCounterTrendBuy,
  evaluateCounterTrendSell,
};
