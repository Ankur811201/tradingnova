'use strict';

const Candle = require('../../models/Candle');
const BotInstance = require('../../models/BotInstance');
const BotModelMetadata = require('../../models/BotModelMetadata');
const { TIMEFRAMES_MS } = require('../../bot-models/model-001/config');
const logger = require('../../utils/logger');
const { getMarketDataProvider } = require('./index');
// ONE-TIME OPPOSITE-MARKET TIMEFRAME SWITCH: shared definition of a running
// instance's ACTIVE analysis timeframe (identical to parameters.timeframe
// for any instance that never switched).
const { getActiveTimeframe } = require('../../utils/activeTimeframe');

const ACTIVE_TIMEFRAME_CACHE_MS = 5000;
const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * CandlePersistenceService — turns real Delta price ticks (as already
 * dispatched by server.js from the existing DeltaMarketDataProvider) into
 * durable, deduplicated OHLCV candles in MongoDB, AND broadcasts the same
 * canonical candle state over Socket.IO to whichever bot-detail room(s)
 * actually care about it.
 *
 * This is intentionally independent of Model001/CandleAggregator: it does
 * not change any strategy logic, it only persists/broadcasts what real
 * market data is already flowing through the tick pipeline, for whichever
 * (symbol, timeframe) pair an active BotInstance actually uses.
 *
 * Single source of truth: MongoDB and Socket.IO both receive the exact same
 * in-memory candle state per tick — Socket.IO is never given a value that
 * wasn't (or isn't about to be) the value written to Mongo.
 *
 * Guarantees:
 *  - Never fabricates a candle — every OHLCV value comes directly from a
 *    real Delta-sourced price tick handed to processTick().
 *  - Exactly one document per (symbol, timeframe, timestamp) — enforced by
 *    the unique index on Candle AND by always upserting on that same key.
 *  - The forming (still-open) candle is updated in place; it only becomes
 *    `closed: true` once a tick belonging to the next bucket arrives.
 *  - Closed candles are never rewritten or reopened, even across a process
 *    restart or duplicate/out-of-order ticks (reconnect-safe).
 *  - One `BotInstance.find()` per symbol per cache window (5s) is reused for
 *    BOTH deciding which timeframe(s) to persist AND which bot:<instanceId>
 *    room(s) to notify — no extra query added for Socket.IO routing.
 */
class CandlePersistenceService {
  constructor() {
    // `${symbol}:${timeframe}` -> { timestamp, open, high, low, close }
    this.formingCandles = new Map();
    // symbol -> { timeframes: string[], instancesByTimeframe: Map<tf, instanceId[]>, expiresAt }
    this.activeBotsCache = new Map();
    this.io = null;
  }

  /** Wires the Socket.IO server so persisted candle changes can be broadcast. */
  attachSocketServer(io) {
    this.io = io;
  }

  /**
   * Drops the cached active-timeframe/routing snapshot for one symbol so the
   * very next tick re-reads it from MongoDB. Called by BotManager the moment
   * an instance's active analysis timeframe changes (one-time opposite-market
   * switch) — without it, that bot would simply start receiving 1m candles up
   * to one cache window (5s) later. Adds no query of its own.
   */
  invalidateSymbol(symbol) {
    this.activeBotsCache.delete(symbol);
  }

  /**
   * Entry point — call once per real Delta price tick. No-op for a symbol
   * if no BotInstance is currently RUNNING on it (nothing to persist for,
   * nothing to broadcast to). Returns the canonical candle event(s) that
   * were persisted this call (0, 1, or 2 — 2 on rollover: the closed
   * previous candle + the new forming candle), mainly useful for tests.
   */
  async processTick(symbol, price, timestamp) {
    if (!Number.isFinite(price) || price <= 0) return [];
    const ts = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();

    const { timeframes, instancesByTimeframe } = await this._getActiveBotsForSymbol(symbol);
    const allEvents = [];

    for (const timeframe of timeframes) {
      try {
        const events = await this._processTickForTimeframe(symbol, timeframe, price, ts);
        if (events.length) {
          allEvents.push(...events);
          this._broadcast(symbol, timeframe, events, instancesByTimeframe.get(timeframe) || []);
        }
      } catch (err) {
        await logger.error('CANDLE', `Failed to persist candle for ${symbol} ${timeframe}: ${err.message}`);
      }
    }

    return allEvents;
  }

