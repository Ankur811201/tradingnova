'use strict';

const MarketDataProvider = require('../../services/marketData/MarketDataProvider');

/**
 * Deterministic, in-memory provider used ONLY by the test suite so that
 * RiskEngine/PaperEngine integration tests are reproducible without a real
 * market data connection. Never used by application code.
 */
class MockProvider extends MarketDataProvider {
  constructor() {
    super();
    this.prices = new Map(); // symbol -> { price, timestamp }
  }

  setPrice(symbol, price, timestamp = Date.now()) {
    this.prices.set(symbol, { price, timestamp });
  }

  setStale(symbol, ageMs) {
    const entry = this.prices.get(symbol);
    if (entry) entry.timestamp = Date.now() - ageMs;
  }

  async getPrice(symbol) {
    const entry = this.prices.get(symbol);
    if (!entry) throw new Error(`MockProvider has no price for ${symbol}`);
    return { symbol, price: entry.price, timestamp: entry.timestamp };
  }

  async getCandles() {
    return [];
  }

  subscribePrice() {
    return () => {};
  }

  subscribeCandles() {
    return () => {};
  }

  getConnectionStatus() {
    return { configured: true, connected: true, providerName: 'mock', lastError: null };
  }

  isDataFresh(symbol, staleThresholdMs = 15000) {
    const entry = this.prices.get(symbol);
    if (!entry) return false;
    return Date.now() - entry.timestamp <= staleThresholdMs;
  }
}

module.exports = MockProvider;
