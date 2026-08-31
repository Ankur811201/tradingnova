'use strict';

/**
 * NOVA TRADE — MODEL_002 PATTERN VISUAL GROUP (C1 / C2 / C3 labels)
 * ================================================================
 *
 * Pure, dependency-free builder (same style as utils/activeTimeframe.js and
 * utils/levelTouchState.js). It turns an EXISTING MODEL_002 pattern
 * candidate into the exact label set the chart and the Decision Engine
 * panel should show — and nothing else. It performs NO detection: it never
 * looks at Support/Resistance, never decides a touch, never decides
 * BUY/SELL, never decides invalidation. Every value it emits was already
 * computed by Model002 / reversalPatternEngine / sameSidePatternEngine.
 *
 * THE CONTRACT
 * ------------
 * Each label carries the candle's EXPLICIT role plus its real OHLC and
 * timestamp, so no consumer ever has to infer a role:
 *
 *   { role: 'CANDLE_1', code: 'C1', badge: '①', timestamp, open, high,
 *     low, close, touch: <bool>, trigger: 'BUY'|'SELL'|null }
 *
 * WHICH CANDLE TOUCHED THE LEVEL
 * ------------------------------
 * MODEL_002 runs two different, already-existing pattern engines, and the
 * touch candle is NOT in the same slot in both. The `touch` flag comes from
 * the engine that actually produced the candidate, so the TOUCH badge is
 * never placed on a candle that did not touch a level:
 *
 *   NEW engine (A/B/C — same-side: BULLISH+Support, BEARISH+Resistance)
 *     candle1 = A                 -> CANDLE_1
 *     candle2 = B, the TOUCH      -> CANDLE_2   (touch: true)
 *     trigger candle              -> CANDLE_3
 *
 *   OLD engine (opposite-side: BULLISH+Resistance, BEARISH+Support)
 *     candle1 = the TOUCH candle  -> CANDLE_1   (touch: true)
 *     candle2 = the candle that touched Candle 1's body -> CANDLE_2
 *     candle evaluated against the fixed boundaries      -> CANDLE_3
 *
 * ONE PATTERN = ONE VISUAL GROUP
 * ------------------------------
 * `patternId` identifies a single pattern attempt on a single bot:
 *   M002:<instanceId>:<engine>:<direction>:<candle1.timestamp>
 * It contains the instanceId, so two bots can never share a group, and it
 * changes the moment a new Candle 1 is adopted, so a new pattern's markers
 * replace the previous pattern's rather than mixing with them.
 */

const BADGES = { CANDLE_1: '\u2460', CANDLE_2: '\u2461', CANDLE_3: '\u2462' }; // ① ② ③
const CODES = { CANDLE_1: 'C1', CANDLE_2: 'C2', CANDLE_3: 'C3' };

// Circled digits ③..⑳ for evaluation candles 3..20. Beyond that the code
// (C21, C22, ...) is still exact and only the badge falls back to '#'.
const CIRCLED_DIGITS = [
  '\u2462', '\u2463', '\u2464', '\u2465', '\u2466', '\u2467', '\u2468', '\u2469', // ③④⑤⑥⑦⑧⑨⑩
  '\u246A', '\u246B', '\u246C', '\u246D', '\u246E', '\u246F', '\u2470', '\u2471', // ⑪⑫⑬⑭⑮⑯⑰⑱
  '\u2472', '\u2473',                                                             // ⑲⑳
];

/**
 * P4-H1 — EVALUATION CANDLE IDENTITY.
 *
 * The evaluation candle keeps the CANDLE_3 role (that is the backend's own
 * slot name and nothing renames it), but its user-visible code/badge follow
 * the REAL evaluationIndex the pattern engine already tracks: the first
 * candle after Candle 2 is C3, and if it does not trigger the pattern WAITs
 * and the next candle is C4, then C5, and so on. The label therefore never
 * calls a later candle "C3". `evaluationIndex` is produced by
 * Model002/_advanceNewEngineCandidate and the hydration replay — it is
 * never computed, incremented or guessed here.
 *
 * An absent/invalid index falls back to C3/③, which is correct for every
 * first evaluation candle and for the OLD engine (which does not track an
 * index).
 */
