'use strict';

/**
 * MODEL_002 — 3-consecutive-losses safety rule (confirmed requirement).
 *
 * Classification (confirmed):
 *   realizedPnl > 0  -> WIN         -> resets streak to 0
 *   realizedPnl < 0  -> LOSS        -> increments streak; streak >= limit -> paused
 *   realizedPnl == 0 -> BREAK_EVEN  -> resets streak to 0 (does not count as a loss;
 *                                      confirmed recommended behavior — see final report)
 *
 * Deduplication: every processed outcome must carry a unique `tradeId`
 * (Trade._id in production). The same tradeId is never counted twice,
 * regardless of how many times recordTradeOutcome is called with it —
 * this is the primary safety net against double-counting; BotManager's
 * own open->closed transition detection is the other (see BotManager.js
 * dispatchMarketData).
 */
class ConsecutiveLossSafety {
  constructor(limit = 3, initialState) {
    this.limit = limit;
    this.consecutiveLosses = (initialState && initialState.consecutiveLosses) || 0;
    this.paused = Boolean(initialState && initialState.paused);
    this.processedTradeIds = new Set();
  }

  /**
   * @param {string} tradeId unique identifier of the closed trade (Trade._id)
   * @param {number} realizedPnl the trade's actual realized PnL
   * @returns {{outcome:'WIN'|'LOSS'|'BREAK_EVEN'|null, state:object, duplicate:boolean}}
   */
  recordTradeOutcome(tradeId, realizedPnl) {
    const key = String(tradeId);
    if (this.processedTradeIds.has(key)) {
      return { outcome: null, state: this.getState(), duplicate: true };
    }
    this.processedTradeIds.add(key);

    let outcome;
    if (realizedPnl > 0) {
      outcome = 'WIN';
      this.consecutiveLosses = 0;
    } else if (realizedPnl < 0) {
      outcome = 'LOSS';
      this.consecutiveLosses += 1;
      if (this.consecutiveLosses >= this.limit) this.paused = true;
    } else {
      outcome = 'BREAK_EVEN';
      this.consecutiveLosses = 0;
    }

    return { outcome, state: this.getState(), duplicate: false };
  }

  getState() {
    return { consecutiveLosses: this.consecutiveLosses, paused: this.paused, limit: this.limit };
  }

  /**
   * Restores state after a restart — reconstructed from authoritative
   * Trade history by BotManager._recoverSafetyState. Critically, this
   * also SEEDS `processedTradeIds` with `state.processedTradeIds` (the
   * exact trade ids that produced the reconstructed count) — without
   * this, a restart would recover the correct COUNT but forget which
   * specific trades produced it, so a redelivered/replayed
   * onPositionClosed for one of those same, already-counted trades would
   * double-count it. Seeding closes that gap: the same Trade `_id` can
   * never be counted twice, restart or not.
   */
  restoreState(state) {
    if (!state) return;
    if (Number.isFinite(state.consecutiveLosses)) this.consecutiveLosses = state.consecutiveLosses;
    if (typeof state.paused === 'boolean') this.paused = state.paused;
    if (Array.isArray(state.processedTradeIds)) {
      for (const id of state.processedTradeIds) this.processedTradeIds.add(String(id));
    }
  }
}

module.exports = { ConsecutiveLossSafety };
