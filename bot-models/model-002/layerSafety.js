'use strict';

const { MAX_LAYERS, MAX_LOSSES_PER_LAYER, MAX_SUCCESSFUL_TRADES_PER_BOT } = require('./config');

/**
 * MODEL_002 — PHASE 2 layer/success safety state machine (confirmed
 * requirements):
 *
 *   1. Maximum 2 losing trades per layer (MAX_LOSSES_PER_LAYER).
 *   2. Maximum 6 layers (MAX_LAYERS) — layer 7 must never be created.
 *   3. Maximum 1 successful/winning trade per bot (MAX_SUCCESSFUL_TRADES_PER_BOT).
 *
 * This is entirely independent of ConsecutiveLossSafety (safetyState.js,
 * the pre-existing 3-consecutive-losses-pauses-the-bot rule) — both can be
 * active on the same bot at once and neither reads the other's state.
 *
 * Only an ACTUALLY EXECUTED AND CLOSED trade advances this state machine.
 * A RiskEngine rejection is never seen here at all (see Model002.js —
 * this class is only ever driven by onPositionClosed, which only fires
 * for a real closed Position/Trade — a rejected TradeCommand never
 * reaches that far). realizedPnl === 0 (BREAK_EVEN) is deliberately
 * treated as neither a loss nor a win — the confirmed requirement only
 * defines "loss" (closed trade, negative realizedPnl) and "success"
 * (closed trade, positive realizedPnl); a flat close matches neither
 * definition, so it does not advance the layer and does not consume the
 * one-time success allowance. This mirrors the existing
 * ConsecutiveLossSafety convention for the same realizedPnl === 0 case.
 *
 * Whether a success would reset an in-progress layer/loss-count is
 * explicitly UNDEFINED by the confirmed requirements — and deliberately
 * left unimplemented rather than guessed (see PHASE 2 report). It is also
 * operationally moot: SUCCESS_STOPPED halts all further trading for the
 * bot forever, so no code path can ever observe what the layer/loss count
 * "would have been" after a success.
 */
class LayerSafety {
  constructor(initialState) {
    this.currentLayer = (initialState && Number.isFinite(initialState.currentLayer)) ? initialState.currentLayer : 1;
    this.layerLossCount = (initialState && Number.isFinite(initialState.layerLossCount)) ? initialState.layerLossCount : 0;
    this.successfulTradeCount = (initialState && Number.isFinite(initialState.successfulTradeCount)) ? initialState.successfulTradeCount : 0;
    this.safetyStatus = (initialState && initialState.safetyStatus) || 'NORMAL'; // 'NORMAL' | 'MAX_LAYER_STOPPED' | 'SUCCESS_STOPPED'
    this.processedTradeIds = new Set(
      (initialState && Array.isArray(initialState.processedTradeIds)) ? initialState.processedTradeIds.map(String) : []
    );
  }

  /**
   * @param {string} tradeId unique identifier of the closed trade (Trade._id)
   * @param {number} realizedPnl the trade's actual realized PnL
   * @returns {{outcome:'WIN'|'LOSS'|'BREAK_EVEN'|null, state:object, duplicate:boolean, transition:string|null}}
   *   transition is one of: null (no layer/status change), 'LOSS_RECORDED',
   *   'LAYER_ADVANCED', 'MAX_LAYER_STOPPED', 'SUCCESS_STOPPED' — for callers
   *   that want to emit a specific telemetry event only on an actual change.
   */
  recordTradeOutcome(tradeId, realizedPnl) {
    const key = String(tradeId);
    if (this.processedTradeIds.has(key)) {
      return { outcome: null, state: this.getState(), duplicate: true, transition: null };
    }
    this.processedTradeIds.add(key);

    // Once stopped, state is frozen — this bot will never submit another
    // TradeCommand (see the onMarketData gate in Model002.js), so no
    // further outcome should legally reach here. Recorded defensively
    // (dedup still applies) but never mutates currentLayer/layerLossCount/
    // successfulTradeCount past a stop.
    if (this.safetyStatus !== 'NORMAL') {
      const outcome = realizedPnl > 0 ? 'WIN' : realizedPnl < 0 ? 'LOSS' : 'BREAK_EVEN';
      return { outcome, state: this.getState(), duplicate: false, transition: null };
    }

    let outcome;
    let transition = null;

    if (realizedPnl > 0) {
      outcome = 'WIN';
      this.successfulTradeCount += 1; // confirmed cap is 1; a second WIN can never reach here (SUCCESS_STOPPED already blocks new trades)
      if (this.successfulTradeCount >= MAX_SUCCESSFUL_TRADES_PER_BOT) {
        this.safetyStatus = 'SUCCESS_STOPPED';
        transition = 'SUCCESS_STOPPED';
      }
    } else if (realizedPnl < 0) {
      outcome = 'LOSS';
      this.layerLossCount += 1;
      transition = 'LOSS_RECORDED';
      if (this.layerLossCount >= MAX_LOSSES_PER_LAYER) {
        if (this.currentLayer >= MAX_LAYERS) {
          // Layer 6's 2nd loss — STOP. Layer 7 must never be created.
          this.safetyStatus = 'MAX_LAYER_STOPPED';
          transition = 'MAX_LAYER_STOPPED';
        } else {
          this.currentLayer += 1;
          this.layerLossCount = 0;
          transition = 'LAYER_ADVANCED';
        }
      }
    } else {
      outcome = 'BREAK_EVEN'; // neither a loss nor a success — no state change (see class doc)
    }

    return { outcome, state: this.getState(), duplicate: false, transition };
  }

  getState() {
    return {
      currentLayer: this.currentLayer,
      layerLossCount: this.layerLossCount,
      successfulTradeCount: this.successfulTradeCount,
      safetyStatus: this.safetyStatus,
    };
  }

  /** Restores state after a restart — see BotManager._recoverLayerSafetyState. */
  restoreState(state) {
    if (!state) return;
    if (Number.isFinite(state.currentLayer)) this.currentLayer = state.currentLayer;
    if (Number.isFinite(state.layerLossCount)) this.layerLossCount = state.layerLossCount;
    if (Number.isFinite(state.successfulTradeCount)) this.successfulTradeCount = state.successfulTradeCount;
    if (typeof state.safetyStatus === 'string') this.safetyStatus = state.safetyStatus;
    if (Array.isArray(state.processedTradeIds)) {
      for (const id of state.processedTradeIds) this.processedTradeIds.add(String(id));
    }
  }
}

module.exports = { LayerSafety, MAX_LAYERS, MAX_LOSSES_PER_LAYER, MAX_SUCCESSFUL_TRADES_PER_BOT };
