'use strict';

const axios = require('axios');
const MarketDataProvider = require('./MarketDataProvider');
const FreshnessCache = require('./FreshnessCache');
const logger = require('../../utils/logger');

/**
 * RestPollingProvider connects to a legitimate, authorized REST market-data
 * endpoint that the operator has configured via env vars
 * (MARKET_DATA_REST_BASE_URL, MARKET_DATA_REST_API_KEY).
 *
 * It supports two response "shapes" out of the box:
 *   - "generic_rest": expects GET {base}/price?symbol=SYM -> { price: number, timestamp?: number }
 *                      and GET {base}/candles?symbol=SYM&resolution=R -> { candles: [...] }
 *   - "tradingview_udf": expects a UDF-compatible endpoint
 *                      GET {base}/quotes?symbols=SYM -> { s: 'ok', d: [{ v: { lp: number } }] }
 *                      GET {base}/history?symbol=SYM&resolution=R&from=&to= -> { t:[], o:[], h:[], l:[], c:[], v:[] }
 *      (UDF = Universal Data Feed, a documented, widely-used third-party protocol —
 *       this talks to a server-side UDF endpoint you are authorized to use, it does
 *       NOT scrape the TradingView website/embedded widget.)
 *
 * IMPORTANT: This class performs no scraping and invents no undocumented
 * endpoints. If your actual data vendor's response shape differs, adjust
 * `parsePriceResponse` / `parseCandlesResponse` below — that is the single
 * integration point to change.
 */
class RestPollingProvider extends MarketDataProvider {
  constructor({ mode, baseUrl, apiKey, staleThresholdMs, pollIntervalMs }) {
    super();
    this.mode = mode; // 'generic_rest' | 'tradingview_udf'
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.staleThresholdMs = staleThresholdMs;
    this.pollIntervalMs = pollIntervalMs;

    this.cache = new FreshnessCache(staleThresholdMs);
    this.pollTimers = new Map(); // symbol -> interval handle
    this.watchedSymbols = new Set();
    this.connected = false;
    this.lastError = null;

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 8000,
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
    });
  }

  getConnectionStatus() {
    return {
      configured: true,
      connected: this.connected,
      providerName: this.mode,
      lastError: this.lastError,
      lastUpdateAt: this.cache.lastUpdateAt,
      activeSymbols: this.cache.getActiveSymbols(),
    };
  }

  isDataFresh(symbol) {
    return this.cache.isFresh(symbol);
  }

  async getPrice(symbol) {
    await this._ensurePolling(symbol);
    const entry = this.cache.getPrice(symbol);
    if (!entry) {
      // Attempt one synchronous fetch before giving up.
      await this._pollOnce(symbol);
    }
    const fresh = this.cache.getPrice(symbol);
    if (!fresh) {
      const err = new Error(`No price data available yet for ${symbol}`);
      err.code = 'MARKET_DATA_UNAVAILABLE';
      err.status = 503;
      throw err;
    }
    return { symbol, price: fresh.price, timestamp: fresh.timestamp };
  }

  async getCandles(symbol, timeframe, options = {}) {
    try {
      let candles;
      if (this.mode === 'tradingview_udf') {
        const to = Math.floor(Date.now() / 1000);
        const from = to - (options.lookbackSeconds || 3600 * 24);
        const resp = await this.http.get('/history', {
          params: { symbol, resolution: timeframe, from, to },
        });
        candles = this._parseUdfHistory(resp.data);
      } else {
        const resp = await this.http.get('/candles', {
          params: { symbol, resolution: timeframe, limit: options.limit || 200 },
        });
        candles = (resp.data && resp.data.candles) || [];
      }
      this.connected = true;
      this.lastError = null;
      return candles;
    } catch (err) {
      this.connected = false;
      this.lastError = err.message;
      logger.error('MARKET_DATA', `getCandles failed for ${symbol}`, { error: err.message });
      throw err;
    }
  }

  subscribePrice(symbol, callback) {
    this._ensurePolling(symbol).catch((err) => {
      logger.error('MARKET_DATA', `Failed to start polling for ${symbol}`, { error: err.message });
    });
    return this.cache.subscribe(symbol, callback);
  }

  subscribeCandles(symbol, timeframe, callback) {
    // Poll-based candle subscription: re-fetch on the same interval as price.
    const handle = setInterval(async () => {
      try {
        const candles = await this.getCandles(symbol, timeframe);
        callback({ symbol, timeframe, candles });
      } catch (err) {
        // swallow; getCandles already logs
      }
    }, this.pollIntervalMs);
    return () => clearInterval(handle);
  }

  async _ensurePolling(symbol) {
    if (this.watchedSymbols.has(symbol)) return;
    this.watchedSymbols.add(symbol);
    await this._pollOnce(symbol);
    const handle = setInterval(() => this._pollOnce(symbol), this.pollIntervalMs);
    this.pollTimers.set(symbol, handle);
  }

  async _pollOnce(symbol) {
    try {
      let price = null;
      if (this.mode === 'tradingview_udf') {
        const resp = await this.http.get('/quotes', { params: { symbols: symbol } });
        price = this._parseUdfQuote(resp.data, symbol);
      } else {
        const resp = await this.http.get('/price', { params: { symbol } });
        price = this._parseGenericPrice(resp.data);
      }
      if (typeof price === 'number' && Number.isFinite(price)) {
        this.cache.setPrice(symbol, price, Date.now());
        this.connected = true;
        this.lastError = null;
      } else {
        throw new Error('Provider returned no numeric price');
      }
    } catch (err) {
      this.connected = false;
      this.lastError = err.message;
      logger.warn('MARKET_DATA', `Poll failed for ${symbol}: ${err.message}`);
    }
  }

  _parseGenericPrice(data) {
    if (!data) return null;
    if (typeof data.price === 'number') return data.price;
    if (typeof data.price === 'string') return parseFloat(data.price);
    return null;
  }

  _parseUdfQuote(data, symbol) {
    if (!data || data.s !== 'ok' || !Array.isArray(data.d)) return null;
    const entry = data.d.find((d) => d.n === symbol) || data.d[0];
    if (!entry || !entry.v) return null;
    const lp = entry.v.lp;
    return typeof lp === 'number' ? lp : parseFloat(lp);
  }

  _parseUdfHistory(data) {
    if (!data || data.s !== 'ok' || !Array.isArray(data.t)) return [];
    const out = [];
    for (let i = 0; i < data.t.length; i += 1) {
      out.push({
        time: data.t[i] * 1000,
        open: data.o[i],
        high: data.h[i],
        low: data.l[i],
        close: data.c[i],
        volume: data.v ? data.v[i] : 0,
      });
    }
    return out;
  }

  stopAll() {
    for (const handle of this.pollTimers.values()) clearInterval(handle);
    this.pollTimers.clear();
    this.watchedSymbols.clear();
  }
}

module.exports = RestPollingProvider;
