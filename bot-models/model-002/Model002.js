'use strict';

const BotModelBase = require('../BotModelBase');
// Logger. Also carries the lot -> BTC quantity DIAG lines (see
// _confirmAndSubmit / _confirmAndSubmitNew) that let the RiskEngine.js
// "NOTIONAL" log line for the same commandId be cross-checked end-to-end.
// PHASE 1 is COMPLETE and APPROVED — these lines are now permanent
// operational tracing, no longer a temporary Phase 1 diagnostic.
const logger = require('../../utils/logger');
const { validateCandle, validateAndMergeParameters } = require('./validators');
const {
  findTouchedLevel, computeBuyStopLoss, computeSellStopLoss,
  candle2TouchesBodyHigh, candle2TouchesBodyLow,
  evaluateCandle2, computeBoundaries, evaluateBoundaryBreak,
  computeBuyRiskLength, computeSellRiskLength, computeLotFromRiskLength, computeQuantityFromLot, LOT_SIZE_BTC,
  computeCandle2Points, isBodyPMaximum, isCorrectCandleNature,
} = require('./sameSidePatternEngine');
// NEW spec (A/B/C wick-trigger reversal pattern) — same-side combinations
// (BULLISH+SUPPORT -> BUY, BEARISH+RESISTANCE -> SELL) ONLY. The opposite-
// side combinations (BULLISH+RESISTANCE, BEARISH+SUPPORT, with R1/S1
// calibration) are out of scope for this spec and keep using
// sameSidePatternEngine.js unchanged — see _tryStartFreshPattern below.
const reversalEngine = require('./reversalPatternEngine');
const { ConsecutiveLossSafety } = require('./safetyState');
const { LayerSafety } = require('./layerSafety');
const {
  isOppositeMarketTouch, getActiveTimeframe, hasSwitched, shouldSwitch,
  OPPOSITE_TOUCH_TIMEFRAME,
} = require('../../utils/activeTimeframe');
const {
  readLevelTouchState, applyLevelTouch, toChecksLevelStatus,
} = require('../../utils/levelTouchState');
const { buildPatternVisual } = require('../../utils/model002PatternVisual');

const RULE_ID_BUY = 'MODEL_002_SAME_SIDE_BUY';

// Confirmed requirement: a bot becomes ready for level monitoring after
// exactly 3 NEW eligible closed candles — a fixed rule, not a per-bot
// configurable value (unlike historySize, which stays a `parameters` key
// governing the pattern engine's rolling buffer window).
const MIN_CANDLES_FOR_READINESS = 3;
const RULE_ID_SELL = 'MODEL_002_SAME_SIDE_SELL';

const LEVERAGE_MIN = 1;
const LEVERAGE_MAX = 200;

/**
 * MODEL_002 — client-driven custom-pattern trading model.
 *
 * CURRENT CONFIRMED ROUTING — TWO ACTIVE ENGINES, both fully implemented
 * and both able to trade. They are deliberately kept SEPARATE: they are
 * never merged, and their stop-loss formulas stay independent.
 *
 *   BULLISH + SUPPORT    -> NEW engine, BUY   (reversalPatternEngine.js)
 *   BEARISH + RESISTANCE -> NEW engine, SELL  (reversalPatternEngine.js)
 *   BULLISH + RESISTANCE -> OLD engine, SELL  (sameSidePatternEngine.js)
 *   BEARISH + SUPPORT    -> OLD engine, BUY   (sameSidePatternEngine.js)
 *
 * "same-side" = the touched level agrees with the trend (NEW engine);
 * "opposite-side" = it does not (OLD engine). Routing lives in
 * _tryStartFreshPattern below. A third, SUPERSEDED generation
 * (patternEngine.js, counter-trend) still exists in the folder but is not
 * on either active trading path.
 *
 * LEVEL SELECTION — FIRST-MATCH-WINS (confirmed, do not change). When a
 * single candle touches more than one configured level, both active
 * engines take the FIRST configured level (lowest index) that the candle
 * touches and ignore the rest: see findTouchedLevel in
 * reversalPatternEngine.js and in sameSidePatternEngine.js — both return
 * on their first match. This is a LEVEL-selection policy and is entirely
 * separate from the OLD-engine CANDLE-1 REPLACEMENT behaviour described
 * below, which is about which CANDLE fills the Candle 1 slot over time.
 *
 * State machine (this.patternCandidate; null = IDLE):
 *
 *   NEW engine — the level-touch candle is Candle 2, not Candle 1 (A =
 *   the candle immediately before it = Candle 1). A and B are validated
 *   by BODY only at touch time, so there is no WAITING_FOR_CANDLE2 stage:
 *   a validated touch goes straight to AWAITING_CANDLE3 with boundaries
 *   already fixed at {upper: Candle2.high + 5, lower: Candle2.low - 5}.
 *   Candle 3 and every candle after it are evaluated against those SAME
 *   fixed boundaries until a trigger or an invalidation — a candle that
 *   touches neither boundary is WAIT, never INVALID. Full rules in
 *   reversalPatternEngine.js.
 *
 *   OLD engine — unchanged, two stages:
 *   WAITING_FOR_CANDLE2      — Candle 1 found, searching for a candle that
 *                              touches its body-high (BUY) / body-low
 *                              (SELL). NOT required to be the immediate
 *                              next candle. CANDLE-1 REPLACEMENT: a newer
 *                              Support/Resistance touch during this stage
 *                              REPLACES Candle 1 with the newer touch
 *                              candle and restarts the Candle 2 search —
 *                              recomputing SL from the new Candle 1. This
 *                              is a time-ordered replacement of the Candle
 *                              1 slot, NOT the level-selection policy
 *                              above (which stays first-match-wins for
 *                              every individual touch test).
 *   WAITING_FOR_BOUNDARY_BREAK — Candle 2 validated; boundaries fixed at
 *                              {upper: Candle2.high, lower: Candle2.low}
 *                              and monitored across as many future candles
 *                              as needed (confirmed: not only Candle 3) —
 *                              a strict close-through triggers BUY/SELL or
 *                              INVALID; touching a boundary or closing
 *                              exactly at it is WAIT. Candle-1 replacement
 *                              is NOT re-applied at this stage (the
 *                              requirement only describes it for the
 *                              Candle1->Candle2 search).
 *
 * On BUY/SELL confirmation the candidate is cleared after the
 * TradeCommand is submitted. On INVALID it is cleared immediately — the
 * invalidating candle itself is never re-evaluated as a new Candle 1 in
 * the same tick; search resumes fresh from the next candle.
 */
class Model002 extends BotModelBase {
  async onStart(instanceConfig) {
    this.params = validateAndMergeParameters(instanceConfig.parameters);

    if (!Number.isFinite(instanceConfig.leverage) || instanceConfig.leverage < LEVERAGE_MIN || instanceConfig.leverage > LEVERAGE_MAX) {
      throw new Error(
        `MODEL_002 requires leverage between ${LEVERAGE_MIN}x and ${LEVERAGE_MAX}x; received ${instanceConfig.leverage}. ` +
        `Invalid leverage is rejected, never silently clamped.`
      );
    }

    this.instanceId = instanceConfig.instanceId;
    this.symbol = instanceConfig.symbol;
    this.environment = instanceConfig.environment;
    // "Maximum Capital" (confirmed) IS the existing generic capitalAllocation field.
    this.capitalAllocation = instanceConfig.capitalAllocation;
    // Leverage: the maximum-capital x leverage notional CAP WAS REMOVED
    // (confirmed requirement) — leverage no longer caps, reduces or rejects
    // any quantity anywhere in this model. It is now purely a pass-through
    // value: reported for display/telemetry and handed straight to the
    // existing RiskEngine/ExecutionRouter pipeline via TradeCommand.
    // Never reduced, never overridden.
    this.leverage = instanceConfig.leverage;
    this.riskSettings = instanceConfig.riskSettings || {};

    this.candles = [];
    this.lastProcessedTs = null;

    // In-memory 3-candle pattern state machine (spec Steps 1-7/1-6). The
    // JS object itself is not written to any database, but a restart does
    // NOT lose the pattern — onHydrate() -> _reconstructPatternStateFromHistory()
    // reconstructs Candle 1 from the LAST valid same-side touch still
    // present in the hydrated candle history (see onHydrate below), using
    // the exact same construction the live touch path uses. A restart
    // only loses a pattern if the touching candle has aged out of the
    // hydration window entirely. If a position is already open when this
    // instance restarts, that position's own persisted stopLoss remains
    // the hard protection regardless of this in-memory state — see
    // onPositionClosed/restoreSafetyState below for the equivalent
    // restart-recovery contract on the safety side.
    this.patternCandidate = null;

    // One-time R1/S1 calibration flags (opposite-side patterns). In-memory
    // only — no MongoDB persistence yet, per explicit instruction. Start
    // false on every onStart/restart; _reconstructPatternStateFromHistory
    // deterministically re-derives the true value from whatever calibration
    // evidence is actually present in the hydrated candle window. If that
    // evidence predates the window, it cannot be seen — this is a known,
    // documented, tested limitation (not a silent guess): see
    // tests/model002.sameSidePattern.test.js "CALIBRATION HISTORY OUTSIDE
    // HYDRATION WINDOW".
    this.r1Calibrated = false;
    this.s1Calibrated = false;

    // Confirmed — 3 consecutive losses pauses the bot. Real state, driven
    // exclusively by onPositionClosed() below (authoritative Trade
    // records), never by candle-close inference.
    this.safety = new ConsecutiveLossSafety(this.params.consecutiveLossLimit);

    // PHASE 2 — layer/success safety (confirmed requirements: max 2 losses
    // per layer, max 6 layers, max 1 successful trade per bot). Entirely
    // independent of this.safety above — see layerSafety.js class doc.
    // Also driven exclusively by onPositionClosed() below.
    this.layerSafety = new LayerSafety();

    this.paused = false;
    this.stopped = false;

    // ONE-TIME OPPOSITE-MARKET TIMEFRAME SWITCH — per-instance state, read
    // back from this instance's own persisted `parameters` (written by
    // BotManager when the switch happened). Never a module-level/global
    // value: two Model002 instances in the same process each carry their
    // own flag, so one bot switching can never affect another. On a
    // restart these come back as `true`/'1m' from MongoDB, which is what
    // prevents the switch (and its log entry) from happening a second time.
    this.timeframeSwitched = hasSwitched(this.params);
    this.activeTimeframe = getActiveTimeframe(this.params);

    // PERSISTENT LEVEL-TOUCH STATE — per-instance, read back from this
    // instance's own persisted `parameters` (written by BotManager when the
    // touch happened), exactly like the timeframe-switch latch above. Never
    // a module-level/global value: two Model002 instances in the same
    // process each carry their own object, so Bot A's "Support: TOUCHED"
    // can never appear on Bot B. This is LEVEL state and is deliberately
    // independent of `patternCandidate` (PATTERN state) — a pattern can be
    // INVALID while the level stays TOUCHED.
    this.levelTouch = readLevelTouchState(this.params);

    // True only while _reconstructPatternStateFromHistory() is replaying
    // hydrated candles — that replay must stay entirely silent (it already
    // never emits or trades), so level touches it re-derives update the
    // in-memory latch without emitting a LEVEL_TOUCHED event.
    this._hydrating = false;

    this.emitStrategyEvent('MODEL_STARTED', {
      symbol: this.symbol,
      environment: this.environment,
      timeframe: this.params.timeframe,
      activeTimeframe: this.activeTimeframe,
      timeframeSwitched: this.timeframeSwitched,
      trend: this.params.trend,
      support: this.params.support,
      resistance: this.params.resistance,
      maximumCapital: this.capitalAllocation,
      leverage: this.leverage,
      maximumAllowedNotional: this.capitalAllocation * this.leverage,
    });
  }

