'use strict';

/**
 * Aggregates incoming price ticks (as dispatched by BotManager from the
 * approved MarketDataProvider) into fixed-size OHLCV candle buckets.
 *
 * Pure and deterministic given (price, timestamp) inputs — no I/O, no
 * randomness, no wall-clock reads. addTick() returns the just-closed candle
 * the moment a tick belongs to a new bucket, or null while a candle is still
 * forming.
 *
 * NOTE: because the current MarketDataProvider price stream carries price
 * only (no volume), aggregated candles always have `volume: null`. Volume
 * confirmation rules stay configurable for when a future provider revision
 * supplies volume-bearing data.
 */
class CandleAggregator {
  constructor(timeframeMs) {
    if (!Number.isFinite(timeframeMs) || timeframeMs <= 0) {
      throw new Error('CandleAggregator requires a positive timeframeMs');
    }
    this.timeframeMs = timeframeMs;
    this.current = null;
  }

  _bucketStart(timestamp) {
    return Math.floor(timestamp / this.timeframeMs) * this.timeframeMs;
  }

  /**
   * @param {number} price
   * @param {number} timestamp epoch ms
   * @returns {object|null} the closed candle if this tick started a new bucket, else null
   */
  addTick(price, timestamp) {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp) || timestamp <= 0) {
      return null;
    }

    const bucket = this._bucketStart(timestamp);

    if (!this.current) {
      this.current = { timestamp: bucket, open: price, high: price, low: price, close: price, volume: null };
      return null;
    }

    if (bucket === this.current.timestamp) {
      this.current.high = Math.max(this.current.high, price);
      this.current.low = Math.min(this.current.low, price);
      this.current.close = price;
      return null;
    }

    if (bucket < this.current.timestamp) {
      // Out-of-order tick (e.g. late/duplicate delivery) — ignore, never rewrite a closed bucket.
      return null;
    }

    const closed = this.current;
    this.current = { timestamp: bucket, open: price, high: price, low: price, close: price, volume: null };
    return closed;
  }
}

module.exports = CandleAggregator;
