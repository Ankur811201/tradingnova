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

    // PHASE 2 — layer/success safety (independent of the 3-consecutive-
    // losses pause above). Emitted by the onMarketData eligibility gate
    // once the bot has permanently stopped trading.
    bot_max_layer_stopped: 'Bot stopped — maximum layer (6) reached',
    bot_success_stopped: 'Bot stopped — successful trade already reached (max 1 per bot)',
    // Same two stops, but as emitted on the BOT_SAFETY_STOP StrategyEvent
    // itself (Model002.js onPositionClosed) rather than the WAIT decision.
    max_layer_reached: 'Bot stopped — maximum layer (6) reached',
    successful_trade_reached: 'Bot stopped — successful trade already reached (max 1 per bot)',

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

    // NEW ENGINE (A/B/C wick-trigger spec) — same-side combinations only.
    // A/B validation (instant, at the touch candle itself)
    no_prior_candle_for_ab_validation: 'Touch detected, but no prior candle is available yet to validate against',
    ab_body_high_not_greater: 'Rejected — touch candle\'s body-high did not exceed the prior candle\'s',
    ab_body_low_not_less: 'Rejected — touch candle\'s body-low did not go below the prior candle\'s',
    // Candle 2 (B) confirmed, awaiting Candle 3 (the one and only trigger candle)
    candle2_confirmed_awaiting_candle3: 'Candle 2 confirmed — boundaries fixed, awaiting Candle 3',
    // Candle 3 (C) invalidation outcomes
    // Retired code — the model no longer emits it (a candle that touches
    // neither boundary now WAITs). Kept so historical Decision History rows
    // that already carry it still render as text, not as a raw code.
    invalidated_candle3_wrong_or_no_boundary_touch: 'Pattern invalidated — wrong boundary touched',
    invalidated_both_boundaries_tick_order: 'Pattern invalidated — live price reached the wrong boundary first',
    invalidated_both_boundaries_no_tick_evidence: 'Pattern invalidated — both boundaries touched, order could not be determined',

    // Candle 2 shape validation
    candle2_did_not_touch_body_high: 'Candle 2 rejected — did not touch Candle 1 body-high',
    candle2_did_not_touch_body_low: 'Candle 2 rejected — did not touch Candle 1 body-low',
    bodyP_not_maximum: 'Candle 2 rejected — BodyP was not the maximum value',
    candle2_not_bullish: 'Candle 2 rejected — not a bullish candle',
    candle2_not_bearish: 'Candle 2 rejected — not a bearish candle',
    candle2_confirmed: 'Candle 2 confirmed',

    // Candle 2 valid, awaiting boundary break
    candle2_confirmed_awaiting_boundary_break: 'Candle 2 confirmed — boundaries fixed, awaiting breakout',
    // Boundary evaluation after Candle 2 (A/B/C engine). "No trigger" is
    // not "invalid": the pattern stays active and the next candle is
    // evaluated against the same fixed boundaries.
    awaiting_boundary_touch: 'Waiting — the evaluation candle did not touch either boundary',
    invalidated_wrong_boundary_touched: 'Pattern invalidated — wrong boundary touched',
    // DISPLAY WORDING ONLY. The backend trigger rule is unchanged — see
    // sameSidePatternEngine.evaluateBoundaryBreak / reversalPatternEngine
    // .evaluateCandle3; nothing about when a trade fires depends on this map.
    awaiting_boundary_break: 'Waiting for Candle 3 to touch/cross the boundary',

    // Invalidation
    invalidated_close_below_lower_boundary: 'Pattern invalidated — closed below the lower boundary',
    invalidated_close_above_upper_boundary: 'Pattern invalidated — closed above the upper boundary',

    // Risk / sizing rejections
    risk_length_exceeds_maximum: 'No trade — risk length exceeds the maximum (360)',
    lot_mapping_unavailable: 'No trade — risk length has no valid lot mapping',
    // maximum_capital_leverage_limit removed: the maximum-capital x leverage
    // cap was removed from the active MODEL_002 path (Model002.js no longer
    // emits this reason), so this entry is now unreachable. Unmapped codes
    // fall back to the raw code (see formatModel002Reason below), so this
    // never silently hides a genuinely unknown/legacy code.

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
