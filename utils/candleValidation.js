'use strict';

/**
 * Validates a normalized OHLCV candle. Rejects NaN, missing OHLC,
 * non-positive prices, invalid timestamps, and internally inconsistent
 * high/low values. Volume is optional (may be null/undefined).
 *
 * This is the single source of truth for candle validation — used by
 * MarketDataProvider implementations (services/marketData/) before ever
 * exposing a candle to the rest of Nova Trade, AND by Model 001
 * (bot-models/model-001/validators.js re-exports this) so both layers
 * agree on exactly what counts as a well-formed candle.
 */
function validateCandle(candle) {
  if (!candle || typeof candle !== 'object') return false;
  const { timestamp, open, high, low, close, volume } = candle;

  const core = [timestamp, open, high, low, close];
  if (core.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return false;
  if (timestamp <= 0) return false;
  if ([open, high, low, close].some((n) => n <= 0)) return false;
  if (high < Math.max(open, close, low)) return false;
  if (low > Math.min(open, close, high)) return false;

  if (volume !== undefined && volume !== null) {
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0) return false;
  }
  return true;
}

module.exports = { validateCandle };
