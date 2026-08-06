'use strict';

/**
 * Maps Nova Trade timeframe strings (as used by Model 001 / bot-models/model-001/config.js
 * TIMEFRAMES_MS) to Delta Exchange's /v2/history/candles `resolution` values.
 *
 * Verified against official Delta documentation (Delta Exchange support article
 * "Kickstarting Your Trading Journey with Delta Exchange APIs" + docs.delta.exchange):
 * supported resolutions are 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 1d, 7d, 30d, 1w, 2w.
 *
 * Every timeframe Nova Trade/Model 001 currently supports (1m,3m,5m,15m,30m,1h) is
 * natively supported by Delta — no client-side aggregation is required or performed.
 * If a future Nova timeframe is added that Delta does NOT support, this module
 * rejects it explicitly (see mapTimeframe) rather than silently aggregating or
 * guessing, per the "do not assume every timeframe is supported" requirement.
 */

const NOVA_TO_DELTA_RESOLUTION = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
};

class UnsupportedTimeframeError extends Error {
  constructor(timeframe) {
    super(`Timeframe "${timeframe}" has no verified Delta Exchange resolution mapping`);
    this.code = 'UNSUPPORTED_TIMEFRAME';
    this.status = 400;
  }
}

function mapTimeframe(novaTimeframe) {
  const resolution = NOVA_TO_DELTA_RESOLUTION[novaTimeframe];
  if (!resolution) {
    throw new UnsupportedTimeframeError(novaTimeframe);
  }
  return resolution;
}

module.exports = { NOVA_TO_DELTA_RESOLUTION, mapTimeframe, UnsupportedTimeframeError };