function evaluationCode(evaluationIndex) {
  const n = Number(evaluationIndex);
  if (!Number.isFinite(n) || n < 3) return { code: CODES.CANDLE_3, badge: BADGES.CANDLE_3 };
  return { code: `C${n}`, badge: CIRCLED_DIGITS[n - 3] || '#' };
}

function buildLabel(role, candle, extra) {
  if (!candle || !Number.isFinite(candle.timestamp)) return null;
  return Object.assign({
    role,
    code: CODES[role],
    badge: BADGES[role],
    timestamp: candle.timestamp,
    open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    touch: false,
    trigger: null,
  }, extra || {});
}

/**
 * Builds the visual group for a pattern candidate.
 *
 * Returns null — meaning "the chart must show no C1/C2/C3 labels and no
 * body-reference line" — whenever there is no pattern to show: no candidate
 * at all (IDLE, or the pattern was just invalidated and Model002 already
 * cleared it), or a candidate with no usable Candle 1.
 *
 * @param {object|null} candidate  Model002's own patternCandidate (or the
 *   just-resolved one, for a triggered trade).
 * @param {object} options
 *   @param {string} options.instanceId  per-bot scope for patternId
 *   @param {object} [options.candle3]   the C / boundary-evaluation candle
 *   @param {string} [options.trigger]   'BUY' | 'SELL' — ONLY when the
 *     backend actually triggered the trade on that candle. Never inferred.
 *   @param {number} [options.evaluationIndex]  3, 4, 5, ... — which
 *     evaluation candle `candle3` actually is, straight from the pattern
 *     candidate. Controls the label's code/badge only (C3/③, C4/④, ...);
 *     nothing here derives or increments it.
 */
function buildPatternVisual(candidate, options) {
  if (!candidate || !candidate.candle1) return null;

  const opts = options || {};
  const isNew = candidate.engine === 'NEW';
  const direction = candidate.direction === 'SELL' ? 'SELL' : 'BUY';
  const trigger = opts.trigger === 'BUY' || opts.trigger === 'SELL' ? opts.trigger : null;

  const c1 = buildLabel('CANDLE_1', candidate.candle1, { touch: !isNew });
  if (!c1) return null;
  const c2 = buildLabel('CANDLE_2', candidate.candle2, { touch: isNew });
  // The evaluation candle's code/badge come from the backend's own
  // evaluationIndex (C3, C4, C5, ...) — see evaluationCode above.
  const evalLabel = evaluationCode(opts.evaluationIndex);
  const c3 = buildLabel('CANDLE_3', opts.candle3, {
    trigger,
    code: evalLabel.code,
    badge: evalLabel.badge,
    evaluationIndex: Number.isFinite(Number(opts.evaluationIndex)) && Number(opts.evaluationIndex) >= 3
      ? Number(opts.evaluationIndex)
      : (opts.candle3 ? 3 : null),
  });

  return {
    patternId: `M002:${opts.instanceId}:${candidate.engine}:${direction}:${candidate.candle1.timestamp}`,
    instanceId: opts.instanceId,
    engine: candidate.engine,
    direction,
    stage: candidate.stage || null,
    // BUY labels sit below the candles, SELL labels above them.
    placement: direction === 'BUY' ? 'belowBar' : 'aboveBar',
    status: trigger ? 'TRIGGERED' : 'ACTIVE',
    // Which side this pattern's own level lives on — the side the TOUCH
    // label refers to. Straight from the candidate's direction.
    activeLevelSide: direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE',
    labels: [c1, c2, c3].filter(Boolean),
  };
}

/** The group's labels keyed by role, for consumers that want one of them. */
function labelsByRole(visual) {
  const out = {};
  if (visual && Array.isArray(visual.labels)) {
    visual.labels.forEach((l) => { out[l.role] = l; });
  }
  return out;
}

module.exports = { BADGES, CODES, buildPatternVisual, labelsByRole };
