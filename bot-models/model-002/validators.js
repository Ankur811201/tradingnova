'use strict';

const { SUPPORTED_TIMEFRAMES, DEFAULT_HISTORY_SIZE, DEFAULT_PARAMETERS } = require('./config');

const MAX_LEVELS = 3;

const REQUIRED_LEVEL_COUNT = 3;

/**
 * Validates and merges parameters for MODEL_002 — current confirmed
 * requirements. `trend` is required with no default (never guessed);
 * `timeframe` must be one of the two currently supported values;
 * `support`/`resistance` must each contain EXACTLY 3 user-supplied
 * numeric levels (never auto-populated, never optional) — this matches
 * the Create Bot form, which requires all 3 of each.
 */
function validateAndMergeParameters(customParams = {}) {
  const params = Object.assign({}, DEFAULT_PARAMETERS, customParams);

  if (!SUPPORTED_TIMEFRAMES.includes(params.timeframe)) {
    throw new Error(
      `MODEL_002 execution timeframe must be one of ${SUPPORTED_TIMEFRAMES.join(', ')}; received '${params.timeframe}'.`
    );
  }

  if (typeof params.historySize !== 'number' || params.historySize < DEFAULT_HISTORY_SIZE) {
    throw new Error(`MODEL_002 requires historySize >= ${DEFAULT_HISTORY_SIZE}; received ${params.historySize}.`);
  }

  if (params.trend !== 'BULLISH' && params.trend !== 'BEARISH') {
    throw new Error(`MODEL_002 requires trend to be 'BULLISH' or 'BEARISH' (user-provided, never calculated); received ${JSON.stringify(params.trend)}.`);
  }

  for (const key of ['support', 'resistance']) {
    const levels = params[key];
    if (!Array.isArray(levels)) {
      throw new Error(`MODEL_002 parameter '${key}' must be an array of user-provided levels; received ${JSON.stringify(levels)}.`);
    }
    if (levels.length !== REQUIRED_LEVEL_COUNT) {
      throw new Error(`MODEL_002 requires exactly ${REQUIRED_LEVEL_COUNT} ${key} levels; received ${levels.length}.`);
    }
    for (const level of levels) {
      if (typeof level !== 'number' || !Number.isFinite(level) || level <= 0) {
        throw new Error(`MODEL_002 parameter '${key}' contains an invalid level: ${JSON.stringify(level)}.`);
      }
    }
  }

  const numericParams = [
    'touchTolerancePct', 'slBufferPct', 'slMinDistancePct', 'slMaxDistancePct',
    'riskPercent', 'quantityDecimalPrecision', 'riskRewardRatio', 'consecutiveLossLimit',
  ];
  for (const key of numericParams) {
    if (typeof params[key] !== 'number' || !Number.isFinite(params[key])) {
      throw new Error(`MODEL_002 parameter '${key}' must be a finite number; received ${params[key]}.`);
    }
  }

  return params;
}

/**
 * Validates OHLCV candle object structure. Same generic shape/contract as
 * before — unchanged by this requirements revision.
 */
function validateCandle(candle) {
  if (!candle || typeof candle !== 'object') return false;
  const { open, high, low, close, timestamp } = candle;
  return [open, high, low, close, timestamp].every(
    (val) => typeof val === 'number' && Number.isFinite(val) && val > 0
  );
}

module.exports = {
  validateAndMergeParameters,
  validateCandle,
  MAX_LEVELS,
  REQUIRED_LEVEL_COUNT,
};
