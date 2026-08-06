'use strict';

const mongoose = require('mongoose');

/**
 * A single OHLCV candle bucket for a symbol/timeframe pair, built from real
 * Delta market-data ticks (see services/marketData/CandlePersistenceService.js).
 *
 * One document per (symbol, timeframe, timestamp) — the compound unique
 * index below is what prevents duplicate candles and makes every write here
 * an idempotent upsert of the *same* forming candle until it closes.
 */
const candleSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, index: true },
    timeframe: { type: String, required: true, index: true }, // e.g. '1m','5m','15m' — never hardcoded by callers
    timestamp: { type: Number, required: true }, // epoch ms, start of the candle bucket

    open: { type: Number, required: true },
    high: { type: Number, required: true },
    low: { type: Number, required: true },
    close: { type: Number, required: true },
    volume: { type: Number, default: null }, // price-tick-derived candles carry no volume yet

    closed: { type: Boolean, required: true, default: false, index: true },
    source: { type: String, required: true, default: 'delta' }, // provenance — only real-provider values are ever written
  },
  { timestamps: true }
);

// Canonical duplicate guard: exactly one candle per symbol+timeframe+bucket.
candleSchema.index({ symbol: 1, timeframe: 1, timestamp: 1 }, { unique: true });

module.exports = mongoose.model('Candle', candleSchema);
