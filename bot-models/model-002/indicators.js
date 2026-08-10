'use strict';

/**
 * MODEL_002 — pure candle-analysis primitives. No I/O, no randomness, no
 * wall-clock reads, no lookahead.
 */

function bodySize(candle) {
  return Math.abs(candle.close - candle.open);
}

/** The higher of open/close — "candle body high" as used in the client's confirmed confirmation formulas. */
function bodyHigh(candle) {
  return Math.max(candle.open, candle.close);
}

/** The lower of open/close — "candle body low" as used in the client's confirmed confirmation formulas. */
function bodyLow(candle) {
  return Math.min(candle.open, candle.close);
}

function isBullish(candle) {
  return candle.close > candle.open;
}

function isBearish(candle) {
  return candle.close < candle.open;
}

module.exports = {
  bodySize,
  bodyHigh,
  bodyLow,
  isBullish,
  isBearish,
};
