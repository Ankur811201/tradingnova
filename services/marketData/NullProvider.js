'use strict';

const MarketDataProvider = require('./MarketDataProvider');

class NotConfiguredError extends Error {
  constructor() {
    super('Market data provider is not configured. Set MARKET_DATA_PROVIDER and related env vars.');
    this.code = 'MARKET_DATA_NOT_CONFIGURED';
    this.status = 503;
  }
}

/**
 * NullProvider is used when no market data source is configured.
 * It NEVER returns synthetic data — every method surfaces an explicit,
 * typed "not configured" error so callers (PaperEngine, RiskEngine, etc.)
 * can safely block automated trading.
 */
class NullProvider extends MarketDataProvider {
  async getPrice() {
    throw new NotConfiguredError();
  }

  async getCandles() {
    throw new NotConfiguredError();
  }

  subscribePrice() {
    throw new NotConfiguredError();
  }

  subscribeCandles() {
    throw new NotConfiguredError();
  }

  getConnectionStatus() {
    return {
      configured: false, connected: false, providerName: 'none', lastError: 'not configured',
      lastUpdateAt: null, activeSymbols: [],
    };
  }

  isDataFresh() {
    return false;
  }
}

module.exports = { NullProvider, NotConfiguredError };
