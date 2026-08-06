'use strict';

const Candle = require('../../models/Candle');
const { TIMEFRAMES_MS } = require('../../bot-models/model-001/config');
const { validateCandle } = require('../../utils/candleValidation');
const { getMarketDataProvider } = require('./index');
const { getUsableRecentHistory } = require('./usableHistoryQuery');
const logger = require('../../utils/logger');

// Requesting exactly `targetCount` and nothing more is fragile: the
// provider's current-forming bucket gets filtered out below (Phase F/G),
// and Mongo may already hold some of the recent range (Phase F/I dedup).
// A small fixed overlap keeps a single request sufficient in the common
// case without ever pulling years of history (Phase F: "fetch enough, not
// everything").
const BACKFILL_OVERLAP = 10;

/**
 * PART 12 — CandleBackfillService.
 *
 * Bridges the gap between "MongoDB doesn't have enough closed candles yet"
 * and "MODEL_001 is hydrated and READY", by fetching REAL historical OHLC
 * from the already-configured MarketDataProvider (Delta in production) and
 * persisting it into the SAME canonical Candle collection the live tick
 * pipeline (CandlePersistenceService) writes to.
 *
 * Guarantees:
 *  - Never fabricates/interpolates a candle — every persisted document
 *    comes from a real provider response and passes validateCandle().
 *  - Never persists the still-forming (not yet closed) bucket.
 *  - Never overwrites a document that already exists for a given
 *    (symbol, timeframe, timestamp) — closed OR forming. That bucket is
 *    already owned by either a prior backfill or the live pipeline; the
 *    canonical Candle unique index is the last-resort safety net for that.
 *  - Idempotent: calling this repeatedly for the same target never creates
 *    duplicate documents and does no work once Mongo is already sufficient.
 *  - Concurrent calls for the same (symbol, timeframe) are coalesced into
 *    one in-flight request/persist cycle (Part 11.1-style race safety —
 *    two bots starting on the same market simultaneously must not fire two
 *    backfills).
 *  - Never throws for "no historical data available" (provider not
 *    configured, network error, exchange error) — it degrades to
 *    `{ backfilled: false, error }` so the caller (BotManager) can leave
 *    the instance in an honest INSUFFICIENT_HISTORY state instead of
 *    crashing. It only throws for programmer errors (bad symbol/timeframe).
 */
class CandleBackfillService {
  constructor() {
    this.inFlight = new Map(); // `${symbol}:${timeframe}` -> Promise
  }

