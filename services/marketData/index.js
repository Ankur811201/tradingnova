'use strict';

const { env } = require('../../config/env');
const { NullProvider } = require('./NullProvider');
const RestPollingProvider = require('./RestPollingProvider');
const DeltaMarketDataProvider = require('./DeltaMarketDataProvider');
const logger = require('../../utils/logger');

let providerInstance = null;

function buildProvider() {
  switch (env.MARKET_DATA_PROVIDER) {
    case 'delta':
      return new DeltaMarketDataProvider({
        baseUrl: env.DELTA_BASE_URL,
        wsUrl: env.DELTA_WS_URL,
        staleThresholdMs: env.MARKET_DATA_STALE_THRESHOLD_MS,
        pollIntervalMs: env.MARKET_DATA_POLL_INTERVAL_MS,
        useWebSocket: env.MARKET_DATA_DELTA_USE_WEBSOCKET,
      });
    case 'generic_rest':
      return new RestPollingProvider({
        mode: 'generic_rest',
        baseUrl: env.MARKET_DATA_REST_BASE_URL,
        apiKey: env.MARKET_DATA_REST_API_KEY,
        staleThresholdMs: env.MARKET_DATA_STALE_THRESHOLD_MS,
        pollIntervalMs: env.MARKET_DATA_POLL_INTERVAL_MS,
      });
    case 'tradingview_udf':
      return new RestPollingProvider({
        mode: 'tradingview_udf',
        baseUrl: env.MARKET_DATA_REST_BASE_URL,
        apiKey: env.MARKET_DATA_REST_API_KEY,
        staleThresholdMs: env.MARKET_DATA_STALE_THRESHOLD_MS,
        pollIntervalMs: env.MARKET_DATA_POLL_INTERVAL_MS,
      });
    case 'none':
    default:
      return new NullProvider();
  }
}

/** Singleton accessor. */
function getMarketDataProvider() {
  if (!providerInstance) {
    providerInstance = buildProvider();
    logger.info('MARKET_DATA', `Initialized market data provider: ${env.MARKET_DATA_PROVIDER}`);
  }
  return providerInstance;
}

/** Checks freshness for a symbol using the globally configured stale threshold. */
function isSymbolFresh(symbol) {
  return getMarketDataProvider().isDataFresh(symbol);
}

/**
 * TEST-ONLY hook: allows the test suite to inject a mock MarketDataProvider
 * (e.g. one seeded with deterministic prices) instead of hitting a real
 * network endpoint. Must never be called from application code.
 */
function _setProviderForTesting(provider) {
  providerInstance = provider;
}

module.exports = { getMarketDataProvider, isSymbolFresh, _setProviderForTesting };