  // --- Hydration — never trades on historical data ---------------------

  async onHydrate(closedCandles) {
    this.candles = this._mergeHydratedCandles(this.candles, closedCandles, this.params.historySize);
    if (this.candles.length) this.lastProcessedTs = this.candles[this.candles.length - 1].timestamp;

    // Client-confirmed rule: "use last touch," extended to the FULL
    // unfinished pattern, not just Candle 1. After a restart, a pattern
    // that had already progressed to a validated Candle 2 with fixed
    // boundaries must not be forgotten and reset back to
    // WAITING_FOR_CANDLE2 — that would lose real, already-computed state
    // for no reason. Replays the deterministic state machine across the
    // full hydrated history to land in whatever stage the live process
    // actually reached. Never emits a DECISION event and never submits a
    // TradeCommand — it only reconstructs state; a real BUY/SELL still
    // only ever happens from a live candle going forward, unchanged.
    this._reconstructPatternStateFromHistory();

    this.emitStrategyEvent('MODEL_HYDRATED', {
      symbol: this.symbol, timeframe: this.params.timeframe,
      candlesLoaded: this.candles.length, required: MIN_CANDLES_FOR_READINESS,
    });
  }

  /**
   * Full deterministic state-machine replay across the hydrated candle
   * history — NOT just a last-touch scan. A restart must not lose an
   * already-validated Candle 2 and its fixed boundaries; it must land in
   * whatever stage (WAITING_FOR_CANDLE2 or WAITING_FOR_BOUNDARY_BREAK) the
   * live process would actually have reached by the end of this same
   * candle sequence.
   *
   * Replays the exact same transitions the live path uses
   * (_buildCandle1Candidate, evaluateCandle2, computeBoundaries,
   * evaluateBoundaryBreak — no new formula, no new rule) forward across
   * `this.candles`, oldest -> newest, entirely silently: no
   * emitStrategyEvent, no submitTradeCommand, ever. A historical
   * BUY/SELL/INVALID resolution, or a candle that fails Candle 2
   * validation, resets the candidate — but that same candle is then
   * immediately re-checked for being a fresh same-side touch in its own
   * right (a failed Candle 2 or a resolved pattern does not mean that
   * candle wasn't also a valid touch), so a genuine touch is never
   * silently skipped just because it also played another role. This
   * mirrors the live re-entry rule (no cooldown) so an already-completed
   * pattern can never be "reused" as if it were still pending. Whether the
   * trade that resulted from a historical completion is still open is
   * irrelevant to this replay's correctness: onMarketData's existing
   * position_already_open guard independently blocks any new entry
   * evaluation for as long as a real open Position exists, regardless of
   * what this method leaves in patternCandidate.
   */
  _reconstructPatternStateFromHistory() {
    const trend = this.params.trend;
    this.patternCandidate = null;
    if (trend !== 'BULLISH' && trend !== 'BEARISH') return;

    this._hydrating = true;
    try {
      this._replayPatternStateFromHistory();
    } finally {
      this._hydrating = false;
    }
  }

  _replayPatternStateFromHistory() {
    let candidate = null;

    for (let i = 0; i < this.candles.length; i += 1) {
      const candle = this.candles[i];
      const prevCandle = i > 0 ? this.candles[i - 1] : null;

      if (candidate && candidate.engine === 'NEW' && candidate.stage === 'AWAITING_CANDLE3') {
        // Boundary evaluation candle — no live tick evidence exists during
        // replay, so the both-boundaries-touched case conservatively
        // resolves to INVALID (same documented fallback as live — see
        // reversalPatternEngine.js). A candle that touches NEITHER boundary
        // resolves to WAIT and keeps the pattern alive with its boundaries
        // unchanged, exactly as the live path does; only a resolved
        // (BUY/SELL/INVALID) outcome clears the candidate. Either way this
        // exact candle is NOT re-checked as a fresh touch (spec: restart
        // never reuses old Candle1/Candle2).
        const replayResult = reversalEngine.evaluateCandle3(candle, candidate.boundaries, candidate.direction, null);
        if (replayResult.outcome === 'WAIT') {
          candidate = Object.assign({}, candidate, {
            evaluationIndex: (candidate.evaluationIndex || 2) + 1,
            lowestLowSinceCandle2: Math.min(
              Number.isFinite(candidate.lowestLowSinceCandle2) ? candidate.lowestLowSinceCandle2 : candidate.candle2.low,
              candle.low
            ),
            highestHighSinceCandle2: Math.max(
              Number.isFinite(candidate.highestHighSinceCandle2) ? candidate.highestHighSinceCandle2 : candidate.candle2.high,
              candle.high
            ),
            firstLiveBoundaryTouch: null,
          });
          continue;
        }
        candidate = null;
        continue;
      }

      if (candidate && candidate.engine === 'OLD' && candidate.stage === 'WAITING_FOR_CANDLE2') {
        // Last-touch-wins applies at this stage, same as live — only the
        // SAME level type as the active candidate's own direction.
        const levels = candidate.direction === 'BUY' ? this.params.support : this.params.resistance;
        const newTouch = findTouchedLevel(levels, candle);
        if (newTouch) {
          candidate = this._buildCandle1Candidate(candle, candidate.direction, newTouch);
          continue; // this candle's role (fresh Candle 1) is fully handled
        }

        const touchesBody = candidate.direction === 'BUY'
          ? candle2TouchesBodyHigh(candidate.candle1, candle)
          : candle2TouchesBodyLow(candidate.candle1, candle);
        if (touchesBody) {
          const result = evaluateCandle2(candidate.candle1, candle, candidate.direction);
          if (result.valid) {
            candidate = Object.assign({}, candidate, {
              stage: 'WAITING_FOR_BOUNDARY_BREAK', candle2: candle, points: result.points,
              boundaries: computeBoundaries(candle),
            });
            continue;
          }
          // Candle 2 FAILED for the old candidate — this does NOT mean this
          // candle wasn't a valid touch. It only means it failed to
          // validate as Candle 2 for that specific Candle 1. Fall through
          // (do not `continue`) so this exact candle is still checked below
          // for being a fresh same-side touch in its own right.
          candidate = null;
        } else {
          continue; // still waiting, unchanged — Candle 2 need not be the immediate next candle
        }
      } else if (candidate && candidate.stage === 'WAITING_FOR_BOUNDARY_BREAK') {
        // Last-touch-wins is NOT re-applied at this stage, same as live.
        const boundaryResult = evaluateBoundaryBreak(candle, candidate.boundaries, candidate.direction);
        if (boundaryResult.outcome === 'WAIT') continue; // boundaries stay fixed, unchanged

        if (candidate.isCalibrationPattern && (boundaryResult.outcome === 'BUY' || boundaryResult.outcome === 'SELL')) {
          // One-time calibration, reconstructed deterministically — never a
          // trade during replay (or ever, for a calibration pattern).
          // Client-confirmed rule: strictly the NEXT candle may start a
          // fresh search — this resolving candle is NOT re-checked for a
          // fresh touch, unlike the general INVALID/failed-Candle-2 case.
          this._applyCalibration(candidate);
          candidate = null;
          continue;
        }

        // BUY / SELL / INVALID all resolve the pattern historically. Fall
        // through (do not `continue`) so this exact resolving candle is
        // still checked below for being a fresh touch of its own — a
        // pattern resolving on this candle doesn't preclude the SAME
        // candle also being where the next pattern starts.
        candidate = null;
      }

      // No active candidate — either there never was one, or one was just
      // discarded/resolved above on THIS SAME candle (except the
      // calibration case above, and the NEW-engine Candle-3 resolution
      // above, both of which explicitly skip this). Check whether this
      // candle is itself a fresh pattern start, via the SAME shared logic
      // the live path uses (_tryStartFreshPattern) — silently: a rejected
      // same-side A/B attempt is simply not adopted, never emitted here.
      if (!candidate) {
        const attempt = this._tryStartFreshPattern(candle, prevCandle);
        if (attempt && attempt.candidate) candidate = attempt.candidate;
      }
    }

    this.patternCandidate = candidate;
  }

