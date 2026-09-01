'use strict';

const axios = require('axios');
const MarketDataProvider = require('./MarketDataProvider');
const FreshnessCache = require('./FreshnessCache');
const DeltaWebSocketClient = require('./deltaWebSocketClient');
const { novaToDeltaSymbol, UnsupportedSymbolError } = require('./symbolMap');
const { mapTimeframe } = require('./timeframeMap');
const { validateCandle } = require('../../utils/candleValidation');
const { TIMEFRAMES_MS } = require('../../bot-models/model-001/config');
const logger = require('../../utils/logger');

/**
 * DeltaMarketDataProvider — dedicated Delta Exchange market data source.
 *
 * Endpoints/format VERIFIED against official Delta documentation
 * (docs.delta.exchange) during this build:
 *   GET {base}/v2/products/{symbol}                          (public, no auth)
 *   GET {base}/v2/tickers/{symbol}                             (public, no auth)
 *   GET {base}/v2/history/candles?symbol=&resolution=&start=&end=  (public, no auth)
 *
 * None of these require DELTA_API_KEY/DELTA_API_SECRET — Delta's public
 * market-data endpoints are unauthenticated, so this provider deliberately
 * never sends API credentials. Credentials remain scoped to DeltaAdapter
 * (private account/order/position endpoints) only.
 *
 * WebSocket (optional, opt-in): see deltaWebSocketClient.js for exactly
 * which parts are verified vs. intentionally not implemented.
 *
 * Never fabricates data: every response is validated before being cached or
 * returned; malformed/missing data marks the provider unhealthy and throws
 * rather than substituting a guessed value.
 */
class DeltaMarketDataProvider extends MarketDataProvider {
  constructor(options) {
    super();
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.staleThresholdMs = options.staleThresholdMs;
    this.pollIntervalMs = options.pollIntervalMs;
    this.useWebSocket = Boolean(options.useWebSocket);
    this.wsUrl = options.wsUrl;

    this.cache = new FreshnessCache(this.staleThresholdMs);
    this.pollTimers = new Map();
    this.watchedSymbols = new Set();
    this.connected = false;
    this.lastError = null;
    this.productCache = new Map(); // novaSymbol -> delta product (validated)

    this.http = axios.create({ baseURL: this.baseUrl, timeout: 8000 });

    this.ws = null;
    if (this.useWebSocket) {
      if (!this.wsUrl) {
        logger.warn('MARKET_DATA', 'MARKET_DATA_DELTA_USE_WEBSOCKET=true but DELTA_WS_URL is not set; falling back to REST polling only.');
        this.useWebSocket = false;
      } else {
        this.ws = new DeltaWebSocketClient({
          wsUrl: this.wsUrl,
          onTicker: (tick) => this._handleTick(tick.symbol, tick.price, tick.timestamp),
          onStatusChange: (status) => {
            this.connected = status.connected;
            if (!status.connected) this.lastError = this.lastError || 'WebSocket disconnected';
          },
        });
        this.ws.connect();
      }
    }
  }

  getConnectionStatus() {
    return {
      configured: true,
      connected: this.connected,
      providerName: this.useWebSocket ? 'delta_ws' : 'delta_rest',
      lastError: this.lastError,
      lastUpdateAt: this.cache.lastUpdateAt,
      activeSymbols: this.cache.getActiveSymbols(),
    };
  }

  isDataFresh(symbol) {
    return this.cache.isFresh(symbol);
  }

  /** Validates a Nova symbol against Delta's product list, caching the result. Throws UnsupportedSymbolError. */
 async _ensureValidProduct(novaSymbol) {
  if (this.productCache.has(novaSymbol)) {
    return this.productCache.get(novaSymbol);
  }

  const deltaSymbol = novaToDeltaSymbol(novaSymbol);

  let resp;

  try {
  resp = await this.http.get('/v2/products/' + deltaSymbol);
} catch (err) {
  const status = err.response?.status;

  throw new UnsupportedSymbolError(
    novaSymbol,
    status === 404 ? 'no such Delta product' : err.message
  );
}

  const product = resp.data && resp.data.result;

  if (!product || !product.symbol) {
    throw new UnsupportedSymbolError(
      novaSymbol,
      'Delta product lookup returned no result'
    );
  }

  this.productCache.set(novaSymbol, product);

  return product;
}

