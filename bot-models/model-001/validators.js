'use strict';

// PART 11: single source of truth for supported timeframes. Previously this
// file hardcoded its own ['1m','5m','15m','1h','4h','1d'] list, which
// disagreed with config.js's TIMEFRAMES_MS (1m,3m,5m,15m,30m,1h) — the map
// CandlePersistenceService/BotManager/the chart all actually key off of.
// That meant a saved timeframe like '3m' or '30m' could pass this validator
// yet never be recognized anywhere else, and '4h'/'1d' could pass here but
// have no TIMEFRAMES_MS entry (crashing the CandleAggregator constructor).
// Reusing TIMEFRAMES_MS here closes that gap.
const { TIMEFRAMES_MS } = require('./config');

/**
 * Validates and merges parameters for Model001 client strategy logic.
 * Enforces defaults for Top/Bottom price levels, dynamic lot candle points,
 * stop loss buffer, and level execution caps.
 */

function validateAndMergeParameters(customParams = {}) {
  const defaults = {
    historySize: 100,
    mintick: 0.01,

    // Explicit Level Boundaries
    topLevel: 64280,
    bottomLevel: 64024,

    // Candle Size Point Thresholds
    hiPoints: 360,
    miPoints: 250,
    loPoints: 150,
    soatPoints: 70,

    // Dynamic Position Sizing (Lot Units)
    lotHi: 4,
    lotMi: 6,
    lotLo: 7,
    lotSoat: 10,

    // Risk and Limits
    maxTradesPerLevel: 2,
    slBufferPips: 10.0,
    ruleSet: 'CLIENT_MASTER_LOGIC_V1',
  };

  const params = Object.assign({}, defaults, customParams);

  // PART 13.1 -- PHASE D: timeframe has no entry in `defaults` above on
  // purpose. It is an identity-defining field (it decides which candles
  // this instance even receives -- see BotManager's market-data routing),
  // not an optional strategy tuning knob, so this function must never
  // guess it. A bot created before this field existed has
  // customParams.timeframe === undefined; that must fail loudly here
  // rather than quietly resolve to some default candle series the bot was
  // never actually configured for. The ONLY place a deliberate '5m'
  // default may be chosen is at NEW-instance creation time, where it is
  // explicitly written into persisted parameters (see
  // BotManager.createInstance) -- by the time onStart() reaches this
  // validator, timeframe must already be a real, explicit, persisted value.
  if (params.timeframe === undefined || params.timeframe === null || params.timeframe === '') {
    throw new Error('This bot has no configured timeframe. Set a timeframe in the bot configuration before starting it.');
  }

  if (!Object.prototype.hasOwnProperty.call(TIMEFRAMES_MS, params.timeframe)) {
    throw new Error(`Invalid timeframe: ${params.timeframe}. Supported: ${Object.keys(TIMEFRAMES_MS).join(', ')}`);
  }

  if (typeof params.historySize !== 'number' || params.historySize < 50) {
    throw new Error('historySize must be a number >= 50 to compute 50 EMA and Levels.');
  }

  if (typeof params.maxTradesPerLevel !== 'number' || params.maxTradesPerLevel < 1) {
    throw new Error('maxTradesPerLevel must be at least 1.');
  }

  return params;
}

/**
 * Validates OHLCV candle object structure.
 */
function validateCandle(candle) {
  if (!candle || typeof candle !== 'object') return false;
  const { open, high, low, close, timestamp } = candle;
  return [open, high, low, close, timestamp].every(
    val => typeof val === 'number' && Number.isFinite(val) && val > 0
  );
}

module.exports = {
  validateAndMergeParameters,
  validateCandle,
};