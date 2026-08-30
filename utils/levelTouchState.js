'use strict';

/**
 * NOVA TRADE — PERSISTENT SUPPORT/RESISTANCE LEVEL-TOUCH STATE
 * ===========================================================
 *
 * Pure, dependency-free helpers (same shape and same storage strategy as
 * utils/activeTimeframe.js) so "has this bot ever touched Support /
 * Resistance?" has exactly ONE answer everywhere:
 *
 *   MODEL_002            — records the touch and reports it on every DECISION
 *   BotManager           — persists it into the instance's own `parameters`
 *   Bot Detail UI        — displays it (Support: TOUCHED / NOT_TOUCHED)
 *
 * WHY THIS EXISTS
 * ---------------
 * The Decision Engine panel used to derive the Support/Resistance rows
 * from `activeLevel` of the LATEST decision only. `activeLevel` is null on
 * any decision that has no active pattern (e.g. reason `no_level_touch`),
 * so the panel flipped back to NOT_TOUCHED the moment a pattern failed —
 * even though the level really had been touched. LEVEL STATE ("was this
 * level ever touched?") and PATTERN STATE ("where is the A/B/C machine
 * right now?") are two different concepts and are kept separate here.
 *
 * STORAGE
 * -------
 * Four keys per side, inside the ALREADY-EXISTING `parameters` Mixed
 * object on BotInstance (exactly where `levelsUpdatedAt`,
 * `timeframeSwitched` etc. already live) — no schema change, no new
 * collection, and per-instance by construction, so one bot's TOUCHED state
 * can never be visible to another:
 *
 *   parameters.supportTouched          boolean latch
 *   parameters.supportTouchedAt        ms timestamp of the touching candle
 *   parameters.supportTouchedLevel     the level price that was touched
 *   parameters.supportTouchedIndex     that level's index (S1/S2/S3)
 *   parameters.resistanceTouched*      the RESISTANCE mirror of the above
 *
 * LIFECYCLE
 * ---------
 * The latch is never cleared by a candle, a failed pattern, an
 * invalidation, a rejected trade or a losing trade. The ONLY thing that
 * clears it is the project's existing configuration lifecycle: changing
 * trend/support/resistance on the instance (the same edit that already
 * sets `levelsUpdatedAt` and re-baselines hydration in BotManager) — at
 * that point the remembered touch refers to a level that no longer exists.
 */

const SIDES = ['SUPPORT', 'RESISTANCE'];

/** parameters key prefix for a side: 'SUPPORT' -> 'support'. */
function prefixFor(side) {
  if (side === 'SUPPORT') return 'support';
  if (side === 'RESISTANCE') return 'resistance';
  return null;
}

/**
 * Reads the persisted latch. Accepts either a BotInstance-like
 * `{ parameters }` object or a bare parameters object. Always returns a
 * fully-populated, safe object — an instance that never touched anything
 * (or predates this feature) reads back as `touched: false`, never
 * undefined.
 */
function readLevelTouchState(instanceOrParameters) {
  const source = instanceOrParameters
    ? (instanceOrParameters.parameters || instanceOrParameters)
    : {};
  const read = (prefix) => ({
    touched: source[`${prefix}Touched`] === true,
    at: typeof source[`${prefix}TouchedAt`] === 'number' ? source[`${prefix}TouchedAt`] : null,
    level: typeof source[`${prefix}TouchedLevel`] === 'number' ? source[`${prefix}TouchedLevel`] : null,
    index: typeof source[`${prefix}TouchedIndex`] === 'number' ? source[`${prefix}TouchedIndex`] : null,
  });
  return { support: read('support'), resistance: read('resistance') };
}

/**
 * Returns a NEW parameters object with a touch recorded, or null when
 * nothing changed (already latched on the same level+index) so callers can
 * skip a pointless write. Never mutates its input and never clears the
 * other side.
 *
 * @param {object} parameters existing instance parameters
 * @param {{side: string, price?: number, index?: number, at?: number}} touch
 */
function applyLevelTouch(parameters, touch) {
  if (!touch || !SIDES.includes(touch.side)) return null;
  const prefix = prefixFor(touch.side);
  const current = parameters || {};

  const price = Number.isFinite(touch.price) ? touch.price : null;
  const index = Number.isFinite(touch.index) ? touch.index : null;
  const at = Number.isFinite(touch.at) ? touch.at : Date.now();

  const alreadyLatched = current[`${prefix}Touched`] === true;
  const samePrice = (current[`${prefix}TouchedLevel`] ?? null) === price;
  const sameIndex = (current[`${prefix}TouchedIndex`] ?? null) === index;
  if (alreadyLatched && samePrice && sameIndex) return null;

  const next = Object.assign({}, current);
  next[`${prefix}Touched`] = true;
  next[`${prefix}TouchedAt`] = at;
  next[`${prefix}TouchedLevel`] = price;
  next[`${prefix}TouchedIndex`] = index;
  return next;
}

/**
 * Returns a NEW parameters object with BOTH latches cleared, or null when
 * there was nothing to clear. Used ONLY from the existing
 * trend/support/resistance edit path in BotManager (the same place that
 * sets `levelsUpdatedAt`) — never from a candle, a decision, or a trade
 * outcome.
 */
function clearLevelTouchState(parameters) {
  const current = parameters || {};
  const keys = [];
  ['support', 'resistance'].forEach((prefix) => {
    ['Touched', 'TouchedAt', 'TouchedLevel', 'TouchedIndex'].forEach((suffix) => {
      if (current[`${prefix}${suffix}`] !== undefined) keys.push(`${prefix}${suffix}`);
    });
  });
  if (!keys.length) return null;

  const next = Object.assign({}, current);
  keys.forEach((key) => { delete next[key]; });
  return next;
}

/**
 * The exact shape the Decision Engine UI consumes (see
 * public/js/renderers/model-thinking-registry.js MODEL_002 renderer). Built
 * from a state object read by readLevelTouchState() — TOUCHED is a latch,
 * completely independent of whatever the current pattern/activeLevel is.
 */
function toChecksLevelStatus(state) {
  const safe = state && state.support && state.resistance
    ? state
    : readLevelTouchState(null);
  return {
    support: {
      status: safe.support.touched ? 'TOUCHED' : 'NOT_TOUCHED',
      level: safe.support.level,
      index: safe.support.index,
      at: safe.support.at,
    },
    resistance: {
      status: safe.resistance.touched ? 'TOUCHED' : 'NOT_TOUCHED',
      level: safe.resistance.level,
      index: safe.resistance.index,
      at: safe.resistance.at,
    },
  };
}

module.exports = {
  SIDES,
  readLevelTouchState,
  applyLevelTouch,
  clearLevelTouchState,
  toChecksLevelStatus,
};