  async getPrice(symbol) {
    await this._ensurePolling(symbol);
    const entry = this.cache.getPrice(symbol);
    if (!entry) await this._pollTickerOnce(symbol);
    const fresh = this.cache.getPrice(symbol);
    if (!fresh) {
      const err = new Error('No price data available yet for ' + symbol);
      err.code = 'MARKET_DATA_UNAVAILABLE';
      err.status = 503;
      throw err;
    }
    return { symbol: symbol, price: fresh.price, timestamp: fresh.timestamp, provider: this.useWebSocket ? 'delta_ws' : 'delta_rest' };
  }

  /**
   * Fetches one completed candle from Delta's official OHLC endpoint.
   * This is used only when a locally reconstructed candle closes, so the
   * final OHLC/wick can be reconciled with Delta's exchange-generated candle.
   * The live ticker/polling path remains unchanged.
   */
  async getClosedCandle(symbol, timeframe, targetTimestamp) {
    const tfMs = TIMEFRAMES_MS[timeframe];
    if (!tfMs) throw new Error(`Unsupported timeframe: ${timeframe}`);

    const target = Number(targetTimestamp);
    if (!Number.isFinite(target) || target <= 0) {
      throw new Error('getClosedCandle requires a valid targetTimestamp');
    }

    const candles = await this.getCandles(symbol, timeframe, {
      lookbackSeconds: Math.max(180, Math.ceil((tfMs * 3) / 1000)),
      limit: 5,
    });

    return candles.find((c) => c.timestamp === target) || null;
  }

  async getCandles(symbol, timeframe, options) {
    options = options || {};
    const resolution = mapTimeframe(timeframe); // pure check first - throws UnsupportedTimeframeError, no network call wasted
    await this._ensureValidProduct(symbol);
    const deltaSymbol = novaToDeltaSymbol(symbol);

    const end = Math.floor(Date.now() / 1000);
    const lookbackSeconds = options.lookbackSeconds || this._defaultLookbackSeconds(timeframe, options.limit);
    const start = end - lookbackSeconds;

    let resp;
    try {
      resp = await this.http.get('/v2/history/candles', { params: { symbol: deltaSymbol, resolution: resolution, start: start, end: end } });
    } catch (err) {
      this.connected = false;
      this.lastError = err.message;
      logger.error('MARKET_DATA', 'Delta getCandles failed for ' + symbol + ': ' + err.message);
      throw err;
    }

    if (!resp.data || resp.data.success !== true || !Array.isArray(resp.data.result)) {
      this.connected = false;
      this.lastError = 'Malformed candles response from Delta';
      throw new Error('Delta /v2/history/candles response was malformed (missing success/result)');
    }

    const candles = resp.data.result
      .map((raw) => this._normalizeCandle(raw))
      .filter((c) => c !== null)
      .sort((a, b) => a.timestamp - b.timestamp);

    this.connected = true;
    this.lastError = null;
    return candles;
  }

  subscribePrice(symbol, callback) {
    this._ensurePolling(symbol).catch((err) => {
      logger.error('MARKET_DATA', 'Failed to start Delta polling for ' + symbol + ': ' + err.message);
    });
    return this.cache.subscribe(symbol, callback);
  }

  subscribeCandles(symbol, timeframe, callback) {
    mapTimeframe(timeframe); // validate early, throw if unsupported
    const handle = setInterval(async () => {
      try {
        const candles = await this.getCandles(symbol, timeframe);
        callback({ symbol: symbol, timeframe: timeframe, candles: candles });
      } catch (_err) {
        // already logged in getCandles
      }
    }, this.pollIntervalMs);
    if (handle.unref) handle.unref();
    return () => clearInterval(handle);
  }

  // --- internal ---