  /** Inert no-op — MODEL_002 declares no requiredTimeframes. Kept so shared Part A infra stays intact for other models. */
  async onHydrateTimeframe(_timeframe, _closedCandles) {}

  getReadiness() {
    const have = this.candles.length;
    // Startup readiness is DECOUPLED from historySize (confirmed
    // requirement — do not conflate "how many candles until the bot will
    // attempt a decision" with "how large a rolling buffer window
    // Candle-2/Candle-1-replacement search can look back across", which is
    // what historySize actually governs elsewhere: _mergeHydratedCandles/
    // _appendAndTrim (buffer cap) and BotManager's hydration fetch cap).
    // this.candles is already scoped to only post-creation (and, after a
    // levels/trend change, post-levelsUpdatedAt) candles by BotManager's
    // hydration filter — so "3 candles in the buffer" already means
    // exactly "3 NEW eligible closed candles", with no separate timestamp
    // tracking needed here.
    const required = MIN_CANDLES_FOR_READINESS;
    return { ready: have >= required, have, required };
  }

  async onPause() {
    this.paused = true;
    this.emitStrategyEvent('MODEL_PAUSED', { symbol: this.symbol });
  }

  async onStop() {
    this.stopped = true;
    this.paused = true;
    this.emitStrategyEvent('MODEL_STOPPED', { symbol: this.symbol });
    this.candles = [];
    this.patternCandidate = null;
  }

  /**
   * Called by BotManager.dispatchMarketData (additive hook — see
   * BotManager.js) exactly once per genuinely closed position, with the
   * position's own authoritative Trade record (Trade.js: realizedPnl,
   * reason, closedAt — the same record PaperEngine/LiveEngine create on
   * every close). This is the real WIN/LOSS/BREAK_EVEN source of truth —
   * no candle-close comparison is used anywhere in this class anymore.
   *
   * Deduplication: ConsecutiveLossSafety.recordTradeOutcome keys on
   * trade._id and will never double-count the same closed trade, even if
   * this hook is somehow invoked twice for it.
   */
  async onPositionClosed(trade) {
    const { outcome, state, duplicate } = this.safety.recordTradeOutcome(trade._id, trade.realizedPnl);

    if (duplicate) {
      this.emitStrategyEvent('SAFETY_DUPLICATE_TRADE_IGNORED', { tradeId: String(trade._id) });
      return;
    }

    this.emitStrategyEvent('SAFETY_STATE_UPDATED', {
      tradeId: String(trade._id),
      realizedPnl: trade.realizedPnl,
      closeReason: trade.reason,
      outcome,
      consecutiveLosses: state.consecutiveLosses,
      paused: state.paused,
      limit: state.limit,
    });

    if (state.paused) {
      this.emitStrategyEvent('BOT_SAFETY_PAUSED', {
        reason: 'three_consecutive_losses',
        consecutiveLosses: state.consecutiveLosses,
        limit: state.limit,
      });
    }

    // PHASE 2 — layer/success safety. Separate call, separate dedup set,
    // driven by the same authoritative trade._id/realizedPnl — see
    // layerSafety.js. Deliberately NOT short-circuited by the
    // ConsecutiveLossSafety `duplicate` check above: the two trackers are
    // independent and each does its own dedup against the same tradeId.
    const layerResult = this.layerSafety.recordTradeOutcome(trade._id, trade.realizedPnl);
    if (layerResult.duplicate) {
      this.emitStrategyEvent('LAYER_SAFETY_DUPLICATE_TRADE_IGNORED', { tradeId: String(trade._id) });
    } else if (layerResult.transition) {
      this.emitStrategyEvent('LAYER_SAFETY_STATE_UPDATED', {
        tradeId: String(trade._id),
        realizedPnl: trade.realizedPnl,
        outcome: layerResult.outcome,
        transition: layerResult.transition,
        currentLayer: layerResult.state.currentLayer,
        layerLossCount: layerResult.state.layerLossCount,
        successfulTradeCount: layerResult.state.successfulTradeCount,
        safetyStatus: layerResult.state.safetyStatus,
      });
      if (layerResult.transition === 'MAX_LAYER_STOPPED') {
        this.emitStrategyEvent('BOT_SAFETY_STOP', {
          reason: 'max_layer_reached',
          currentLayer: layerResult.state.currentLayer,
          layerLossCount: layerResult.state.layerLossCount,
        });
      } else if (layerResult.transition === 'SUCCESS_STOPPED') {
        this.emitStrategyEvent('BOT_SAFETY_STOP', {
          reason: 'successful_trade_reached',
          successfulTradeCount: layerResult.state.successfulTradeCount,
        });
      }
    }
  }

  /** Read by BotManager._recoverSafetyState to decide `paused` when reconstructing state from Trade history after a restart. */
  getSafetyLossLimit() {
    return this.params.consecutiveLossLimit;
  }

  /** Called by BotManager._recoverSafetyState right after hydration, before live dispatch begins. Restart must never silently reset an in-progress or already-paused streak. */
  restoreSafetyState(state) {
    this.safety.restoreState(state);
    if (state && state.paused) {
      this.emitStrategyEvent('SAFETY_STATE_RESTORED', {
        consecutiveLosses: state.consecutiveLosses, paused: state.paused,
        note: 'Restart preserved an existing safety pause — bot remains paused until explicit operator action.',
      });
    }
  }

  /**
   * PHASE 2. Called by BotManager._recoverLayerSafetyState right after
   * hydration, before live dispatch begins — same restart-recovery
   * contract as restoreSafetyState above, for the independent layer/
   * success tracker.
   */
  restoreLayerSafetyState(state) {
    this.layerSafety.restoreState(state);
    if (state && state.safetyStatus && state.safetyStatus !== 'NORMAL') {
      this.emitStrategyEvent('LAYER_SAFETY_STATE_RESTORED', {
        currentLayer: state.currentLayer,
        layerLossCount: state.layerLossCount,
        successfulTradeCount: state.successfulTradeCount,
        safetyStatus: state.safetyStatus,
        note: 'Restart preserved an existing layer/success safety stop — bot remains stopped until explicit operator action.',
      });
    }
  }

  // --- Live market data --------------------------------------------------

  async onMarketData(marketUpdate, positionContext) {
    if (this.paused || this.stopped) return;
    if (!marketUpdate || marketUpdate.symbol !== this.symbol) return;

    // Existing type:'price' tick stream (already dispatched by
    // BotManager.dispatchMarketData to every live instance on the symbol —
    // no new connection/listener) — reused ONLY to break the "Candle 3
    // touches both boundaries" tie (spec §10). No other side effects.
    if (marketUpdate.type === 'price') {
      this._trackLiveBoundaryTouch(marketUpdate);
      return;
    }

    if (marketUpdate.type !== 'candle') return;
    if (marketUpdate.timeframe !== this.params.timeframe) return; // only the configured execution timeframe — never Daily/1H

    const candle = marketUpdate.data;
    if (!validateCandle(candle)) {
      this.emitError('Malformed candle rejected', { candle, timeframe: marketUpdate.timeframe });
      return;
    }

    if (this.lastProcessedTs !== null && candle.timestamp <= this.lastProcessedTs) return; // dedup
    this.lastProcessedTs = candle.timestamp;

    this.candles = this._appendAndTrim(this.candles, candle, this.params.historySize);

    if (this.safety.paused) {
      this._emitDecision('WAIT', { reason: 'three_consecutive_losses', safety: this.safety.getState() }, candle);
      return;
    }

    // PHASE 2 — layer/success safety eligibility gate. Runs BEFORE any
    // pattern evaluation (same placement as the safety.paused gate above,
    // per the existing architecture) so a stopped bot never even attempts
    // to build a candidate, let alone reach RiskEngine. Functionally
    // equivalent to (and strictly earlier than) gating right before
    // TradeCommand submission — no TradeCommand is ever constructed once
    // stopped.
    if (this.layerSafety.safetyStatus !== 'NORMAL') {
      this._emitDecision('WAIT', {
        reason: this.layerSafety.safetyStatus === 'SUCCESS_STOPPED' ? 'bot_success_stopped' : 'bot_max_layer_stopped',
        layerSafety: this.layerSafety.getState(),
      }, candle);
      return;
    }

    const readiness = this.getReadiness();
    if (!readiness.ready) {
      this._emitDecision('WAIT', { reason: 'insufficient_history', readiness }, candle);
      return;
    }

    if (positionContext) {
      // Confirmed: no pyramiding, no new entry while a position is open.
      this._emitDecision('WAIT', { reason: 'position_already_open' }, candle);
      return;
    }

    await this._evaluateEntry(candle);
  }

