'use strict';

/**
 * MODEL_002 reason-code -> human-readable text map.
 *
 * SINGLE SOURCE OF TRUTH for translating MODEL_002's internal snake_case
 * reason codes (bot-models/model-002/Model002.js and
 * sameSidePatternEngine.js — every string listed here was copied directly
 * from those files, not guessed) into the human-readable descriptions
 * shown in the Bot Detail UI. Used by BOTH:
 *   - public/js/bot-detail-ws.js (live decisions, browser)
 *   - views/bot-detail.ejs (server-rendered Decision History, Node)
 * so there is exactly one place these translations are defined — no
 * duplicate map in the EJS template.
 *
 * UMD: exports as `module.exports` under Node/CommonJS (require()'d
 * directly from an EJS template, which runs server-side) and as
 * `window.Model002ReasonMap` in the browser (loaded via a <script> tag,
 * same as model-thinking-registry.js).
 *
 * This only ever REPHRASES a reason MODEL_002 already produced — it never
 * invents a new reason or changes which decision (WAIT/BUY/SELL) was
 * made. An unmapped/unknown code falls back to the raw code itself rather
 * than silently hiding information.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Model002ReasonMap = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // Exact match to every `reason:` string in bot-models/model-002/Model002.js
  // and bot-models/model-002/sameSidePatternEngine.js.
  const REASON_TEXT = {
    // Safety / readiness / position gates
    three_consecutive_losses: 'Bot paused — 3 consecutive losses',
    insufficient_history: 'Waiting for enough candle history',
    position_already_open: 'Position already open — no new entry',

    // Opposite-side patterns (not yet specified) — always WAIT
    direct_entry_pending_client_confirmation: 'Opposite-side pattern — pending client confirmation, not traded',

    // Searching for Candle 1
    no_level_touch: 'Waiting for price to touch a configured level',

    // One-time opposite-market active-timeframe switch (ACTIVE_TIMEFRAME_SWITCHED)
    opposite_market_level_touch: 'Opposite market level touched — analysis timeframe switched to 1m',

    // Candle 1 found, awaiting Candle 2
    candle1_support_touch_awaiting_candle2: 'Support touched — Candle 1 set, awaiting Candle 2',
    candle1_resistance_touch_awaiting_candle2: 'Resistance touched — Candle 1 set, awaiting Candle 2',
    awaiting_candle2_body_touch: 'Waiting for a candle to touch Candle 1\'s body',

    // Candle 2 shape validation
    candle2_did_not_touch_body_high: 'Candle 2 rejected — did not touch Candle 1 body-high',
    candle2_did_not_touch_body_low: 'Candle 2 rejected — did not touch Candle 1 body-low',
    bodyP_not_maximum: 'Candle 2 rejected — BodyP was not the maximum value',
    candle2_not_bullish: 'Candle 2 rejected — not a bullish candle',
    candle2_not_bearish: 'Candle 2 rejected — not a bearish candle',
    candle2_confirmed: 'Candle 2 confirmed',

    // Candle 2 valid, awaiting boundary break
    candle2_confirmed_awaiting_boundary_break: 'Candle 2 confirmed — boundaries fixed, awaiting breakout',
    awaiting_boundary_break: 'Awaiting a close through the fixed boundary',

    // Invalidation
    invalidated_close_below_lower_boundary: 'Pattern invalidated — closed below the lower boundary',
    invalidated_close_above_upper_boundary: 'Pattern invalidated — closed above the upper boundary',

    // Risk / sizing rejections
    risk_length_exceeds_maximum: 'No trade — risk length exceeds the maximum (360)',
    lot_mapping_unavailable: 'No trade — risk length has no valid lot mapping',
    maximum_capital_leverage_limit: 'No trade — exceeds maximum capital x leverage limit',

    // One-time R1/S1 calibration (opposite-side patterns) — never a trade
    r1_calibration_confirmed_no_trade: 'Pattern confirmed — R1 updated, waiting for next R1 pattern',
    s1_calibration_confirmed_no_trade: 'Pattern confirmed — S1 updated, waiting for next S1 pattern',

    // Generic
    rejected: 'Rejected',
  };

  /**
   * @param {string} rawReason the exact reason code MODEL_002 emitted
   * @param {string} [decision] optional decision label ('BUY'/'SELL'/'WAIT') —
   *   only used to pass through the already-human-readable
   *   "<DIRECTION> pattern confirmed" text unchanged, never to invent one.
   * @returns {string} human-readable text; falls back to the raw code
   *   (never blank, never hides information) if genuinely unmapped.
   */
  function formatModel002Reason(rawReason) {
    if (!rawReason) return '';
    if (Object.prototype.hasOwnProperty.call(REASON_TEXT, rawReason)) {
      return REASON_TEXT[rawReason];
    }
    // "BUY pattern confirmed" / "SELL pattern confirmed" are already
    // human-readable template strings from Model002.js — pass through
    // unchanged rather than trying to re-map them.
    if (/^(BUY|SELL) pattern confirmed$/.test(rawReason)) {
      return rawReason;
    }
    // Unknown/unmapped — return the raw code rather than hiding it, so a
    // future new reason code is still visible (just unformatted) instead
    // of silently disappearing.
    return rawReason;
  }

  return { REASON_TEXT, formatModel002Reason };
});
