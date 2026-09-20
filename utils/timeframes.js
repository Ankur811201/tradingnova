'use strict';

// Shared platform timeframe definitions. This is infrastructure, not a model.
const TIMEFRAMES_MS = {
  '1m': 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

// Generic creation-time fallback used by the platform for instances that do
// not explicitly provide a timeframe. MODEL_002 still validates its own
// supported execution timeframes (1m/3m) in its own validators.
const DEFAULT_TIMEFRAME = '5m';

module.exports = { TIMEFRAMES_MS, DEFAULT_TIMEFRAME };