  async _evaluateEntry(candle) {
    if (this.patternCandidate) {
      await this._advancePatternCandidate(candle);
      return;
    }
    await this._searchForPatternStart(candle);
  }

  /**
   * Looks for a fresh pattern start, trend-prioritized exactly as before
   * (BULLISH checks Support first then Resistance; BEARISH the mirror).
   * Delegates the actual same-side/opposite-side decision + engine
   * selection to _tryStartFreshPattern (shared with hydration replay).
   */
  async _searchForPatternStart(candle) {
    const prevCandle = this.candles.length >= 2 ? this.candles[this.candles.length - 2] : null;
    const attempt = this._tryStartFreshPattern(candle, prevCandle, /* live */ true);

    if (!attempt) {
      this._emitDecision('WAIT', { reason: 'no_level_touch' }, candle);
      return;
    }

    if (attempt.rejected) {
      // A same-side touch (B) was found but failed A/B/BodyP/nature
      // validation — per spec §4, do NOT create Candle1/Candle2; stay IDLE
      // and keep searching from the next candle.
      this.patternCandidate = null;
      this._emitDecision('WAIT', attempt.rejected, candle);
      return;
    }

    this.patternCandidate = attempt.candidate;

    if (attempt.candidate.engine === 'NEW') {
      this._emitDecision('WAIT', {
        reason: 'candle2_confirmed_awaiting_candle3', direction: attempt.candidate.direction,
        activeLevel: this._activeLevelFor(attempt.candidate),
        candle1: this._summarizeCandle(attempt.candidate.candle1),
        candle2: this._summarizeCandle(attempt.candidate.candle2),
        points: attempt.candidate.points, boundaries: attempt.candidate.boundaries,
        bodyReference: this._bodyReferenceFor(attempt.candidate),
        patternVisual: this._patternVisualFor(attempt.candidate),
      }, candle);
      return;
    }

    // OLD engine (opposite-side) — identical WAIT emit to the pre-existing behavior.
    this._emitDecision('WAIT', {
      reason: attempt.candidate.direction === 'BUY' ? 'candle1_support_touch_awaiting_candle2' : 'candle1_resistance_touch_awaiting_candle2',
      direction: attempt.candidate.direction,
      activeLevel: this._activeLevelFor(attempt.candidate),
      candle1: this._summarizeCandle(attempt.candidate.candle1),
    }, candle);
  }

  /**
   * Shared "is this candle a valid fresh pattern start?" logic, used by
   * BOTH the live search (_searchForPatternStart, above) and the silent
   * hydration replay (_reconstructPatternStateFromHistory) — a single
   * source of truth so live and replay can never disagree.
   *
   * Same-side combination for the current trend (BULLISH->Support,
   * BEARISH->Resistance) is checked FIRST using the NEW A/B/C engine —
   * `prevCandle` (the candle immediately before `candle`) is REQUIRED for
   * its body-high/body-low (A vs B) validation, per spec §2/§3/§12. If
   * that's not touched, the opposite-side combination is checked using the
   * unchanged OLD engine (candle1_touch -> WAITING_FOR_CANDLE2), exactly
   * as before this spec revision.
   *
   * Returns:
   *   null                    — nothing touched at all.
   *   { candidate }           — a valid new pattern candidate (either engine).
   *   { rejected: {...} }     — a same-side (NEW engine) touch was found but
   *                             failed A/B/BodyP/nature validation; caller
   *                             decides whether/how to report it (silent
   *                             during replay).
   */
  _tryStartFreshPattern(candle, prevCandle, live = false) {
    const trend = this.params.trend;
    if (trend !== 'BULLISH' && trend !== 'BEARISH') return null;

    const sameSideLevels = trend === 'BULLISH' ? this.params.support : this.params.resistance;
    const sameSideDirection = trend === 'BULLISH' ? 'BUY' : 'SELL';
    const oppositeSideLevels = trend === 'BULLISH' ? this.params.resistance : this.params.support;
    const oppositeSideDirection = trend === 'BULLISH' ? 'SELL' : 'BUY';

    const newTouch = reversalEngine.findTouchedLevel(sameSideLevels, candle, sameSideDirection);
    if (newTouch) {
      // PERSISTENT LEVEL-TOUCH STATE — recorded on the TOUCH itself, using
      // this path's own already-computed direction/matchedLevel (no second
      // Support/Resistance detector anywhere). Deliberately BEFORE the A/B,
      // BodyP and candle-nature validations below: the level really was
      // touched even when the pattern that touch tried to start is
      // rejected, and that fact must survive the rejection.
      this._recordLevelTouch(sameSideDirection, newTouch, candle);

      // ONE-TIME OPPOSITE-MARKET TIMEFRAME SWITCH fires on the touch
      // itself, live only — hydration replay must stay entirely silent
      // (no emitStrategyEvent), exactly as it always has.
      if (live) this._maybeSwitchToOppositeMarketTimeframe(candle, sameSideDirection, newTouch);

      if (!prevCandle) {
        return { rejected: {
          reason: 'no_prior_candle_for_ab_validation', direction: sameSideDirection,
          activeLevel: this._activeLevelFor({ direction: sameSideDirection, matchedLevel: newTouch }),
        } };
      }

      const ab = reversalEngine.validateAB(prevCandle, candle, sameSideDirection);
      if (!ab.valid) {
        return { rejected: {
          reason: sameSideDirection === 'BUY' ? 'ab_body_high_not_greater' : 'ab_body_low_not_less',
          direction: sameSideDirection,
          activeLevel: this._activeLevelFor({ direction: sameSideDirection, matchedLevel: newTouch }),
          candle1: this._summarizeCandle(prevCandle), candle2: this._summarizeCandle(candle),
        } };
      }

      // Preserved existing Candle-2 validation (BodyP-maximum-of-three,
      // correct candle nature) — applied to B now that it's Candle 2,
      // per spec §5 ("do not silently remove these existing validations
      // unless they directly contradict the new explicit rules"). The old
      // touch-based candle2TouchesBodyHigh/Low check IS superseded (the
      // new body-high/low comparison directly contradicts it), so it is
      // NOT applied here.
      const points = computeCandle2Points(candle, sameSideDirection);
      if (!isBodyPMaximum(points)) {
        return { rejected: {
          reason: 'bodyP_not_maximum', direction: sameSideDirection,
          activeLevel: this._activeLevelFor({ direction: sameSideDirection, matchedLevel: newTouch }),
          candle1: this._summarizeCandle(prevCandle), candle2: this._summarizeCandle(candle), points,
        } };
      }
      if (!isCorrectCandleNature(candle, sameSideDirection)) {
        return { rejected: {
          reason: sameSideDirection === 'BUY' ? 'candle2_not_bullish' : 'candle2_not_bearish', direction: sameSideDirection,
          activeLevel: this._activeLevelFor({ direction: sameSideDirection, matchedLevel: newTouch }),
          candle1: this._summarizeCandle(prevCandle), candle2: this._summarizeCandle(candle), points,
        } };
      }

      const boundaries = reversalEngine.computeBoundaries(candle);
      return { candidate: {
        engine: 'NEW', direction: sameSideDirection, candle1: prevCandle, candle2: candle,
        matchedLevel: newTouch, stage: 'AWAITING_CANDLE3', boundaries, points,
        firstLiveBoundaryTouch: null, // live tick tie-break — see _trackLiveBoundaryTouch
      } };
    }

    // Opposite-side combination — OLD engine, entirely unchanged.
    const oldTouch = findTouchedLevel(oppositeSideLevels, candle);
    if (oldTouch) {
      if (live) this._maybeSwitchToOppositeMarketTimeframe(candle, oppositeSideDirection, oldTouch);
      return { candidate: this._buildCandle1Candidate(candle, oppositeSideDirection, oldTouch) };
    }

    return null;
  }

  /** Constructs the Candle 1 candidate object — the single source of truth for Candle 1 state, reused by both the live touch path and hydration recovery. Never emits anything; callers decide what (if anything) to emit. */
  /**
   * One-time R1/S1 calibration (opposite-side patterns only): the FIRST
   * confirmed pattern at index-1 (R1 for BULLISH+RESISTANCE=SELL, S1 for
   * BEARISH+SUPPORT=BUY) is never traded — it calibrates that level to
   * Candle1.high/low instead. Computed fresh every time a Candle 1
   * candidate is (re)built (including OLD-engine Candle-1 replacements), so it
   * always reflects the CURRENT calibration flag at that moment, then
   * locked into the candidate until it resolves.
   */
  _computeIsCalibrationPattern(direction, matchedLevel) {
    if (direction === 'SELL' && this.params.trend === 'BULLISH' && matchedLevel.index === 1) {
      return !this.r1Calibrated;
    }
    if (direction === 'BUY' && this.params.trend === 'BEARISH' && matchedLevel.index === 1) {
      return !this.s1Calibrated;
    }
    return false;
  }

