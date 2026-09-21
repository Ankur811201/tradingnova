'use strict';

const { TIMEFRAMES_MS } = require('../../utils/timeframes');
const fs = require('fs');
const path = require('path');

/**
 * Test-only market-data provider.
 *
 * It never connects to an exchange. A caller explicitly pushes an OHLC candle
 * and this provider turns it into the same price-tick callbacks used by the
 * real provider. The normal server pipeline then builds the canonical candle
 * and sends it to MODEL_002 + Target Exit.
 */
class FakeCandleMarketDataProvider {
  constructor() {
    this.subscribers = new Map();
    this.lastPrice = new Map();
    this.lastTimestamp = new Map();
    this.syntheticClock = new Map();
    this.history = new Map();
    this.sequenceIndex = new Map();
    this.sequence = this._loadSequence();
  }


  _loadSequence() {
    const file = path.join(__dirname, '../../data/fake-candles.json');
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      throw new Error(`Cannot load fake candle JSON: ${err.message}`);
    }
  }

  async nextFromJson({ symbol, timeframe }) {
    const candles = this.sequence?.[symbol]?.[timeframe];
    if (!Array.isArray(candles) || candles.length === 0) {
      throw new Error(`No fake candle JSON data for ${symbol} ${timeframe}.`);
    }
    const key = `${symbol}:${timeframe}`;
    const index = this.sequenceIndex.get(key) || 0;
    if (index >= candles.length) {
      throw new Error(`Fake candle sequence finished for ${symbol} ${timeframe}.`);
    }
    const candle = candles[index];
    this.sequenceIndex.set(key, index + 1);
    return this.pushCandle({ symbol, timeframe, ...candle });
  }

  sequenceState(symbol, timeframe) {
    const candles = this.sequence?.[symbol]?.[timeframe] || [];
    const index = this.sequenceIndex.get(`${symbol}:${timeframe}`) || 0;
    return { symbol, timeframe, index, total: candles.length, finished: index >= candles.length };
  }

  subscribePrice(symbol, callback) {
    if (!this.subscribers.has(symbol)) this.subscribers.set(symbol, new Set());
    this.subscribers.get(symbol).add(callback);
    return () => this.subscribers.get(symbol)?.delete(callback);
  }

  getConnectionStatus() {
    return {
      connected: true,
      configured: true,
      fresh: true,
      providerName: 'fake-candle-test',
      mode: 'FAKE_CANDLE',
    };
  }

  isDataFresh(symbol) {
    const ts = this.lastTimestamp.get(symbol);
    return Number.isFinite(ts) && (Date.now() - ts) <= 24 * 60 * 60 * 1000;
  }

  async getCandles(symbol, timeframe, options = {}) {
    const key = `${symbol}:${timeframe}`;
    const limit = Math.min(Math.max(Number(options.limit) || 300, 1), 500);
    return (this.history.get(key) || []).slice(-limit);
  }

  subscribeCandles() {
    // Fake candles intentionally use the normal price-tick pipeline; direct
    // candle subscriptions are not needed by Nova Trade's canonical path.
    return () => {};
  }

  async getPrice(symbol) {
    const price = this.lastPrice.get(symbol);
    if (!Number.isFinite(price)) {
      throw new Error(`No fake price available for ${symbol}. Push a fake candle first.`);
    }
    return { symbol, price, timestamp: this.lastTimestamp.get(symbol) };
  }

  nextTimestamp(symbol, timeframe, requested = null) {
    const tfMs = TIMEFRAMES_MS[timeframe];
    if (!tfMs) throw new Error(`Unsupported fake candle timeframe: ${timeframe}`);

    if (requested != null) {
      const n = Number(requested);
      if (!Number.isFinite(n) || n <= 0) throw new Error('timestamp must be a positive epoch-millisecond value.');
      const bucket = Math.floor(n / tfMs) * tfMs;
      this.syntheticClock.set(`${symbol}:${timeframe}`, bucket);
      return bucket;
    }

    const key = `${symbol}:${timeframe}`;
    const current = this.syntheticClock.get(key);
    if (Number.isFinite(current)) {
      const next = current + tfMs;
      this.syntheticClock.set(key, next);
      return next;
    }

    // Keep test candles away from normal current-time candles so a fake test
    // cannot accidentally overwrite a live candle bucket.
    const start = Math.floor((Date.now() + 2 * 24 * 60 * 60 * 1000) / tfMs) * tfMs;
    this.syntheticClock.set(key, start);
    return start;
  }

  async pushCandle({ symbol, timeframe, open, high, low, close, timestamp }) {
    const values = [open, high, low, close].map(Number);
    if (values.some((v) => !Number.isFinite(v) || v <= 0)) {
      throw new Error('open, high, low and close must all be positive finite numbers.');
    }
    if (!(Number(high) >= Math.max(Number(open), Number(close)))) {
      throw new Error('high must be >= open and close.');
    }
    if (!(Number(low) <= Math.min(Number(open), Number(close)))) {
      throw new Error('low must be <= open and close.');
    }

    const start = this.nextTimestamp(symbol, timeframe, timestamp);
    const tfMs = TIMEFRAMES_MS[timeframe];
    const subscriberSet = this.subscribers.get(symbol);
    if (!subscriberSet || subscriberSet.size === 0) {
      throw new Error(`No fake market-data subscriber is active for ${symbol}. Start a RUNNING bot first.`);
    }

    // Multiple ticks in one bucket exercise the exact real tick path. The
    // first tick of the next fake candle closes this candle in the canonical
    // CandlePersistenceService, exactly as real market data does.
    const ticks = [
      { price: Number(open), timestamp: start + 1 },
      { price: Number(high), timestamp: start + Math.max(2, Math.floor(tfMs * 0.25)) },
      { price: Number(low), timestamp: start + Math.max(3, Math.floor(tfMs * 0.50)) },
      { price: Number(close), timestamp: start + Math.max(4, Math.floor(tfMs * 0.90)) },
    ];

    const historyKey = `${symbol}:${timeframe}`;
    const history = this.history.get(historyKey) || [];
    history.push({ time: Math.floor(start / 1000), timestamp: start, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: null });
    this.history.set(historyKey, history.slice(-500));

    for (const tick of ticks) {
      this.lastPrice.set(symbol, tick.price);
      this.lastTimestamp.set(symbol, Date.now());
      for (const callback of subscriberSet) {
        await callback(tick);
      }
    }

    return {
      symbol,
      timeframe,
      timestamp: start,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      closed: false,
      note: 'This candle becomes canonical/closed when the next fake candle is pushed.',
    };
  }

  reset() {
    this.lastPrice.clear();
    this.lastTimestamp.clear();
    this.syntheticClock.clear();
    this.history.clear();
    this.sequenceIndex.clear();
  }
}

module.exports = FakeCandleMarketDataProvider;
