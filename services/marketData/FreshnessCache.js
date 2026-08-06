'use strict';

/**
 * Tracks last-known price/candle data per symbol along with the wall-clock
 * timestamp it was received, and exposes freshness checks against a
 * configurable staleness threshold. Used by every concrete MarketDataProvider
 * implementation so freshness semantics are consistent across providers.
 */
class FreshnessCache {
  constructor(staleThresholdMs) {
    this.staleThresholdMs = staleThresholdMs;
    this.lastPrice = new Map(); // symbol -> { price, timestamp }
    this.subscribers = new Map(); // symbol -> Set<callback>
    this.lastUpdateAt = null; // wall-clock time of the most recent accepted update, any symbol
  }

  setPrice(symbol, price, timestamp = Date.now()) {
    this.lastPrice.set(symbol, { price, timestamp });
    this.lastUpdateAt = Date.now();
    const subs = this.subscribers.get(symbol);
    if (subs) {
      for (const cb of subs) {
        try {
          cb({ symbol, price, timestamp });
        } catch (err) {
          console.error(`[marketData] subscriber callback error for ${symbol}:`, err.message);
        }
      }
    }
  }

  getPrice(symbol) {
    return this.lastPrice.get(symbol) || null;
  }

  isFresh(symbol) {
    const entry = this.lastPrice.get(symbol);
    if (!entry) return false;
    return Date.now() - entry.timestamp <= this.staleThresholdMs;
  }

  /** Symbols currently tracked (have received at least one update). */
  getActiveSymbols() {
    return Array.from(this.lastPrice.keys());
  }

  subscribe(symbol, callback) {
    if (!this.subscribers.has(symbol)) this.subscribers.set(symbol, new Set());
    this.subscribers.get(symbol).add(callback);
    return () => {
      const set = this.subscribers.get(symbol);
      if (set) set.delete(callback);
    };
  }
}

module.exports = FreshnessCache;