  /**
   * Ensures canonical Mongo holds at least `targetCount` recent CLOSED
   * candles for (symbol, timeframe). Returns a summary; never rejects for
   * ordinary "couldn't get history" conditions.
   */
  async ensureSufficientHistory({ symbol, timeframe, targetCount }) {
    if (!symbol || typeof symbol !== 'string') {
      throw new Error('CandleBackfillService.ensureSufficientHistory requires a symbol string');
    }
    const tfMs = TIMEFRAMES_MS[timeframe];
    if (!tfMs) {
      throw new Error(`CandleBackfillService.ensureSufficientHistory: unsupported timeframe "${timeframe}"`);
    }
    const want = Math.max(1, Number(targetCount) || 0);

    // PART 12 — PHASE M: dedupe concurrent backfill for the identical
    // symbol+timeframe pair (e.g. two bot instances both starting on
    // BTCUSD 5m at once). Different pairs never block each other.
    const key = `${symbol}:${timeframe}`;
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    const promise = this._run(symbol, timeframe, tfMs, want).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  async _run(symbol, timeframe, tfMs, targetCount) {
    // PART 12.1 — PHASE 2/4: sufficiency is decided by USABLE RECENT
    // CONTIGUOUS history, never by a raw total document count. 400 total
    // documents across a gap-riddled history is not the same thing as 60
    // usable recent candles.
    const before = await getUsableRecentHistory({ symbol, timeframe, tfMs, targetCount });
    if (before.sufficient) {
      await logger.info(
        'HISTORY',
        `[HISTORY] ${symbol} ${timeframe} usable history ${before.usable}/${targetCount} — no backfill needed`
      );
      return this._summary(targetCount, before.usable, 0, 0, 0, before.usable, false, null);
    }

    await logger.info('HISTORY', `[HISTORY] ${symbol} ${timeframe} usable history ${before.usable}/${targetCount}`);
    if (before.stale) {
      await logger.info('HISTORY', `[HISTORY] ${symbol} ${timeframe} most recent stored history is stale`);
    }
    await logger.info('HISTORY', `[HISTORY] ${symbol} ${timeframe} backfill required`);

    let raw;
    try {
      const provider = getMarketDataProvider();
      raw = await provider.getCandles(symbol, timeframe, { limit: targetCount + BACKFILL_OVERLAP });
    } catch (err) {
      // PART 12 — PHASE N: historical API failure must never fabricate
      // data or crash the server. Report the real reason and let the
      // caller keep whatever real history Mongo already has.
      await logger.warn('HISTORY', `[HISTORY] ${symbol} ${timeframe} historical fetch failed: ${err.message}`);
      return this._summary(targetCount, before.usable, 0, 0, 0, before.usable, false, err.message);
    }

    if (!Array.isArray(raw)) raw = [];

    const now = Date.now();
    // PART 12 — PHASE G/H: only ever-closed buckets, and only well-formed
    // OHLCV. A bucket is closed once its END (timestamp + tfMs) has
    // already passed — the live tick pipeline owns anything still forming.
    const accepted = raw
      .filter((c) => validateCandle(c))
      .filter((c) => c.timestamp + tfMs <= now)
      .sort((a, b) => a.timestamp - b.timestamp);

    await logger.info('HISTORY', `[HISTORY] ${symbol} ${timeframe} received ${raw.length}, accepted ${accepted.length}`);

    const persisted = await this._persist(symbol, timeframe, accepted);

    // PART 12.1 — PHASE 6: never assume a successful HTTP request means
    // history is now sufficient. Re-query canonical Mongo and recompute
    // usable recent contiguous history from what's actually there.
    const after = await getUsableRecentHistory({ symbol, timeframe, tfMs, targetCount });

    await logger.info('HISTORY', `[HISTORY] ${symbol} ${timeframe} persisted ${persisted} new candles`);
    if (after.sufficient) {
      await logger.info('HISTORY', `[HISTORY] ${symbol} ${timeframe} usable history after backfill ${after.usable}/${targetCount}`);
    } else {
      await logger.warn('HISTORY', `[HISTORY] ${symbol} ${timeframe} usable history after backfill ${after.usable}/${targetCount} — still insufficient`);
    }

    return this._summary(targetCount, before.usable, raw.length, accepted.length, persisted, after.usable, true, null);
  }

  /**
   * PART 12 — PHASE I: idempotent bulk upsert. Only inserts candles for
   * timestamps that have NO existing document at all (closed or forming) —
   * this is the collision rule: an existing closed candle is never
   * touched, and an existing forming candle (owned by the live pipeline)
   * is never touched either.
   */
  async _persist(symbol, timeframe, candles) {
    if (!candles.length) return 0;

    const timestamps = candles.map((c) => c.timestamp);
    const existing = await Candle.find({ symbol, timeframe, timestamp: { $in: timestamps } })
      .select('timestamp')
      .lean();
    const existingSet = new Set(existing.map((d) => d.timestamp));

    const toInsert = candles.filter((c) => !existingSet.has(c.timestamp));
    if (!toInsert.length) return 0;

    const ops = toInsert.map((c) => ({
      updateOne: {
        filter: { symbol, timeframe, timestamp: c.timestamp },
        update: {
          $setOnInsert: {
            symbol,
            timeframe,
            timestamp: c.timestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            // PART 12 — real volume note: preserved exactly as the
            // provider gave it (or null if it genuinely gave none) —
            // never fabricated as 0/1/null-by-default.
            volume: c.volume != null ? c.volume : null,
            closed: true,
            source: 'delta',
          },
        },
        upsert: true,
      },
    }));

    try {
      const result = await Candle.bulkWrite(ops, { ordered: false });
      return result.upsertedCount || 0;
    } catch (err) {
      // PART 12 — PHASE M race safety net: between our existence check and
      // this write, a concurrent backfill or a live tick may have created
      // the same bucket. The unique index rejects the duplicate insert —
      // that's expected/benign under this race, not a failure of the
      // whole backfill. Count whatever succeeded and move on.
      const writeErrors = err && Array.isArray(err.writeErrors) ? err.writeErrors : null;
      const isDuplicateKeyIssue = (err && err.code === 11000) || (writeErrors && writeErrors.every((e) => e.code === 11000));
      if (isDuplicateKeyIssue) {
        const upserted = (err.result && typeof err.result.nUpserted === 'number') ? err.result.nUpserted : 0;
        await logger.warn(
          'HISTORY',
          `[HISTORY] ${symbol} ${timeframe} backfill hit ${writeErrors ? writeErrors.length : 1} concurrent duplicate(s) — safely skipped`
        );
        return upserted;
      }
      throw err;
    }
  }

  _summary(requested, mongoBefore, fetched, accepted, persisted, mongoAfter, backfilled, error) {
    return { requested, mongoBefore, fetched, accepted, persisted, mongoAfter, backfilled, error };
  }
}

module.exports = new CandleBackfillService();