  /**
   * Which timeframe(s)/instanceId(s) to serve for this symbol — driven
   * entirely by what running BotInstances actually use. Cached briefly so
   * this single query covers both MongoDB persistence AND Socket.IO
   * routing for every tick in the cache window.
   */
  async _getActiveBotsForSymbol(symbol) {
    const now = Date.now();
    const cached = this.activeBotsCache.get(symbol);
    if (cached && cached.expiresAt > now) return cached;

    const running = await BotInstance.find({ symbol, status: 'RUNNING' })
      .select('instanceId modelId parameters')
      .lean();

    // PART A (multi-timeframe infra): a running instance's model may
    // declare ADDITIONAL timeframes it needs (BotModelMetadata.requiredTimeframes)
    // beyond its own parameters.timeframe. One query per distinct modelId
    // among this symbol's running instances — still cached on the same 5s
    // window as everything else here, so this doesn't add a per-tick cost.
    const modelIds = Array.from(new Set(running.map((b) => b.modelId).filter(Boolean)));
    const modelDocs = modelIds.length
      ? await BotModelMetadata.find({ modelId: { $in: modelIds } }).select('modelId requiredTimeframes').lean()
      : [];
    const requiredTimeframesByModel = new Map(modelDocs.map((m) => [m.modelId, m.requiredTimeframes || []]));

    const instancesByTimeframe = new Map();
    const addInstanceForTimeframe = (tf, instanceId) => {
      if (!tf || !Object.prototype.hasOwnProperty.call(TIMEFRAMES_MS, tf)) return;
      if (!instancesByTimeframe.has(tf)) instancesByTimeframe.set(tf, []);
      instancesByTimeframe.get(tf).push(instanceId);
    };

    for (const bot of running) {
      // PART 13.1 -- PHASE D: no fallback default. `status: 'RUNNING'` above
      // is only reachable after onStart succeeded, which now requires an
      // explicit, valid timeframe (see bot-models/model-001/validators.js).
      // A bot without one simply cannot appear in `running` with a usable
      // timeframe, so it's correctly skipped rather than being silently
      // persisted/routed as if it were on 5m.
      // ACTIVE timeframe, not configured: a bot that performed the one-time
      // opposite-market switch now needs the existing 1m candle stream built
      // and routed for it. Only that one instance is affected — every other
      // running bot keeps contributing its own configured timeframe exactly
      // as before, and no bot is ever globally moved to 1m.
      const tf = getActiveTimeframe(bot);
      addInstanceForTimeframe(tf, bot.instanceId);

      // PART A: additionally persist/route every timeframe this bot's
      // model declared, for this SAME instance/room. A model that declares
      // none (e.g. MODEL_001) adds nothing here — identical to pre-Part-A
      // behavior.
      const required = requiredTimeframesByModel.get(bot.modelId) || [];
      for (const entry of required) {
        addInstanceForTimeframe(entry.timeframe, bot.instanceId);
      }
    }

    const result = {
      timeframes: Array.from(instancesByTimeframe.keys()),
      instancesByTimeframe,
      expiresAt: now + ACTIVE_TIMEFRAME_CACHE_MS,
    };
    this.activeBotsCache.set(symbol, result);
    return result;
  }

  async _processTickForTimeframe(symbol, timeframe, price, timestamp) {
    const tfMs = TIMEFRAMES_MS[timeframe];
    if (!tfMs) return []; // unsupported timeframe — already filtered upstream, stay safe anyway

    const bucketStart = Math.floor(timestamp / tfMs) * tfMs;
    const key = `${symbol}:${timeframe}`;
    let current = this.formingCandles.get(key);

    // Rehydrate from Mongo on first tick since (re)start / cache miss, so a
    // reconnect never blindly re-creates or reopens a candle that already exists.
    if (!current) {
      const existing = await Candle.findOne({ symbol, timeframe, timestamp: bucketStart }).lean();
      if (existing) {
        if (existing.closed) return []; // already closed — never reopen a finished candle
        current = {
          timestamp: existing.timestamp, open: existing.open, high: existing.high, low: existing.low, close: existing.close,
        };
      }
    }

    // Late/duplicate tick belonging to an older, already-tracked bucket — ignore.
    if (current && bucketStart < current.timestamp) return [];

    const events = [];

    if (!current || bucketStart > current.timestamp) {
      // New bucket started — close out whatever was previously open first.
      if (current) {
        events.push(await this._closeCandle(symbol, timeframe, current));
      } else {
        // No in-memory candle at all (fresh process/reconnect): make sure no
        // stale forming candle is left behind from before the restart.
        events.push(...(await this._closeStaleForming(symbol, timeframe, bucketStart)));
      }

      current = { timestamp: bucketStart, open: price, high: price, low: price, close: price };
      this.formingCandles.set(key, current);

      await Candle.updateOne(
        { symbol, timeframe, timestamp: bucketStart },
        {
          $setOnInsert: { symbol, timeframe, timestamp: bucketStart, open: price, source: 'delta' },
          $set: { high: price, low: price, close: price, closed: false },
        },
        { upsert: true }
      );
      console.log(`[CANDLE] ${symbol} ${timeframe} saved/updated`);
      events.push(this._toCanonicalEvent(symbol, timeframe, current, false));
      return events;
    }

    // Same bucket — update the forming candle in place (no new document).
    current.high = Math.max(current.high, price);
    current.low = Math.min(current.low, price);
    current.close = price;
    this.formingCandles.set(key, current);

    await Candle.updateOne(
      { symbol, timeframe, timestamp: bucketStart, closed: false },
      { $max: { high: price }, $min: { low: price }, $set: { close: price } },
      { upsert: false }
    );
    console.log(`[CANDLE] ${symbol} ${timeframe} saved/updated`);
    events.push(this._toCanonicalEvent(symbol, timeframe, current, false));
    return events;
  }

