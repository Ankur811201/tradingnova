'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * Central environment configuration.
 * All access to process.env should go through this module so that
 * validation happens in one place and defaults are consistent.
 */

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function toList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: toInt(process.env.PORT, 4000),
  APP_BASE_URL: process.env.APP_BASE_URL || 'http://localhost:4000',

  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/nova_trade',

  SESSION_SECRET: process.env.SESSION_SECRET || '',
  SESSION_COOKIE_MAX_AGE_MS: toInt(process.env.SESSION_COOKIE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000),
  LOGIN_RATE_LIMIT_WINDOW_MS: toInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS: toInt(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS, 10),
  ALLOW_REGISTRATION: toBool(process.env.ALLOW_REGISTRATION, true),

  MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER || 'none',
  MARKET_DATA_REST_BASE_URL: process.env.MARKET_DATA_REST_BASE_URL || '',
  MARKET_DATA_REST_API_KEY: process.env.MARKET_DATA_REST_API_KEY || '',
  MARKET_DATA_STALE_THRESHOLD_MS: toInt(process.env.MARKET_DATA_STALE_THRESHOLD_MS, 15000),
  MARKET_DATA_POLL_INTERVAL_MS: toInt(process.env.MARKET_DATA_POLL_INTERVAL_MS, 3000),
  // Delta market data provider (MARKET_DATA_PROVIDER=delta) reuses DELTA_BASE_URL/DELTA_WS_URL
  // below — it is the same exchange/region, so there is no separate "Delta market data URL".
  // WebSocket is opt-in and REST-polling is the safe default (see services/marketData/DeltaMarketDataProvider.js).
  MARKET_DATA_DELTA_USE_WEBSOCKET: toBool(process.env.MARKET_DATA_DELTA_USE_WEBSOCKET, false),

  PAPER_INITIAL_BALANCE_USD: toFloat(process.env.PAPER_INITIAL_BALANCE_USD, 50000),
  PAPER_TAKER_FEE_RATE: toFloat(process.env.PAPER_TAKER_FEE_RATE, 0.0005),
  PAPER_MAKER_FEE_RATE: toFloat(process.env.PAPER_MAKER_FEE_RATE, 0.0002),
  PAPER_MAX_LEVERAGE: toFloat(process.env.PAPER_MAX_LEVERAGE, 20),

  RISK_MAX_LEVERAGE: toFloat(process.env.RISK_MAX_LEVERAGE, 20),
  RISK_MAX_POSITION_SIZE_USD: toFloat(process.env.RISK_MAX_POSITION_SIZE_USD, 100000),
  RISK_MAX_CAPITAL_ALLOCATION_PER_BOT_USD: toFloat(process.env.RISK_MAX_CAPITAL_ALLOCATION_PER_BOT_USD, 50000),
  RISK_MAX_DAILY_LOSS_USD: toFloat(process.env.RISK_MAX_DAILY_LOSS_USD, 5000),
  RISK_ALLOWED_SYMBOLS: toList(process.env.RISK_ALLOWED_SYMBOLS || 'BTCUSD,ETHUSD'),
  RISK_DUPLICATE_SIGNAL_WINDOW_MS: toInt(process.env.RISK_DUPLICATE_SIGNAL_WINDOW_MS, 5000),

  DELTA_API_KEY: process.env.DELTA_API_KEY || '',
  DELTA_API_SECRET: process.env.DELTA_API_SECRET || '',
  // NOTE: intentionally WITHOUT a trailing /v2 — both DeltaMarketDataProvider
  // and DeltaAdapter already prepend '/v2/...' to every request path (see
  // their own apiPrefix/hardcoded paths). Setting DELTA_BASE_URL to
  // '.../v2' here would double it to '.../v2/v2/...' and 404 on every call.
  DELTA_BASE_URL: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
  DELTA_WS_URL: process.env.DELTA_WS_URL || 'wss://socket.india.delta.exchange',
  DELTA_REQUEST_TIMEOUT_MS: toInt(process.env.DELTA_REQUEST_TIMEOUT_MS, 10000),

  LIVE_TRADING_DEFAULT_ENABLED: toBool(process.env.LIVE_TRADING_DEFAULT_ENABLED, false),

  // Comma-separated allowed origins for CORS + Socket.IO. Empty = reflect request origin
  // (safe for same-origin/dev use since credentials are cookie-based, not "*"). Set explicitly
  // in production, e.g. CORS_ALLOWED_ORIGIN=https://app.example.com
  CORS_ALLOWED_ORIGIN: process.env.CORS_ALLOWED_ORIGIN || '',

  ENABLE_LIVE_INTEGRATION_TESTS: toBool(process.env.ENABLE_LIVE_INTEGRATION_TESTS, false),
};

