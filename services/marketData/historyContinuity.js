'use strict';

/**
 * PART 12.1 — historyContinuity.
 *
 * Pure, dependency-free computation of "usable recent history" from a set
 * of candle documents. This is the single place that answers the question
 * CandleBackfillService and BotManager both previously answered wrong (or
 * not at all): does Mongo actually hold N *usable* recent candles, or just
 * N documents somewhere in its history?
 *
 * "Usable" means, in order:
 *   1. Timestamp-aligned to the timeframe bucket (PHASE 9).
 *   2. De-duplicated by timestamp — last-write-wins is fine since the
 *      canonical Candle unique index already guarantees at most one
 *      document per (symbol, timeframe, timestamp); this is a defensive
 *      second layer, not the primary guard (PHASE 8).
 *   3. Part of the single contiguous run ending at the newest candle —
 *      walking backwards from the latest candle, every step must be
 *      exactly one timeframe duration earlier. The run stops at the first
 *      gap (PHASE 2/3).
 *   4. Not stale — the newest candle in that run must represent (approx.)
 *      the most recently closed bucket for "now", not some run of candles
 *      from hours/days ago that happens to be internally contiguous
 *      (PHASE 17).
 *
 * This module never queries Mongo and never calls a provider — it is pure
 * so it can be unit-tested directly with synthetic candle arrays.
 */

/**
 * @param {object} params
 * @param {object[]} params.candles - candle-shaped docs (timestamp, open, high, low, close, ...), any order
 * @param {number} params.tfMs - canonical timeframe duration in ms (from TIMEFRAMES_MS)
 * @param {number} params.targetCount - how many usable candles are required
 * @param {number} [params.now] - injectable for tests; defaults to Date.now()
 * @returns {{
 *   usable: number,
 *   usableCandles: object[],   // oldest -> newest, the contiguous non-stale run (or [] if stale)
 *   sufficient: boolean,
 *   latestContiguousCount: number, // contiguous run length regardless of staleness (diagnostic)
 *   totalDocs: number,         // count after alignment+dedup, before contiguity/staleness (diagnostic)
 *   stale: boolean,
 *   gapCount: number,          // how many distinct gaps exist between totalDocs and the latest run
 * }}
 */
function computeUsableHistory({ candles, tfMs, targetCount, now }) {
  const nowTs = Number.isFinite(now) ? now : Date.now();

  if (!Array.isArray(candles) || !tfMs || tfMs <= 0) {
    return { usable: 0, usableCandles: [], sufficient: false, latestContiguousCount: 0, totalDocs: 0, stale: false, gapCount: 0 };
  }

  // PHASE 9 — reject misaligned timestamps outright; they can never
  // silently count toward readiness.
  const aligned = candles.filter(
    (c) => c && Number.isFinite(c.timestamp) && c.timestamp > 0 && c.timestamp % tfMs === 0
  );

  // PHASE 8 — defensive de-dup by timestamp even though the Mongo unique
  // index already prevents this at the persistence layer.
  const byTimestamp = new Map();
  for (const c of aligned) byTimestamp.set(c.timestamp, c);
  const sorted = Array.from(byTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp); // oldest -> newest

  if (!sorted.length) {
    return { usable: 0, usableCandles: [], sufficient: false, latestContiguousCount: 0, totalDocs: 0, stale: false, gapCount: 0 };
  }

  // PHASE 2 — latest contiguous run, walking backwards from the newest candle.
  const run = [sorted[sorted.length - 1]];
  let gapCount = 0;
  for (let i = sorted.length - 2; i >= 0; i -= 1) {
    const expectedPrev = run[0].timestamp - tfMs;
    if (sorted[i].timestamp === expectedPrev) {
      run.unshift(sorted[i]);
    } else {
      gapCount += 1;
      break; // PHASE 2/3: older candles across the gap never count toward the recent run
    }
  }
  // Count any further gaps still present among the older, excluded candles —
  // diagnostic only (doesn't affect usable/sufficient), mirrors the old
  // gap-logging behavior.
  for (let i = sorted.length - 1 - run.length; i > 0; i -= 1) {
    if (sorted[i].timestamp - sorted[i - 1].timestamp !== tfMs) gapCount += 1;
  }

  // PHASE 17 — recency: the run is only "current" if its newest candle's
  // close time is within one timeframe bucket of now. Otherwise this is
  // old history that happens to be internally contiguous, not current
  // market context.
  const latest = run[run.length - 1];
  const staleness = nowTs - (latest.timestamp + tfMs);
  const stale = staleness > tfMs;

  const usableCandles = stale ? [] : run;
  const usable = usableCandles.length;

  return {
    usable,
    usableCandles,
    sufficient: usable >= targetCount,
    latestContiguousCount: run.length,
    totalDocs: sorted.length,
    stale,
    gapCount,
  };
}

module.exports = { computeUsableHistory };
