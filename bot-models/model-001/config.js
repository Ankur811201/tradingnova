'use strict';

/**
 * Model 001 configuration constants.
 *
 * DEFAULT_RULESET_V1 is a conservative, illustrative example rule set built
 * only to prove the Model 001 infrastructure works end-to-end. It is NOT the
 * final client trading strategy. See patternEngine.js for the rule logic and
 * bot-models/model-001/README.md for how to replace it later.
 */

const TIMEFRAMES_MS = {
  '1m': 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  // PART A (multi-timeframe infra): '1d' added so higher-timeframe models
  // (e.g. MODEL_002) can hydrate/dispatch on a real Daily bucket. Delta
  // Exchange natively supports 1d (see services/marketData/timeframeMap.js)
  // — this is not a synthetic/aggregated timeframe.
  '1d': 24 * 60 * 60 * 1000,
};

const DEFAULT_RULESET_V1 = 'DEFAULT_RULESET_V1';
const SUPPORTED_RULESETS = [DEFAULT_RULESET_V1];

const QUANTITY_MODES = ['CAPITAL_PERCENT'];

/**
 * Safe defaults for every configurable parameter. Any Bot Instance parameter
 * not supplied by the user falls back to these values. These are also
 * returned via BotModelMetadata (GET /api/bot-models) so Part 2's Bot
 * Management page can render an editable form dynamically.
 */
const DEFAULT_PARAMETERS = {
  // Candle timeframe the model aggregates price ticks into. One of TIMEFRAMES_MS.
  timeframe: '5m',
  // Max closed candles kept in memory (not persisted). 10-500.
  historySize: 100,
  // How many prior candles define the "recent high/low" breakout window.
  breakoutLookback: 20,
  // Minimum body-size / range ratio (0-1) for a candle to count as a confirmation candle.
  minimumBodyRatio: 0.5,
  // Whether the current candle's volume must exceed the recent average * volumeMultiplier.
  // NOTE: price-tick-based candle aggregation does not carry volume data (see
  // candleAggregator.js), so this currently has no effect unless a future
  // MarketDataProvider revision supplies volume-bearing candles. Kept
  // configurable now so the rule framework is ready when it does.
  volumeConfirmationEnabled: false,
  volumeMultiplier: 1.5,
  // Example v1 exit rule: close an open position on an opposing signal. Replace/extend later.
  exitOnOpposingSignal: true,
  // Stop loss / take profit as a percentage of the reference (candle close) price. 0 disables.
  stopLossPercent: 1.0,
  takeProfitPercent: 2.0,
  // If false (default), the model will not open a second same-direction position
  // while one is already open for this instance.
  pyramiding: false,
  // Which PatternEngine rule set to evaluate. Only DEFAULT_RULESET_V1 ships in Part 3.
  ruleSet: DEFAULT_RULESET_V1,
  // How position size is calculated. Only CAPITAL_PERCENT ships in Part 3.
  quantityMode: 'CAPITAL_PERCENT',
  // Fraction (0-1] of the Bot Instance's capitalAllocation to use as notional per trade.
  capitalUsagePercent: 0.5,
};

module.exports = {
  TIMEFRAMES_MS,
  DEFAULT_RULESET_V1,
  SUPPORTED_RULESETS,
  QUANTITY_MODES,
  DEFAULT_PARAMETERS,
};