env.IS_PRODUCTION = env.NODE_ENV === 'production';
env.DELTA_CONFIGURED = Boolean(env.DELTA_API_KEY && env.DELTA_API_SECRET);

function validateEnv() {
  const errors = [];

  if (env.IS_PRODUCTION && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16)) {
    errors.push('SESSION_SECRET must be set to a strong random value (>=16 chars) in production.');
  }
  if (!env.SESSION_SECRET) {
    // Non-production: allow but warn, generate a process-local fallback so sessions still work.
    env.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
    console.warn('[env] SESSION_SECRET not set. Generated an ephemeral secret for this process only. ' +
      'Sessions will not survive a restart. Set SESSION_SECRET in .env for persistent sessions.');
  }
  if (!env.MONGODB_URI) {
    errors.push('MONGODB_URI is required.');
  }
  if (!['none', 'tradingview_udf', 'generic_rest', 'delta'].includes(env.MARKET_DATA_PROVIDER)) {
    errors.push(`MARKET_DATA_PROVIDER must be one of none|tradingview_udf|generic_rest|delta (got "${env.MARKET_DATA_PROVIDER}")`);
  }
  if (env.MARKET_DATA_PROVIDER === 'generic_rest' && !env.MARKET_DATA_REST_BASE_URL) {
    errors.push('MARKET_DATA_REST_BASE_URL is required when MARKET_DATA_PROVIDER=generic_rest');
  }
  if (env.MARKET_DATA_PROVIDER === 'tradingview_udf' && !env.MARKET_DATA_REST_BASE_URL) {
    errors.push('MARKET_DATA_REST_BASE_URL is required when MARKET_DATA_PROVIDER=tradingview_udf');
  }
  if (env.MARKET_DATA_PROVIDER === 'delta' && !env.DELTA_BASE_URL) {
    errors.push('DELTA_BASE_URL is required when MARKET_DATA_PROVIDER=delta');
  }

  if (errors.length) {
    console.error('\n[env] Environment validation failed:');
    errors.forEach((e) => console.error(`  - ${e}`));
    console.error('\nFix the .env file (see .env.example) and restart.\n');
    process.exit(1);
  }

  if (!env.DELTA_CONFIGURED) {
    console.warn('[env] DELTA_API_KEY / DELTA_API_SECRET not set. ' +
      'Server will start in PAPER-ONLY mode. Live Trading Engine will reject all live actions.');
  }
  if (env.MARKET_DATA_PROVIDER === 'none') {
    console.warn('[env] MARKET_DATA_PROVIDER=none. No market data source is configured. ' +
      'MarketDataProvider will return explicit "not configured" errors. No fake prices will be generated.');
  }
  if (env.MARKET_DATA_PROVIDER === 'delta') {
    console.log('[env] MARKET_DATA_PROVIDER=delta. Using DELTA_BASE_URL/DELTA_WS_URL. ' +
      'Delta\'s public market-data endpoints require no API key/secret; DELTA_API_KEY/SECRET ' +
      `remain used only for private trading via DeltaAdapter (currently ${env.DELTA_CONFIGURED ? 'configured' : 'NOT configured — live trading unavailable'}).`);
  }
}

module.exports = { env, validateEnv };