  async _ensurePolling(symbol) {
    if (this.watchedSymbols.has(symbol)) return;
    await this._ensureValidProduct(symbol); // throws clearly for an unsupported symbol
    this.watchedSymbols.add(symbol);

    if (this.useWebSocket && this.ws) {
      this.ws.subscribeSymbol(novaToDeltaSymbol(symbol));
      return;
    }

    await this._pollTickerOnce(symbol);
    const handle = setInterval(() => this._pollTickerOnce(symbol), this.pollIntervalMs);
    if (handle.unref) handle.unref();
    this.pollTimers.set(symbol, handle);
  }

  async _pollTickerOnce(symbol) {
    const deltaSymbol = novaToDeltaSymbol(symbol);
    try {
      const resp = await this.http.get('/v2/tickers/' + deltaSymbol);
      const price = this._extractPrice(resp.data);
      const timestamp = this._extractTimestamp(resp.data);
      if (price === null) {
        throw new Error('Ticker response contained no usable price field (close/mark_price/spot_price)');
      }
      this._handleTick(symbol, price, timestamp);
    } catch (err) {
      this.connected = false;
      this.lastError = err.message;
      logger.warn('MARKET_DATA', 'Delta ticker poll failed for ' + symbol + ': ' + err.message);
    }
  }

  _handleTick(deltaSymbolOrNovaSymbol, price, timestamp) {
    if (!Number.isFinite(price) || price <= 0) return;
    // WS ticks arrive keyed by Delta symbol; REST polling already uses the Nova symbol as the map key.
    // With an identity mapping (default) these are the same string; this stays correct if overrides are added later.
    const novaSymbol = this._resolveNovaSymbolFromDeltaTick(deltaSymbolOrNovaSymbol);
    this.cache.setPrice(novaSymbol, price, timestamp || Date.now());
    this.connected = true;
    this.lastError = null;
  }

  _resolveNovaSymbolFromDeltaTick(symbolFromMessage) {
    for (const nova of this.watchedSymbols) {
      if (novaToDeltaSymbol(nova) === symbolFromMessage) return nova;
    }
    return symbolFromMessage;
  }

  _extractPrice(body) {
    const r = body && body.result;
    if (!r) return null;
    const candidates = [r.close, r.mark_price, r.spot_price, r.last_price];
    for (const c of candidates) {
      const n = typeof c === 'string' ? parseFloat(c) : c;
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  _extractTimestamp(body) {
    const r = body && body.result;
    const ts = r && r.timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return Date.now();
    if (ts > 1e15) return Math.floor(ts / 1000); // microseconds -> ms
    if (ts > 1e12) return ts; // already ms
    return ts * 1000; // seconds -> ms
  }

  _normalizeCandle(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const timestamp = typeof raw.time === 'number' ? raw.time * 1000 : NaN;
    const candle = {
      timestamp: timestamp,
      open: Number(raw.open),
      high: Number(raw.high),
      low: Number(raw.low),
      close: Number(raw.close),
      volume: raw.volume != null ? Number(raw.volume) : null,
    };
    if (!validateCandle(candle)) {
      logger.warn('MARKET_DATA', 'Rejected malformed candle from Delta /v2/history/candles', { raw: raw });
      return null;
    }
    return candle;
  }

  _defaultLookbackSeconds(timeframe, limit) {
    // PART 12.2 — PHASE 1: no silent fallback. An invalid/unrecognized
    // timeframe must throw, never quietly compute a 5m-shaped lookback
    // window for a different (or corrupted) timeframe.
    const tfMs = TIMEFRAMES_MS[timeframe];
    if (!tfMs) {
      throw new Error(`DeltaMarketDataProvider._defaultLookbackSeconds: unsupported timeframe "${timeframe}"`);
    }
    const unit = tfMs / 1000;
    const count = limit || 200;
    return unit * count;
  }

  /** Cleanly stops all polling timers and closes any WebSocket connection. */
  stopAll() {
    for (const handle of this.pollTimers.values()) clearInterval(handle);
    this.pollTimers.clear();
    this.watchedSymbols.clear();
    if (this.ws) this.ws.close();
  }
}

module.exports = DeltaMarketDataProvider;
