'use strict';

const Candle = require('../../models/Candle');
const { computeUsableHistory } = require('./historyContinuity');

// How many candidate closed candles to pull from Mongo before computing
// contiguity. Wider than targetCount so a recent gap (e.g. 5 missing
// buckets) doesn't get mistaken for "not enough total data was queried" —
// while still bounded so this never turns into an unbounded historical
// scan (PART 12.1 PHASE 5: fetch enough, not everything).
const CANDIDATE_MULTIPLIER = 4;
const CANDIDATE_FLOOR = 200;

/**
 * PART 12.1 — loads candidate closed candles for (symbol, timeframe) from
 * canonical Mongo and reduces them to the "usable recent history" window
 * via historyContinuity. This is the single query+compute path used by
 * both CandleBackfillService (to decide whether backfill is needed) and
 * BotManager (to decide what to actually hand to onHydrate) — so they can
 * never disagree about what "N candles available" means.
 */
async function getUsableRecentHistory({ symbol, timeframe, tfMs, targetCount, now }) {
  const candidateLimit = Math.max(targetCount * CANDIDATE_MULTIPLIER, CANDIDATE_FLOOR);

  const docs = await Candle.find({ symbol, timeframe, closed: true })
    .sort({ timestamp: -1 })
    .limit(candidateLimit)
    .select('timestamp open high low close volume')
    .lean();

  return computeUsableHistory({ candles: docs, tfMs, targetCount, now });
}

module.exports = { getUsableRecentHistory, CANDIDATE_MULTIPLIER, CANDIDATE_FLOOR };
