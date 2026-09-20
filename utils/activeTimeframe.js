'use strict';

/**
 * NOVA TRADE — ACTIVE ANALYSIS TIMEFRAME (one-time opposite-market switch)
 * =======================================================================
 *
 * Pure, dependency-free helpers shared by every consumer of a BotInstance's
 * timeframe, so "which timeframe is this bot actually analysing right now?"
 * has exactly ONE answer everywhere:
 *
 *   BotManager._instanceAcceptsTimeframe   (live candle routing)
 *   BotManager._hydrateInstance            (restart hydration)
 *   CandlePersistenceService               (which timeframes to build/persist)
 *   MODEL_002                              (detection + its own view of state)
 *   Bot Detail UI                          (what the user sees)
 *
 * CONFIGURED vs ACTIVE
 * --------------------
 *   parameters.timeframe            — the USER's configuration. Never
 *                                     rewritten by this feature.
 *   parameters.activeTimeframe      — runtime analysis timeframe, only ever
 *                                     written once, only ever '1m'.
 *   parameters.timeframeSwitched    — one-time latch (true => never again).
 *   parameters.timeframeSwitchedAt  — ms timestamp of the switch; doubles as
 *                                     the analysis baseline so the candle
 *                                     that was already forming at that
 *                                     instant is never analysed.
 *
 * All four live inside the ALREADY-EXISTING `parameters` Mixed object on
 * BotInstance (same place levelsUpdatedAt already lives) — no schema change,
 * no new collection, no duplicate state, and it survives restart through the
 * existing MongoDB persistence/recovery path automatically.
 *
 * The switch is strictly one-way: nothing in this module (or anywhere else)
 * can move a bot back to its configured timeframe.
 */

/** The only timeframe an opposite-market touch can switch a bot TO. */
const OPPOSITE_TOUCH_TIMEFRAME = '1m';

/**
 * The opposite-market rule, verbatim and exhaustive:
 *   BULLISH + Resistance touched  -> opposite
 *   BEARISH + Support touched     -> opposite
 * Everything else (BULLISH+Support, BEARISH+Resistance, unknown trend/side)
 * is NOT opposite.
 * @param {string} trend 'BULLISH' | 'BEARISH'
 * @param {string} touchedSide 'SUPPORT' | 'RESISTANCE'
 */
function isOppositeMarketTouch(trend, touchedSide) {
  if (trend === 'BULLISH' && touchedSide === 'RESISTANCE') return true;
  if (trend === 'BEARISH' && touchedSide === 'SUPPORT') return true;
  return false;
}

/** The user's original, never-overwritten configured timeframe. */
function getConfiguredTimeframe(parameters) {
  return (parameters && parameters.timeframe) || undefined;
}

/** True once this instance has performed its one-and-only switch. */
function hasSwitched(parameters) {
  return Boolean(parameters && parameters.timeframeSwitched === true);
}

/**
 * The timeframe this instance is ACTUALLY analysing. Falls back to the
 * configured timeframe whenever no switch has happened — so every existing
 * caller behaves byte-identically for a bot that never switched.
 * Accepts either a BotInstance-like `{ parameters }` object or a bare
 * parameters object.
 */
function getActiveTimeframe(instanceOrParameters) {
  if (!instanceOrParameters) return undefined;
  const parameters = instanceOrParameters.parameters || instanceOrParameters;
  if (hasSwitched(parameters) && typeof parameters.activeTimeframe === 'string' && parameters.activeTimeframe) {
    return parameters.activeTimeframe;
  }
  return getConfiguredTimeframe(parameters);
}

/**
 * Whether an opposite-market touch should actually cause a switch for this
 * instance. False when it already switched (one-time rule, §5) and false
 * when the bot is already configured on 1m (§6 — no pointless state change).
 */
function shouldSwitch(parameters) {
  if (hasSwitched(parameters)) return false;
  if (getConfiguredTimeframe(parameters) === OPPOSITE_TOUCH_TIMEFRAME) return false;
  return true;
}

/**
 * Returns a NEW parameters object with the one-time switch applied, or null
 * if no switch is warranted. Never mutates its input, never touches
 * `timeframe`, never has an inverse — there is deliberately no
 * "restore configured timeframe" function anywhere in this module (§17).
 */
function applySwitch(parameters, atMs) {
  if (!shouldSwitch(parameters)) return null;
  const at = Number.isFinite(atMs) ? atMs : Date.now();
  return Object.assign({}, parameters, {
    activeTimeframe: OPPOSITE_TOUCH_TIMEFRAME,
    timeframeSwitched: true,
    timeframeSwitchedAt: at,
  });
}

/**
 * The baseline timestamp a candle must reach to be analysable by this
 * instance. Extends the EXISTING createdAt / levelsUpdatedAt baseline rule
 * (unchanged for every bot that never switched) with the switch instant:
 *
 *   switch at 14:23:35  ->  the 14:23:00 candle (already forming) is BELOW
 *                           the baseline and is skipped; the 14:24:00 candle
 *                           is the first one analysed, once it closes.
 *
 * This is also what stops old 1m candles being replayed as if they were new
 * after the switch (§7, §K), using the project's existing period-START
 * candle-timestamp semantics.
 * @returns {number|null} null means "no baseline" (unfiltered, legacy behavior)
 */
function computeAnalysisBaselineMs(dbInstance) {
  if (!dbInstance) return null;
  const createdAt = dbInstance.createdAt;
  const createdAtMs = createdAt instanceof Date && !Number.isNaN(createdAt.getTime())
    ? createdAt.getTime()
    : (typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null);

  const parameters = dbInstance.parameters || {};
  const candidates = [];
  if (createdAtMs !== null) candidates.push(createdAtMs);
  if (typeof parameters.levelsUpdatedAt === 'number') candidates.push(parameters.levelsUpdatedAt);
  if (hasSwitched(parameters) && typeof parameters.timeframeSwitchedAt === 'number') {
    candidates.push(parameters.timeframeSwitchedAt);
  }

  if (!candidates.length) return null;
  return Math.max(...candidates);
}

module.exports = {
  OPPOSITE_TOUCH_TIMEFRAME,
  isOppositeMarketTouch,
  getConfiguredTimeframe,
  getActiveTimeframe,
  hasSwitched,
  shouldSwitch,
  applySwitch,
  computeAnalysisBaselineMs,
};
