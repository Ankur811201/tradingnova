'use strict';

/**
 * Pure, deterministic candle-analysis utilities. No I/O, no randomness, no
 * database access — safe to reuse for live evaluation, historical
 * backtesting, or strategy playback (see patternEngine.js).
 *
 * These are ANALYSIS utilities only. Detecting a condition here does not by
 * itself generate a trade — actual signal generation happens only through
 * enabled PatternEngine rules.
 */

function bodySize(candle) {
  return Math.abs(candle.close - candle.open);
}

function range(candle) {
  return candle.high - candle.low;
}

function upperWick(candle) {
  return candle.high - Math.max(candle.open, candle.close);
}

function lowerWick(candle) {
  return Math.min(candle.open, candle.close) - candle.low;
}

function isBullish(candle) {
  return candle.close > candle.open;
}

function isBearish(candle) {
  return candle.close < candle.open;
}

/** Body size as a fraction of total range (0-1). Returns 0 for a zero-range candle. */
function bodyRatio(candle) {
  const r = range(candle);
  return r > 0 ? bodySize(candle) / r : 0;
}

/** A candle is "doji-like" when its body is a small fraction of its range. */
function isDoji(candle, threshold = 0.1) {
  return bodyRatio(candle) <= threshold;
}

/** Highest high across the given candle window. */
function recentHigh(candles) {
  if (!candles.length) return null;
  return Math.max(...candles.map((c) => c.high));
}

/** Lowest low across the given candle window. */
function recentLow(candles) {
  if (!candles.length) return null;
  return Math.min(...candles.map((c) => c.low));
}

/** Count of consecutive bullish candles ending at the last element of the array. */
function consecutiveBullish(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    if (isBullish(candles[i])) count += 1;
    else break;
  }
  return count;
}

/** Count of consecutive bearish candles ending at the last element of the array. */
function consecutiveBearish(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    if (isBearish(candles[i])) count += 1;
    else break;
  }
  return count;
}

/** Percentage change from `a` to `b`. */
function pctChange(a, b) {
  if (!a) return null;
  return ((b - a) / a) * 100;
}

/**
 * Compares the most recent candle's volume against the average volume of the
 * preceding candles. Returns null (not false) when volume data is
 * unavailable so callers can distinguish "condition failed" from "cannot be
 * evaluated" rather than silently treating missing data as a pass.
 */
function volumeAboveAverage(candles, multiplier) {
  if (!candles.length) return null;
  const current = candles[candles.length - 1];
  const prior = candles.slice(0, -1);
  if (current.volume == null || !prior.length || prior.some((c) => c.volume == null)) return null;
  const avg = prior.reduce((sum, c) => sum + c.volume, 0) / prior.length;
  if (avg <= 0) return null;
  return current.volume >= avg * multiplier;
}

module.exports = {
  bodySize,
  range,
  upperWick,
  lowerWick,
  isBullish,
  isBearish,
  bodyRatio,
  isDoji,
  recentHigh,
  recentLow,
  consecutiveBullish,
  consecutiveBearish,
  pctChange,
  volumeAboveAverage,
};