  _buildCandle1Candidate(candle, direction, matchedLevel) {
    // OLD (opposite-side) engine touch — the single place every OLD-engine
    // Candle 1 is constructed (fresh search, live Candle-1 replacement
    // replacement and hydration replay all go through here), so the
    // level-touch latch is recorded exactly once per touch with no separate
    // detector.
    this._recordLevelTouch(direction, matchedLevel, candle);
    return {
      engine: 'OLD', // opposite-side combinations only — see _tryStartFreshPattern
      direction, candle1: candle, matchedLevel, stage: 'WAITING_FOR_CANDLE2',
      isCalibrationPattern: this._computeIsCalibrationPattern(direction, matchedLevel),
    };
  }

  /**
   * ONE-TIME OPPOSITE-MARKET TIMEFRAME SWITCH (detection side).
   *
   * Deliberately NOT a second, independent detector: it is called from
   * _startCandle1 — the single existing place where a fresh Support/
   * Resistance touch is recognised (both the normal search and the
   * Candle-1 replacement path go through it) — and it reuses that
   * path's own already-computed `direction`/`matchedLevel`. A SELL
   * candidate is by definition a RESISTANCE touch and a BUY candidate a
   * SUPPORT touch, so the opposite-market rule can be evaluated directly
   * from the existing state with no re-derivation that could ever disagree
   * with MODEL_002's own touch logic.
   *
   * It fires on the TOUCH itself — never on Candle 2, boundary break,
   * invalidation, or BUY/SELL (§16) — and only ever ONCE per BotInstance.
   * The model does not (and must not) persist anything itself: it emits a
   * StrategyEvent through the existing emit pipeline and BotManager owns
   * persistence + candle routing.
   */
  _maybeSwitchToOppositeMarketTimeframe(candle, direction, matchedLevel) {
    if (this.timeframeSwitched) return;                    // §5 one-time latch
    if (!shouldSwitch(this.params)) return;                // §6 already 1m -> nothing to do

    const touchedSide = direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
    if (!isOppositeMarketTouch(this.params.trend, touchedSide)) return;

    const from = this.activeTimeframe;
    this.timeframeSwitched = true;
    this.activeTimeframe = OPPOSITE_TOUCH_TIMEFRAME;

    this.emitStrategyEvent('ACTIVE_TIMEFRAME_SWITCHED', {
      reason: 'opposite_market_level_touch',
      trend: this.params.trend,
      touchedSide,
      level: { index: matchedLevel.index, price: matchedLevel.price },
      configuredTimeframe: this.params.timeframe,
      previousActiveTimeframe: from,
      activeTimeframe: OPPOSITE_TOUCH_TIMEFRAME,
      at: candle.timestamp,
      message: `Opposite market detected: ${this.params.trend} + ${touchedSide === 'SUPPORT' ? 'Support' : 'Resistance'} touch. `
        + `Analysis timeframe switched from ${from} to ${OPPOSITE_TOUCH_TIMEFRAME}.`,
    });
  }

