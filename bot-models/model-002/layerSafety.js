'use strict';

const { MAX_LOSSES_PER_LEVEL, MAX_SUCCESSFUL_TRADES_PER_BOT } = require('./config');

/**
 * MODEL_002 level-based trade safety.
 *
 * Each configured Support/Resistance level has its own loss counter:
 *   S1, S2, S3, R1, R2, R3
 *
 * A trade is assigned permanently to the level that created its entry.
 * T1/T2/T3 partial exits do not create Trade records and therefore never
 * change these counters. The final position close is the only result event:
 *   - reason TARGET_4 => SUCCESS and stop the bot (even if cumulative PnL is not positive)
 *   - reason STOP_LOSS => +1 loss on the entry level
 *   - other final closes fall back to realizedPnl classification
 *   - zero => no change
 *
 * A level is blocked once its loss counter reaches 2. Other levels remain
 * eligible. The bot stops permanently after its first successful trade.
 */
class LayerSafety {
  constructor(initialState) {
    this.levelLosses = { S1: 0, S2: 0, S3: 0, R1: 0, R2: 0, R3: 0 };
    if (initialState && initialState.levelLosses && typeof initialState.levelLosses === 'object') {
      for (const key of Object.keys(this.levelLosses)) {
        const n = Number(initialState.levelLosses[key]);
        if (Number.isFinite(n) && n >= 0) this.levelLosses[key] = Math.floor(n);
      }
    }
    this.successfulTradeCount = Number.isFinite(initialState?.successfulTradeCount) ? initialState.successfulTradeCount : 0;
    this.safetyStatus = initialState?.safetyStatus || 'NORMAL';
    this.processedTradeIds = new Set(
      Array.isArray(initialState?.processedTradeIds) ? initialState.processedTradeIds.map(String) : []
    );
  }

  static normalizeLevelKey(entryLevel) {
    if (typeof entryLevel === 'string') {
      const key = entryLevel.toUpperCase();
      return Object.prototype.hasOwnProperty.call({ S1:1,S2:1,S3:1,R1:1,R2:1,R3:1 }, key) ? key : null;
    }
    if (!entryLevel || typeof entryLevel !== 'object') return null;
    const side = String(entryLevel.side || '').toUpperCase();
    const index = Number(entryLevel.index);
    if (!['SUPPORT','RESISTANCE'].includes(side) || !Number.isInteger(index) || index < 0 || index > 2) return null;
    return `${side === 'SUPPORT' ? 'S' : 'R'}${index + 1}`;
  }

  canOpenLevel(entryLevel) {
    if (this.safetyStatus !== 'NORMAL') return false;
    const key = LayerSafety.normalizeLevelKey(entryLevel);
    if (!key) return false;
    return this.levelLosses[key] < MAX_LOSSES_PER_LEVEL;
  }

  recordTradeOutcome(tradeId, realizedPnl, entryLevel, closeReason = null) {
    const key = String(tradeId);
    if (this.processedTradeIds.has(key)) {
      return { outcome: null, state: this.getState(), duplicate: true, transition: null, entryLevelKey: null };
    }
    this.processedTradeIds.add(key);

    const levelKey = LayerSafety.normalizeLevelKey(entryLevel);
    let outcome;
    let transition = null;
    const forcedSuccess = String(closeReason || '').toUpperCase() === 'TARGET_4';
    const forcedLoss = String(closeReason || '').toUpperCase() === 'STOP_LOSS';

    if (forcedSuccess || (!forcedLoss && realizedPnl > 0)) {
      outcome = 'WIN';
      this.successfulTradeCount += 1;
      this.safetyStatus = 'SUCCESS_STOPPED';
      transition = 'SUCCESS_STOPPED';
    } else if (forcedLoss || realizedPnl < 0) {
      outcome = 'LOSS';
      if (levelKey) {
        this.levelLosses[levelKey] += 1;
        transition = this.levelLosses[levelKey] >= MAX_LOSSES_PER_LEVEL
          ? 'LEVEL_BLOCKED'
          : 'LOSS_RECORDED';
      } else {
        transition = 'LOSS_UNATTRIBUTED';
      }
    } else {
      outcome = 'BREAK_EVEN';
      transition = null;
    }

    return { outcome, state: this.getState(), duplicate: false, transition, entryLevelKey: levelKey };
  }

  getState() {
    return {
      levelLosses: { ...this.levelLosses },
      successfulTradeCount: this.successfulTradeCount,
      safetyStatus: this.safetyStatus,
      maxLossesPerLevel: MAX_LOSSES_PER_LEVEL,
      maxSuccessfulTradesPerBot: MAX_SUCCESSFUL_TRADES_PER_BOT,
    };
  }

  restoreState(state) {
    if (!state) return;
    if (state.levelLosses && typeof state.levelLosses === 'object') {
      for (const key of Object.keys(this.levelLosses)) {
        const n = Number(state.levelLosses[key]);
        if (Number.isFinite(n) && n >= 0) this.levelLosses[key] = Math.floor(n);
      }
    }
    if (Number.isFinite(state.successfulTradeCount)) this.successfulTradeCount = state.successfulTradeCount;
    if (typeof state.safetyStatus === 'string') this.safetyStatus = state.safetyStatus;
    if (Array.isArray(state.processedTradeIds)) {
      for (const id of state.processedTradeIds) this.processedTradeIds.add(String(id));
    }
  }
}

module.exports = { LayerSafety, MAX_LOSSES_PER_LEVEL, MAX_SUCCESSFUL_TRADES_PER_BOT };