  /** Builds the canonical (Mongo-shaped, millisecond-timestamp) candle event. Never carries fabricated volume. */
  _toCanonicalEvent(symbol, timeframe, state, closed) {
    return {
      symbol,
      timeframe,
      candle: {
        timestamp: state.timestamp,
        open: state.open,
        high: state.high,
        low: state.low,
        close: state.close,
        volume: null,
        closed,
        source: 'delta',
      },
    };
  }

  async _closeCandle(symbol, timeframe, state) {
    // The live candle is built from ticker snapshots for low-latency updates.
    // Before publishing the CLOSED event, reconcile that completed candle
    // against Delta's official OHLC candle so the final wick used by the
    // chart and strategy matches the exchange-generated 1m/other-TF bar.
    let finalState = state;
    try {
      const provider = getMarketDataProvider();
      if (provider && typeof provider.getClosedCandle === 'function') {
        const official = await provider.getClosedCandle(symbol, timeframe, state.timestamp);
        if (official) {
          finalState = {
            timestamp: official.timestamp,
            open: official.open,
            high: official.high,
            low: official.low,
            close: official.close,
          };
          await Candle.updateOne(
            { symbol, timeframe, timestamp: state.timestamp },
            {
              $set: {
                open: official.open,
                high: official.high,
                low: official.low,
                close: official.close,
                volume: official.volume != null ? official.volume : null,
                closed: true,
              },
            }
          );
          await logger.info(
            'CANDLE',
            `[CANDLE] ${symbol} ${timeframe} reconciled with Delta OHLC timestamp=${official.timestamp}`
          );
        } else {
          await logger.warn(
            'CANDLE',
            `[CANDLE] ${symbol} ${timeframe} Delta OHLC candle not found for timestamp=${state.timestamp}; using locally built candle`
          );
        }
      }
    } catch (err) {
      // Reconciliation must never block candle closure or strategy dispatch.
      // The locally built candle remains the safe fallback when Delta's
      // historical endpoint is temporarily unavailable at the boundary.
      await logger.warn(
        'CANDLE',
        `[CANDLE] ${symbol} ${timeframe} Delta OHLC reconciliation failed: ${err.message}; using locally built candle`
      );
    }

    // Keep the in-memory state identical to the canonical persisted/broadcast
    // state so the next lifecycle step cannot revert the reconciled OHLC.
    state.open = finalState.open;
    state.high = finalState.high;
    state.low = finalState.low;
    state.close = finalState.close;

    if (finalState === state) {
      await Candle.updateOne(
        { symbol, timeframe, timestamp: state.timestamp },
        { $set: { closed: true } }
      );
    }

    await logger.info('CANDLE', `[CANDLE] ${symbol} ${timeframe} closed`);
    return this._toCanonicalEvent(symbol, timeframe, state, true);
  }

  /** Closes any leftover open candle strictly before newBucketStart (reconnect/restart safety net). */
  async _closeStaleForming(symbol, timeframe, newBucketStart) {
    const stale = await Candle.find({
      symbol, timeframe, closed: false, timestamp: { $lt: newBucketStart },
    }).select('timestamp open high low close').lean();

    const events = [];
    for (const doc of stale) {
      events.push(await this._closeCandle(symbol, timeframe, doc));
    }
    return events;
  }

  /**
   * Broadcasts canonical candle event(s) to every RUNNING bot instance's
   * own `bot:<instanceId>` room for this exact (symbol, timeframe) — never
   * to unrelated symbols/timeframes/rooms. Converts ms -> seconds here, at
   * the Socket boundary, since MongoDB stores ms but Lightweight Charts
   * expects Unix seconds.
   */
  _broadcast(symbol, timeframe, events, instanceIds) {
    if (!this.io || !instanceIds.length) return;

    for (const evt of events) {
      const candlePayload = {
        time: Math.floor(evt.candle.timestamp / 1000),
        open: evt.candle.open,
        high: evt.candle.high,
        low: evt.candle.low,
        close: evt.candle.close,
        volume: evt.candle.volume,
        closed: evt.candle.closed,
      };

      for (const instanceId of instanceIds) {
        this.io.to(`bot:${instanceId}`).emit('bot:candle', {
          instanceId,
          symbol,
          timeframe,
          candle: candlePayload,
        });

        if (IS_DEV) {
          console.log(
            `[SOCKET] bot:candle instance=${instanceId} ${symbol} ${timeframe} time=${candlePayload.time} closed=${candlePayload.closed}`
          );
        }
      }
    }
  }
}

module.exports = new CandlePersistenceService();