  _startCandle1(candle, direction, matchedLevel) {
    this.patternCandidate = this._buildCandle1Candidate(candle, direction, matchedLevel);
    this._maybeSwitchToOppositeMarketTimeframe(candle, direction, matchedLevel);
    this._emitDecision('WAIT', {
      reason: direction === 'BUY' ? 'candle1_support_touch_awaiting_candle2' : 'candle1_resistance_touch_awaiting_candle2',
      direction,
      activeLevel: { side: direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE', index: matchedLevel.index, price: matchedLevel.price },
      candle1: this._summarizeCandle(candle),
    }, candle);
  }

  /** Advances an in-progress pattern candidate through Candle 2 (shape validation, with OLD-engine Candle-1 replacement) or the fixed-boundary confirmation stage. */
  async _advancePatternCandidate(candle) {
    const candidate = this.patternCandidate;

    if (candidate.engine === 'NEW') {
      await this._advanceNewEngineCandidate(candle);
      return;
    }

    if (candidate.stage === 'WAITING_FOR_CANDLE2') {
      // CONFIRMED — OLD-ENGINE CANDLE-1 REPLACEMENT: a newer Support/
      // Resistance touch while still searching for Candle 2 replaces
      // Candle 1 entirely (and therefore SL, recomputed from the new
      // Candle 1) and restarts the Candle 2 search. This check runs
      // BEFORE the body-high/low touch check, per the requirement's own
      // ordering ("if another touch happens before Candle 2 is found,
      // replace... restart").
      //
      // NOT to be confused with level selection: findTouchedLevel below
      // is still FIRST-MATCH-WINS (first configured level the candle
      // touches). This rule is about which CANDLE occupies the Candle 1
      // slot over successive candles; first-match-wins is about which
      // LEVEL a single candle is matched against. Both are confirmed and
      // neither may be changed.
      const levels = candidate.direction === 'BUY' ? this.params.support : this.params.resistance;
      const newTouch = findTouchedLevel(levels, candle);
      if (newTouch) {
        this._startCandle1(candle, candidate.direction, newTouch);
        return;
      }

      // Candle 2 is not required to be the immediate next candle — only
      // evaluate it once this candle actually touches Candle 1's
      // body-high (BUY) / body-low (SELL); otherwise keep waiting,
      // unchanged, for a future candle.
      const touchesBody = candidate.direction === 'BUY'
        ? candle2TouchesBodyHigh(candidate.candle1, candle)
        : candle2TouchesBodyLow(candidate.candle1, candle);
      if (!touchesBody) {
        this._emitDecision('WAIT', {
          reason: 'awaiting_candle2_body_touch', direction: candidate.direction,
          activeLevel: this._activeLevelFor(candidate),
          candle1: this._summarizeCandle(candidate.candle1),
        }, candle);
        return;
      }

      const result = evaluateCandle2(candidate.candle1, candle, candidate.direction);
      if (!result.valid) {
        this.patternCandidate = null;
        this._emitDecision('WAIT', {
          reason: result.reason, direction: candidate.direction,
          activeLevel: this._activeLevelFor(candidate),
          candle1: this._summarizeCandle(candidate.candle1),
          candle2: this._summarizeCandle(candle),
          points: result.points || null,
        }, candle);
        return;
      }

      const boundaries = computeBoundaries(candle);
      this.patternCandidate = Object.assign({}, candidate, {
        stage: 'WAITING_FOR_BOUNDARY_BREAK', candle2: candle, points: result.points, boundaries,
      });
      this._emitDecision('WAIT', {
        reason: 'candle2_confirmed_awaiting_boundary_break', direction: candidate.direction,
        activeLevel: this._activeLevelFor(candidate),
        candle1: this._summarizeCandle(candidate.candle1),
        candle2: this._summarizeCandle(candle),
        points: result.points,
        boundaries,
      }, candle);
      return;
    }

    // WAITING_FOR_BOUNDARY_BREAK — boundaries are FIXED at Candle2.high/low
    // and monitored across as many future candles as needed (confirmed:
    // not only the immediate next candle). Last-touch-wins is intentionally
    // NOT re-applied here — the requirement only describes it for the
    // Candle1->Candle2 search stage.
    const boundaryResult = evaluateBoundaryBreak(candle, candidate.boundaries, candidate.direction);

    if (boundaryResult.outcome === 'WAIT') {
      this._emitDecision('WAIT', {
        reason: 'awaiting_boundary_break', direction: candidate.direction,
        activeLevel: this._activeLevelFor(candidate),
        candle1: this._summarizeCandle(candidate.candle1),
        candle2: this._summarizeCandle(candidate.candle2),
        candle3: this._summarizeCandle(candle),
        points: candidate.points,
        boundaries: candidate.boundaries,
      }, candle);
      return;
    }

    if (boundaryResult.outcome === 'INVALID') {
      this.patternCandidate = null;
      this._emitDecision('WAIT', {
        reason: candidate.direction === 'BUY' ? 'invalidated_close_below_lower_boundary' : 'invalidated_close_above_upper_boundary',
        direction: candidate.direction,
        activeLevel: this._activeLevelFor(candidate),
        candle1: this._summarizeCandle(candidate.candle1),
        candle2: this._summarizeCandle(candidate.candle2),
        candle3: this._summarizeCandle(candle),
        points: candidate.points,
        boundaries: candidate.boundaries,
      }, candle);
      return;
    }

    // boundaryResult.outcome === 'BUY' or 'SELL'
    if (candidate.isCalibrationPattern) {
      this._applyCalibration(candidate);
      this._emitDecision('WAIT', {
        reason: candidate.direction === 'SELL' ? 'r1_calibration_confirmed_no_trade' : 's1_calibration_confirmed_no_trade',
        direction: candidate.direction,
        activeLevel: this._activeLevelFor(candidate),
        candle1: this._summarizeCandle(candidate.candle1),
        candle2: this._summarizeCandle(candidate.candle2),
        candle3: this._summarizeCandle(candle),
        points: candidate.points,
        boundaries: candidate.boundaries,
      }, candle);
      this.patternCandidate = null;
      // Deliberately no same-candle fresh-touch re-check here — the
      // client-confirmed rule for this specific case is "strictly the next
      // candle," overriding the general same-candle reprocessing rule that
      // applies to ordinary failed-Candle-2 / INVALID resolutions.
      return;
    }

    await this._confirmAndSubmit(candidate, boundaryResult, candle);
  }

  /**
   * One-time R1/S1 calibration — never a trade. Mutates the FIRST element
   * of the relevant level array (index 0 = R1/S1) to this pattern's own
   * Candle 1 high/low, and marks that level's calibration flag done for
   * the rest of this running process. R2/R3/S2/S3 (indices 1/2) are never
   * touched — array positions are preserved, no reordering.
   */
  _applyCalibration(candidate) {
    if (candidate.direction === 'SELL') {
      this.params.resistance[0] = candidate.candle1.high;
      this.r1Calibrated = true;
    } else {
      this.params.support[0] = candidate.candle1.low;
      this.s1Calibrated = true;
    }
  }

  /**
   * Records that a configured Support/Resistance level was touched.
   *
   * LEVEL state only — it never touches `patternCandidate`, never changes
   * detection, validation, boundaries, SL, sizing or execution, and it is
   * never cleared here (not by a failed Candle 2, an invalidating Candle 3,
   * a rejected trade or a losing trade). Persistence is owned by
   * BotManager, which applies the emitted LEVEL_TOUCHED StrategyEvent to
   * this instance's own `parameters` — the same additive pattern already
   * used by ACTIVE_TIMEFRAME_SWITCHED.
   *
   * A BUY candidate is by definition a SUPPORT touch and a SELL candidate a
   * RESISTANCE touch, so the side is read from the caller's existing
   * direction rather than re-derived from OHLC (which could disagree with
   * MODEL_002's own touch rules).
   */
  _recordLevelTouch(direction, matchedLevel, candle) {
    const side = direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
    const key = side === 'SUPPORT' ? 'support' : 'resistance';
    const price = matchedLevel && Number.isFinite(matchedLevel.price) ? matchedLevel.price : null;
    const index = matchedLevel && Number.isFinite(matchedLevel.index) ? matchedLevel.index : null;
    const at = candle && Number.isFinite(candle.timestamp) ? candle.timestamp : null;

    if (!this.levelTouch) this.levelTouch = readLevelTouchState(null);
    const previous = this.levelTouch[key];
    const unchanged = previous.touched && previous.level === price && previous.index === index;

    this.levelTouch = Object.assign({}, this.levelTouch, {
      [key]: { touched: true, at, level: price, index },
    });

    // Hydration replay is silent by contract; and an unchanged latch needs
    // no second event/write.
    if (this._hydrating || unchanged) return;

    this.emitStrategyEvent('LEVEL_TOUCHED', {
      side, index, price, at, symbol: this.symbol, trend: this.params.trend,
      message: `${side === 'SUPPORT' ? 'Support' : 'Resistance'} level touched — remembered for this bot until its levels are changed.`,
    });
  }

  /**
   * FEATURE 1 — PREVIOUS CANDLE BODY REFERENCE LINE (visual only).
   *
   * For the NEW A/B/C engine, `candidate.candle1` IS candle A (the candle
   * immediately before the Support/Resistance touch candle B) and
   * `candidate.candle2` IS B. This exposes the exact price the EXISTING
   * A/B validation in reversalPatternEngine.validateAB() compares against,
   * so the user can see on the chart whether B's BODY crossed A's BODY
   * boundary:
   *
   *   BULLISH + SUPPORT    -> A_body_high = Math.max(A.open, A.close)
   *   BEARISH + RESISTANCE -> A_body_low  = Math.min(A.open, A.close)
   *
   * BODY values only — A.high / A.low (wicks) are never used.
   *
   * The OLD (opposite-side) engine gets the same line for the same reason:
   * its own EXISTING Candle 2 rule is candle2TouchesBodyHigh/Low(candle1,
   * candle2), i.e. it too compares against Candle 1's body boundary. Same
   * formula, same meaning, no new rule. Nothing here feeds back into
   * detection, validation or execution — it is a read-only projection of
   * state the engine already computed.
   */
  _bodyReferenceFor(candidate) {
    if (!candidate) return null;
    const a = candidate.candle1;
    const b = candidate.candle2;
    if (!a || !Number.isFinite(a.open) || !Number.isFinite(a.close)) return null;

    const isBuy = candidate.direction === 'BUY';
    return {
      direction: candidate.direction,
      engine: candidate.engine,
      side: isBuy ? 'BODY_HIGH' : 'BODY_LOW',
      price: isBuy ? Math.max(a.open, a.close) : Math.min(a.open, a.close),
      candleTimestamp: a.timestamp,
      fromTimestamp: a.timestamp,
      toTimestamp: b ? b.timestamp : null,
    };
  }

  /**
   * The C1/C2/C3 visual label group for a pattern candidate (see
   * utils/model002PatternVisual.js). Read-only: it reports roles the
   * pattern engine already assigned, and BUY/SELL wording only when this
   * class actually triggered the trade. Returns null for anything that is
   * not an active A/B/C pattern, which is exactly what tells the chart to
   * remove every label of the previous pattern.
   */
  _patternVisualFor(candidate, options) {
    const opts = options || {};
    // P4-H1 (reporting only): the evaluation candle's label index. Taken
    // from the caller when it knows it (the triggering candle), otherwise
    // from the candidate's own already-tracked evaluationIndex. Never
    // computed or incremented here, and nothing in the pattern engine
    // reads it back.
    const evaluationIndex = opts.evaluationIndex !== undefined
      ? opts.evaluationIndex
      : (candidate && candidate.evaluationIndex !== undefined ? candidate.evaluationIndex : undefined);
    return buildPatternVisual(candidate, Object.assign(
      { instanceId: this.instanceId },
      opts,
      { evaluationIndex }
    ));
  }

  _activeLevelFor(candidate) {
    return { side: candidate.direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE', index: candidate.matchedLevel.index, price: candidate.matchedLevel.price };
  }

  _summarizeCandle(candle) {
    if (!candle) return null;
    return { timestamp: candle.timestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
  }

  /** Entry/SL/riskLength/LOT pipeline for a resolved (BUY/SELL) pattern — see sameSidePatternEngine.js for every formula. */
  async _confirmAndSubmit(candidate, boundaryResult, entryCandle) {
    const direction = candidate.direction;
    const entryPrice = entryCandle.close;
    const stopLoss = direction === 'BUY' ? computeBuyStopLoss(candidate.candle1) : computeSellStopLoss(candidate.candle1);
    const riskLength = direction === 'BUY' ? computeBuyRiskLength(entryPrice, stopLoss) : computeSellRiskLength(entryPrice, stopLoss);

    if (!Number.isFinite(riskLength) || riskLength > 360 || riskLength < 0) {
      this._emitDecision('WAIT', {
        reason: 'risk_length_exceeds_maximum', direction, activeLevel: this._activeLevelFor(candidate),
        entryPrice, stopLoss, riskLength,
      }, entryCandle);
      return;
    }

    const lot = computeLotFromRiskLength(riskLength);
    if (!lot) {
      this._emitDecision('WAIT', { reason: 'lot_mapping_unavailable', direction, entryPrice, stopLoss, riskLength }, entryCandle);
      return;
    }

    // Maximum-capital x leverage notional cap removed (confirmed
    // requirement): quantity is no longer reduced, and trades are no
    // longer rejected, for that reason. The risk-based lot from
    // computeLotFromRiskLength is still converted from a lot COUNT to a
    // BTC quantity (confirmed project rule: 1 lot = 0.001 BTC) via
    // computeQuantityFromLot — that conversion is a unit conversion, not
    // a capital-based cap, and is unaffected by the cap removal above.
    const finalQuantity = computeQuantityFromLot(lot);
    logger.info('DIAG', `MODEL002 OLD-engine sizing for ${direction} ${this.symbol}`, {
      instanceId: this.instanceId, direction, entryPrice, stopLoss, riskLength,
      lot, lotSizeBtc: LOT_SIZE_BTC, quantity: finalQuantity,
      capital: this.capitalAllocation, riskPercent: this.params && this.params.riskPercent,
      leverage: this.leverage,
    });

    const ruleId = direction === 'BUY' ? RULE_ID_BUY : RULE_ID_SELL;
    const result = {
      direction, entryPrice, stopLoss, riskLength, lot, finalQuantity,
      maximumCapital: this.capitalAllocation, leverage: this.leverage,
      activeLevel: this._activeLevelFor(candidate), ruleId,
      candle1: this._summarizeCandle(candidate.candle1),
      candle2: this._summarizeCandle(candidate.candle2),
      candle3: this._summarizeCandle(entryCandle),
      boundaries: candidate.boundaries,
      points: candidate.points,
      bodyReference: this._bodyReferenceFor(candidate),
      patternVisual: this._patternVisualFor(candidate, { candle3: entryCandle, trigger: direction }),
      reason: `${direction} pattern confirmed`,
    };

    const command = this._buildEntryCommand(result, entryCandle);
    this._emitDecision(direction, result, entryCandle);
    this.patternCandidate = null;

    let approval;
    try {
      approval = await this.submitTradeCommand(command);
    } catch (err) {
      this.emitError(`submitTradeCommand threw unexpectedly: ${err.message}`, { commandId: command.commandId });
      return;
    }

    if (approval && approval.approved) {
      this.emitStrategyEvent('SIGNAL_GENERATED', { commandId: command.commandId, action: command.action, executed: Boolean(approval.execution) });
    } else {
      this.emitStrategyEvent('SIGNAL_REJECTED', { commandId: command.commandId, reason: (approval && approval.reason) || 'rejected' });
    }
  }

  // =========================================================================
  // NEW ENGINE (A/B/C wick-trigger spec) — same-side combinations only.
  // =========================================================================

  /**
   * Candle 3 (C) — the ONLY trigger candle for this pattern attempt (spec
   * §7-§10). Resolves immediately to BUY/SELL or INVALID; there is no WAIT
   * state here and, either way, the candidate is always cleared — a
   * genuinely fresh touch can only start on the NEXT candle (spec test
   * #12: restart never reuses old Candle1/Candle2, so this same candle C
   * is never re-checked as a new B here either).
   */
  async _advanceNewEngineCandidate(candleC) {
    const candidate = this.patternCandidate;
    const tieBreakSide = candidate.firstLiveBoundaryTouch;
    const boundaryResult = reversalEngine.evaluateCandle3(candleC, candidate.boundaries, candidate.direction, tieBreakSide);

    // "NO TRIGGER" IS NOT "INVALID" (confirmed correction). A candle that
    // touches neither boundary leaves the pattern fully active: the same
    // Candle 2 boundaries stay fixed, no new Candle 1/Candle 2 is created,
    // and the next candle is evaluated against those same boundaries.
    if (boundaryResult.outcome === 'WAIT') {
      const evaluationIndex = (candidate.evaluationIndex || 2) + 1; // C3, C4, C5, ...
      // Running wick extremes across B -> the eventual trigger candle. The
      // stop-loss rule is unchanged ("lowest wick from Candle 2 through the
      // trigger candle, minus 10"); this simply keeps the candles that are
      // now legitimately part of that window from being skipped.
      this.patternCandidate = Object.assign({}, candidate, {
        evaluationIndex,
        lowestLowSinceCandle2: Math.min(
          Number.isFinite(candidate.lowestLowSinceCandle2) ? candidate.lowestLowSinceCandle2 : candidate.candle2.low,
          candleC.low
        ),
        highestHighSinceCandle2: Math.max(
          Number.isFinite(candidate.highestHighSinceCandle2) ? candidate.highestHighSinceCandle2 : candidate.candle2.high,
          candleC.high
        ),
        // The live-tick tie-break belongs to the candle being evaluated, so
        // it is released once that candle resolves to WAIT.
        firstLiveBoundaryTouch: null,
      });
      this._emitDecision('WAIT', {
        reason: 'awaiting_boundary_touch', direction: candidate.direction,
        activeLevel: this._activeLevelFor(candidate),
        candle1: this._summarizeCandle(candidate.candle1),
        candle2: this._summarizeCandle(candidate.candle2),
        candle3: this._summarizeCandle(candleC),
        points: candidate.points, boundaries: candidate.boundaries,
        evaluationIndex,
      }, candleC);
      return;
    }

    if (boundaryResult.outcome === 'INVALID') {
      this.patternCandidate = null;
      const reason = boundaryResult.bothTouched
        ? (boundaryResult.tieBreakUsed ? 'invalidated_both_boundaries_tick_order' : 'invalidated_both_boundaries_no_tick_evidence')
        : 'invalidated_wrong_boundary_touched';
      this._emitDecision('WAIT', {
        reason, direction: candidate.direction,
        activeLevel: this._activeLevelFor(candidate),
        candle1: this._summarizeCandle(candidate.candle1),
        candle2: this._summarizeCandle(candidate.candle2),
        candle3: this._summarizeCandle(candleC),
        points: candidate.points, boundaries: candidate.boundaries,
      }, candleC);
      return;
    }

    await this._confirmAndSubmitNew(candidate, candleC);
  }

  /**
   * Live tie-break tracking for the "both boundaries touched within
   * Candle 3" case (spec §10) — reuses the EXISTING type:'price' tick
   * stream already dispatched by BotManager.dispatchMarketData to every
   * live instance on the symbol (no new Delta connection, no new
   * listener). Only matters while a NEW-engine candidate is primed for
   * Candle 3; records the FIRST boundary it sees a live price cross, then
   * ignores further ticks for that same candidate.
   */
  _trackLiveBoundaryTouch(marketUpdate) {
    const candidate = this.patternCandidate;
    if (!candidate || candidate.engine !== 'NEW' || candidate.stage !== 'AWAITING_CANDLE3') return;
    if (candidate.firstLiveBoundaryTouch) return;
    const price = marketUpdate.data && marketUpdate.data.price;
    if (typeof price !== 'number' || !Number.isFinite(price)) return;
    if (price >= candidate.boundaries.upper) candidate.firstLiveBoundaryTouch = 'upper';
    else if (price <= candidate.boundaries.lower) candidate.firstLiveBoundaryTouch = 'lower';
  }

  /**
   * NEW-engine entry/SL/riskLength/lot pipeline for a resolved BUY/SELL —
   * see reversalPatternEngine.js for the SL formula. Everything from
   * riskLength onward (>360 check, lot mapping, lot COUNT -> BTC quantity
   * conversion via computeQuantityFromLot at 1 lot = 0.001 BTC, no
   * capital x leverage cap, TradeCommand build/submit) is identical in
   * spirit to _confirmAndSubmit (OLD engine) — duplicated rather than
   * shared to avoid touching that already-tested path. The lot count is
   * NEVER used as a quantity directly (PHASE 1, approved).
   */
  async _confirmAndSubmitNew(candidate, candleC) {
    const direction = candidate.direction;
    // P4-H1 (reporting only): which evaluation candle actually triggered —
    // C3 if the very first candle after Candle 2 fired, otherwise C4, C5,
    // ... exactly as the WAIT branch already counts them. Used for the
    // label and the decision payload only; no trigger, boundary or
    // lifecycle behaviour depends on it.
    const evaluationIndex = (candidate.evaluationIndex || 2) + 1;
    // No candle close is required to trigger (spec §8/§14) — the fill
    // price used is the boundary level itself, the exact price the trade
    // triggers at, not Candle 3's eventual close (which the spec says is
    // irrelevant to the trigger).
    const entryPrice = direction === 'BUY' ? candidate.boundaries.upper : candidate.boundaries.lower;
    // Unchanged formula (reversalPatternEngine.computeBuy/SellStopLoss =
    // lowest low / highest high, minus / plus 10). The first argument now
    // carries the running wick extreme across Candle 2 and every candle
    // that WAITed after it, so the documented window "from Candle 2 through
    // the trigger candle" stays complete now that more than one candle can
    // sit inside it. With no waiting candles this is exactly Candle 2's own
    // high/low, i.e. byte-identical to the previous behaviour.
    const windowLow = Number.isFinite(candidate.lowestLowSinceCandle2) ? candidate.lowestLowSinceCandle2 : candidate.candle2.low;
    const windowHigh = Number.isFinite(candidate.highestHighSinceCandle2) ? candidate.highestHighSinceCandle2 : candidate.candle2.high;
    const stopLoss = direction === 'BUY'
      ? reversalEngine.computeBuyStopLoss({ low: windowLow }, candleC)
      : reversalEngine.computeSellStopLoss({ high: windowHigh }, candleC);
    const riskLength = direction === 'BUY' ? computeBuyRiskLength(entryPrice, stopLoss) : computeSellRiskLength(entryPrice, stopLoss);

    if (!Number.isFinite(riskLength) || riskLength > 360 || riskLength < 0) {
      this.patternCandidate = null;
      this._emitDecision('WAIT', {
        reason: 'risk_length_exceeds_maximum', direction, activeLevel: this._activeLevelFor(candidate),
        entryPrice, stopLoss, riskLength,
      }, candleC);
      return;
    }

    const lot = computeLotFromRiskLength(riskLength);
    if (!lot) {
      this.patternCandidate = null;
      this._emitDecision('WAIT', { reason: 'lot_mapping_unavailable', direction, entryPrice, stopLoss, riskLength }, candleC);
      return;
    }

    // Maximum-capital x leverage notional cap remains removed (unchanged
    // requirement) — quantity is the plain risk-based lot, converted from
    // lot COUNT to BTC quantity via computeQuantityFromLot (confirmed
    // project rule: 1 lot = 0.001 BTC). That unit conversion is separate
    // from, and unaffected by, the removed capital x leverage cap.
    const finalQuantity = computeQuantityFromLot(lot);
    logger.info('DIAG', `MODEL002 NEW-engine sizing for ${direction} ${this.symbol}`, {
      instanceId: this.instanceId, direction, entryPrice, stopLoss, riskLength,
      lot, lotSizeBtc: LOT_SIZE_BTC, quantity: finalQuantity,
      capital: this.capitalAllocation, riskPercent: this.params && this.params.riskPercent,
      leverage: this.leverage,
    });

    const ruleId = direction === 'BUY' ? RULE_ID_BUY : RULE_ID_SELL;
    const result = {
      direction, entryPrice, stopLoss, riskLength, lot, finalQuantity,
      maximumCapital: this.capitalAllocation, leverage: this.leverage,
      activeLevel: this._activeLevelFor(candidate), ruleId,
      candle1: this._summarizeCandle(candidate.candle1),
      candle2: this._summarizeCandle(candidate.candle2),
      candle3: this._summarizeCandle(candleC),
      boundaries: candidate.boundaries,
      points: candidate.points,
      bodyReference: this._bodyReferenceFor(candidate),
      evaluationIndex,
      patternVisual: this._patternVisualFor(candidate, { candle3: candleC, trigger: direction, evaluationIndex }),
      reason: `${direction} pattern confirmed`,
    };

    const command = this._buildEntryCommand(result, candleC);
    this._emitDecision(direction, result, candleC);
    this.patternCandidate = null;

    let approval;
    try {
      approval = await this.submitTradeCommand(command);
    } catch (err) {
      this.emitError(`submitTradeCommand threw unexpectedly: ${err.message}`, { commandId: command.commandId });
      return;
    }

    if (approval && approval.approved) {
      this.emitStrategyEvent('SIGNAL_GENERATED', { commandId: command.commandId, action: command.action, executed: Boolean(approval.execution) });
    } else {
      this.emitStrategyEvent('SIGNAL_REJECTED', { commandId: command.commandId, reason: (approval && approval.reason) || 'rejected' });
    }
  }

  _buildEntryCommand(result, candle) {
    const commandId = `MODEL002:${this.instanceId}:${candle.timestamp}:${result.direction}:${result.ruleId}`;
    return {
      commandId,
      instanceId: this.instanceId,
      symbol: this.symbol,
      environment: this.environment,
      action: result.direction === 'BUY' ? 'LONG' : 'SHORT',
      quantity: result.finalQuantity,
      stopLoss: result.stopLoss,
      takeProfit: null, // no TP formula specified for the same-side pattern — never invented
      reason: result.reason,
      metadata: {
        ruleId: result.ruleId,
        timeframe: this.params.timeframe,
        activeLevel: result.activeLevel,
        riskLength: result.riskLength,
        lot: result.lot,
        finalQuantity: result.finalQuantity,
        maximumCapital: result.maximumCapital,
        leverage: result.leverage,
      },
    };
  }

  _emitDecision(decisionLabel, result, candle) {
    const points = result.points || null;
    this.emitStrategyEvent('DECISION', {
      symbol: this.symbol,
      timeframe: this.params.timeframe,
      candleTimestamp: candle.timestamp,
      decision: decisionLabel,
      reason: result.reason || null,
      ruleId: result.ruleId || null,
      trend: this.params.trend,
      activeSupportLevels: this.params.support,
      activeResistanceLevels: this.params.resistance,
      activeLevel: result.activeLevel !== undefined ? result.activeLevel : null,
      // Same-side pattern state — every field here is either the real
      // candle the pattern engine captured or a value it actually
      // computed. boundaries are fixed at Candle2.high/low the moment
      // Candle 2 validates and stay unchanged until BUY/SELL/INVALID.
      candle1: result.candle1 || null,
      candle2: result.candle2 || null,
      candle3: result.candle3 || null,
      // FEATURE 1 — visual-only helper line data (candle A's BODY high/low).
      // Present only while a NEW-engine A/B pattern is actually active;
      // absent (null) on every other decision, which is what tells the
      // chart to remove the line. Never read back by the strategy.
      bodyReference: result.bodyReference || this._bodyReferenceFor(this.patternCandidate) || null,
      // Which evaluation candle this is: 3 for the first candle after
      // Candle 2, then 4, 5, ... while the pattern waits inside its fixed
      // boundaries. Reporting only — nothing branches on it.
      evaluationIndex: result.evaluationIndex !== undefined ? result.evaluationIndex : null,
      // C1/C2/C3 label group for the chart. `result.patternVisual` is set
      // by the decision that produced it (a fresh A/B pattern, or the
      // trade-triggering C); otherwise it is rebuilt from the candidate
      // that is STILL active, so unrelated WAIT decisions (safety pause,
      // position already open) do not make the labels flicker away. It is
      // null whenever no A/B/C pattern is active — including immediately
      // after an invalidation, since Model002 clears patternCandidate
      // before emitting that decision — and null is what removes the
      // labels. Purely presentational; never read back by the strategy.
      patternVisual: result.patternVisual || this._patternVisualFor(this.patternCandidate, { candle3: result.candle3 }) || null,
      upperBoundary: result.boundaries ? result.boundaries.upper : null,
      lowerBoundary: result.boundaries ? result.boundaries.lower : null,
      upperP: points ? points.upperP : null,
      lowerP: points ? points.lowerP : null,
      body: points ? points.body : null,
      bodyP: points ? points.bodyP : null,
      bodyPIsMaximum: points ? (points.bodyP >= points.upperP && points.bodyP >= points.lowerP) : null,
      candleNature: result.candle2 ? (result.candle2.close > result.candle2.open ? 'BULLISH' : 'BEARISH') : null,
      entryPrice: result.entryPrice !== undefined ? result.entryPrice : null,
      stopLoss: result.stopLoss !== undefined ? result.stopLoss : null,
      riskLength: result.riskLength !== undefined ? result.riskLength : null,
      lot: result.lot !== undefined ? result.lot : null,
      takeProfit: null, // no TP formula specified for the same-side pattern
      finalQuantity: result.finalQuantity !== undefined ? result.finalQuantity : null,
      finalNotional: result.finalNotional !== undefined ? result.finalNotional : null,
      maximumCapital: this.capitalAllocation,
      leverage: this.leverage,
      maximumAllowedNotional: this.capitalAllocation * this.leverage,
      maxCapitalCapped: result.maxCapitalCapped !== undefined ? result.maxCapitalCapped : null,
      consecutiveLosses: this.safety.getState().consecutiveLosses,
      safetyLimit: this.safety.getState().limit,
      safetyStatus: this.safety.getState().paused ? 'PAUSED' : (this.safety.getState().consecutiveLosses > 0 ? 'WARNING' : 'NORMAL'),
      // PHASE 2 — layer/success safety state, nested (not flattened into
      // the existing `safetyStatus` key above) to avoid colliding with the
      // pre-existing 3-consecutive-loss telemetry field of the same name;
      // the two trackers are independent (see layerSafety.js).
      layerSafety: this.layerSafety.getState(),
      // Shaped for public/js/renderers/model-thinking-registry.js's MODEL_002
      // renderer (Bot Detail "Decision Engine" panel). Every value here is
      // taken directly from what this decision actually computed above —
      // trend is the user-provided configuration (never BOS/EMA), touch/
      // level/candle/point values come straight from the real pattern
      // engine. Nothing here is fabricated.
      checks: Object.assign({
        trend: { status: this.params.trend },
        // LEVEL STATE (persistent latch) — deliberately NOT derived from
        // this decision's `activeLevel`. `activeLevel` is null whenever no
        // pattern is active (e.g. reason `no_level_touch`), which is
        // exactly what used to flip these rows back to NOT_TOUCHED after a
        // failed pattern. The latch below only ever goes false -> true, and
        // is cleared solely by the existing trend/levels edit lifecycle.
        // PATTERN STATE stays a separate field (`patternState`) below.
      }, toChecksLevelStatus(this.levelTouch), {
        activeLevel: result.activeLevel !== undefined ? result.activeLevel : null,
        bodyReference: result.bodyReference || this._bodyReferenceFor(this.patternCandidate) || null,
        patternVisual: result.patternVisual || this._patternVisualFor(this.patternCandidate, { candle3: result.candle3 }) || null,
        candle1: result.candle1 || null,
        candle2: result.candle2 || null,
        candle3: result.candle3 || null,
        boundaries: result.boundaries || null,
        points: points,
        bodyPIsMaximum: points ? (points.bodyP >= points.upperP && points.bodyP >= points.lowerP) : null,
        patternState: this.patternCandidate ? this.patternCandidate.stage : (decisionLabel === 'BUY' || decisionLabel === 'SELL' ? 'TRADE_CONFIRMED' : 'IDLE'),
        // P4-H1 — which evaluation candle `candle3` is (3, 4, 5, ...). The
        // same value already present at the top level of this payload,
        // mirrored into `checks` so the Decision Engine panel and the chart
        // read one identical source. Reporting only.
        evaluationIndex: result.evaluationIndex !== undefined
          ? result.evaluationIndex
          : (this.patternCandidate && this.patternCandidate.evaluationIndex !== undefined
            ? this.patternCandidate.evaluationIndex
            : null),
        // P4-H2 — PHASE 2 layer/success safety state, mirrored from the
        // top-level `layerSafety` key so the UI can show a stopped bot as
        // stopped. Read-only copy of LayerSafety.getState(); the state
        // machine itself is untouched and nothing reads this back.
        layerSafety: this.layerSafety.getState(),
        entryPrice: result.entryPrice !== undefined ? result.entryPrice : null,
        stopLoss: result.stopLoss !== undefined ? result.stopLoss : null,
        riskLength: result.riskLength !== undefined ? result.riskLength : null,
        lot: result.lot !== undefined ? result.lot : null,
      }),
    });
  }

  // --- internal buffer helpers -----------------------------------------

  _appendAndTrim(buffer, candle, maxLen) {
    const next = buffer.concat([candle]);
    if (!maxLen || next.length <= maxLen) return next;
    return next.slice(next.length - maxLen);
  }

  _mergeHydratedCandles(existing, closedCandles, maxLen) {
    if (!Array.isArray(closedCandles) || !closedCandles.length) return existing;
    const valid = closedCandles
      .filter((c) => validateCandle(c))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (!valid.length) return existing;
    const merged = existing.concat(valid);
    return maxLen ? merged.slice(-maxLen) : merged;
  }
}

module.exports = Model002;
