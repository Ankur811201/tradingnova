'use strict';

const BotModelBase = require('../BotModelBase');
const { validateCandle, validateAndMergeParameters } = require('./validators');
const { resolveTouchedLevel } = require('./levelEngine');
const { evaluateCounterTrendBuy, evaluateCounterTrendSell } = require('./patternEngine');
const {
  computeStopLoss, validateSlDistance, computeQuantity, computeTakeProfit, capExposureToMaxNotional,
} = require('./riskSizing');
const { ConsecutiveLossSafety } = require('./safetyState');

const RULE_ID_COUNTER_BUY = 'MODEL_002_COUNTER_TREND_BUY';
const RULE_ID_COUNTER_SELL = 'MODEL_002_COUNTER_TREND_SELL';

const LEVERAGE_MIN = 1;
const LEVERAGE_MAX = 200;

/**
 * MODEL_002 — client-driven custom-pattern trading model.
 *
 * This revision fixes 3 confirmed issues on top of the prior custom-
 * pattern implementation (unchanged strategy rules — see patternEngine.js/
 * levelEngine.js, not touched here):
 *
 *   1. Max Capital x Leverage notional ceiling (was: max capital alone).
 *   2. Real WIN/LOSS detection from the authoritative Trade record via a
 *      new, additive BotManager hook (was: a next-candle-close heuristic).
 *   3. Consecutive-loss safety state persisted across restart by
 *      reconstructing it from Trade history (was: in-memory only).
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
    // Leverage: used ONLY for the max-notional ceiling (maxCapital x leverage) below.
    // Never used for anything else, never reduced, never overridden — passed straight
    // through to the existing RiskEngine/ExecutionRouter pipeline via TradeCommand.
    this.leverage = instanceConfig.leverage;
    this.riskSettings = instanceConfig.riskSettings || {};

    this.candles = [];
    this.lastProcessedTs = null;

    // Confirmed — 3 consecutive losses pauses the bot. Real state, driven
    // exclusively by onPositionClosed() below (authoritative Trade
    // records), never by candle-close inference.
    this.safety = new ConsecutiveLossSafety(this.params.consecutiveLossLimit);

    this.paused = false;
    this.stopped = false;

    this.emitStrategyEvent('MODEL_STARTED', {
      symbol: this.symbol,
      environment: this.environment,
      timeframe: this.params.timeframe,
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
    this.emitStrategyEvent('MODEL_HYDRATED', {
      symbol: this.symbol, timeframe: this.params.timeframe,
      candlesLoaded: this.candles.length, required: this.params.historySize,
    });
  }

  /** Inert no-op — MODEL_002 declares no requiredTimeframes. Kept so shared Part A infra stays intact for other models. */
  async onHydrateTimeframe(_timeframe, _closedCandles) {}

  getReadiness() {
    const have = this.candles.length;
    const required = this.params.historySize;
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

  // --- Live market data --------------------------------------------------

  async onMarketData(marketUpdate, positionContext) {
    if (this.paused || this.stopped) return;
    if (!marketUpdate || marketUpdate.symbol !== this.symbol) return;
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

  async _evaluateEntry(confirmationCandle) {
    const len = this.candles.length;
    const touchCandle = this.candles[len - 2];
    const referenceCandleL1 = len >= 3 ? this.candles[len - 3] : null;

    const trend = this.params.trend;
    const result = trend === 'BULLISH'
      ? this._evaluateBullish(touchCandle, referenceCandleL1, confirmationCandle)
      : this._evaluateBearish(touchCandle, referenceCandleL1, confirmationCandle);

    if (!result.actionable) {
      this._emitDecision('WAIT', result, confirmationCandle);
      return;
    }

    const command = this._buildEntryCommand(result, confirmationCandle);
    this._emitDecision(result.direction === 'LONG' ? 'BUY' : 'SELL', result, confirmationCandle);

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

  /** BULLISH trend: RESISTANCE = implemented counter-trend SELL; SUPPORT = pending direct BUY (never trades). */
  _evaluateBullish(touchCandle, referenceCandleL1, confirmationCandle) {
    const resistanceMatch = resolveTouchedLevel(this.params.resistance, touchCandle, this.params.touchTolerancePct);
    if (resistanceMatch) {
      return this._evaluateCounterTrend('SHORT', resistanceMatch, referenceCandleL1, touchCandle, confirmationCandle);
    }
    const supportMatch = resolveTouchedLevel(this.params.support, touchCandle, this.params.touchTolerancePct);
    if (supportMatch) {
      return this._pendingDirectEntry('LONG', supportMatch);
    }
    return this._noTouch();
  }

  /** BEARISH trend: SUPPORT = implemented counter-trend BUY; RESISTANCE = pending direct SELL (never trades). */
  _evaluateBearish(touchCandle, referenceCandleL1, confirmationCandle) {
    const supportMatch = resolveTouchedLevel(this.params.support, touchCandle, this.params.touchTolerancePct);
    if (supportMatch) {
      return this._evaluateCounterTrend('LONG', supportMatch, referenceCandleL1, touchCandle, confirmationCandle);
    }
    const resistanceMatch = resolveTouchedLevel(this.params.resistance, touchCandle, this.params.touchTolerancePct);
    if (resistanceMatch) {
      return this._pendingDirectEntry('SHORT', resistanceMatch);
    }
    return this._noTouch();
  }

  _noTouch() {
    return { actionable: false, reason: 'no_level_touch', activeLevel: null };
  }

  _pendingDirectEntry(direction, matchedLevel) {
    return {
      actionable: false,
      reason: 'direct_entry_pending_client_confirmation',
      direction,
      activeLevel: { side: direction === 'LONG' ? 'SUPPORT' : 'RESISTANCE', index: matchedLevel.index, price: matchedLevel.price },
    };
  }

  /** Confirmed counter-trend formula for either direction, then SL/quantity/TP/max-capital-x-leverage pipeline. */
  _evaluateCounterTrend(direction, matchedLevel, referenceCandleL1, touchCandle, confirmationCandle) {
    const usesLevel1Reference = matchedLevel.index === 1;
    const referenceCandle = usesLevel1Reference ? referenceCandleL1 : touchCandle;

    if (usesLevel1Reference && !referenceCandle) {
      return { actionable: false, reason: 'insufficient_history_for_level1_reference', direction, activeLevel: { index: matchedLevel.index, price: matchedLevel.price } };
    }

    const confirmation = direction === 'LONG'
      ? evaluateCounterTrendBuy(matchedLevel.index, referenceCandle, confirmationCandle)
      : evaluateCounterTrendSell(matchedLevel.index, referenceCandle, confirmationCandle);

    const activeLevel = { side: direction === 'LONG' ? 'SUPPORT' : 'RESISTANCE', index: matchedLevel.index, price: matchedLevel.price };

    if (!confirmation.passed) {
      return { actionable: false, reason: 'body_confirmation_failed', direction, activeLevel, confirmation };
    }

    const entryPrice = confirmationCandle.close;
    const stopLoss = computeStopLoss(direction, matchedLevel.price, this.params.slBufferPct);
    const slCheck = validateSlDistance(entryPrice, stopLoss, this.params.slMinDistancePct, this.params.slMaxDistancePct);
    if (!slCheck.valid) {
      return { actionable: false, reason: 'sl_distance_invalid', direction, activeLevel, confirmation, entryPrice, stopLoss, stopLossDistance: slCheck.riskDistance };
    }

    const riskSized = computeQuantity(this.capitalAllocation, this.params.riskPercent, entryPrice, stopLoss, this.params.quantityDecimalPrecision);
    if (!riskSized.quantity || riskSized.quantity <= 0) {
      return { actionable: false, reason: 'quantity_below_minimum', direction, activeLevel, confirmation, entryPrice, stopLoss, stopLossDistance: slCheck.riskDistance };
    }

    // Confirmed §1/§1.2 fix: cap to maximumCapital x leverage, not maximumCapital alone.
    const capped = capExposureToMaxNotional(riskSized.quantity, entryPrice, this.capitalAllocation, this.leverage, this.params.quantityDecimalPrecision);
    if (!capped.quantity || capped.quantity <= 0) {
      return {
        actionable: false, reason: 'maximum_capital_leverage_limit', direction, activeLevel, confirmation,
        entryPrice, stopLoss, stopLossDistance: slCheck.riskDistance,
        maximumCapital: this.capitalAllocation, leverage: this.leverage, maximumAllowedNotional: capped.maximumAllowedNotional,
      };
    }

    const takeProfit = computeTakeProfit(direction, entryPrice, stopLoss, this.params.riskRewardRatio);
    const ruleId = direction === 'LONG' ? RULE_ID_COUNTER_BUY : RULE_ID_COUNTER_SELL;

    return {
      actionable: true, direction, activeLevel, confirmation,
      entryPrice, stopLoss, takeProfit,
      stopLossDistance: slCheck.riskDistance,
      riskAmount: riskSized.riskAmountUsd,
      calculatedQuantity: riskSized.quantity,
      finalQuantity: capped.quantity,
      finalNotional: capped.notional,
      maximumCapital: this.capitalAllocation,
      leverage: this.leverage,
      maximumAllowedNotional: capped.maximumAllowedNotional,
      maxCapitalCapped: capped.capped,
      ruleId,
      reason: 'Counter-trend entry conditions satisfied',
    };
  }

  _buildEntryCommand(result, candle) {
    const commandId = `MODEL002:${this.instanceId}:${candle.timestamp}:${result.direction}:${result.ruleId}`;
    return {
      commandId,
      instanceId: this.instanceId,
      symbol: this.symbol,
      environment: this.environment,
      action: result.direction,
      quantity: result.finalQuantity,
      stopLoss: result.stopLoss,
      takeProfit: result.takeProfit,
      reason: result.reason,
      metadata: {
        ruleId: result.ruleId,
        timeframe: this.params.timeframe,
        activeLevel: result.activeLevel,
        riskAmount: result.riskAmount,
        stopLossDistance: result.stopLossDistance,
        calculatedQuantity: result.calculatedQuantity,
        finalQuantity: result.finalQuantity,
        finalNotional: result.finalNotional,
        maximumCapital: result.maximumCapital,
        leverage: result.leverage,
        maximumAllowedNotional: result.maximumAllowedNotional,
        maxCapitalCapped: result.maxCapitalCapped,
      },
    };
  }

  _emitDecision(decisionLabel, result, candle) {
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
      patternStatus: result.confirmation
        ? {
          closeCheckPassed: result.confirmation.closeAboveRefBodyHigh !== undefined ? result.confirmation.closeAboveRefBodyHigh : result.confirmation.closeBelowRefBodyLow,
          bodyRulePassed: result.confirmation.bodyRulePassed,
        }
        : null,
      referenceBodySize: result.confirmation ? result.confirmation.referenceBodySize : null,
      confirmationBodySize: result.confirmation ? result.confirmation.confirmationBodySize : null,
      bodyRuleMultiplierRequired: 1.5,
      entryPrice: result.entryPrice !== undefined ? result.entryPrice : null,
      stopLoss: result.stopLoss !== undefined ? result.stopLoss : null,
      stopLossDistance: result.stopLossDistance !== undefined ? result.stopLossDistance : null,
      takeProfit: result.takeProfit !== undefined ? result.takeProfit : null,
      riskAmount: result.riskAmount !== undefined ? result.riskAmount : null,
      calculatedQuantity: result.calculatedQuantity !== undefined ? result.calculatedQuantity : null,
      finalQuantity: result.finalQuantity !== undefined ? result.finalQuantity : null,
      finalNotional: result.finalNotional !== undefined ? result.finalNotional : null,
      maximumCapital: this.capitalAllocation,
      leverage: this.leverage,
      maximumAllowedNotional: this.capitalAllocation * this.leverage,
      maxCapitalCapped: result.maxCapitalCapped !== undefined ? result.maxCapitalCapped : null,
      consecutiveLosses: this.safety.getState().consecutiveLosses,
      safetyLimit: this.safety.getState().limit,
      safetyStatus: this.safety.getState().paused ? 'PAUSED' : (this.safety.getState().consecutiveLosses > 0 ? 'WARNING' : 'NORMAL'),
      // Shaped for public/js/renderers/model-thinking-registry.js's MODEL_002
      // renderer (Bot Detail "Decision Engine" panel). Every value here is
      // taken directly from what this decision actually computed above —
      // trend is the user-provided configuration (never BOS/EMA), touch/
      // level/body values come straight from the real touch-zone and
      // confirmation checks. Nothing here is fabricated.
      checks: {
        trend: { status: this.params.trend },
        support: {
          status: (result.activeLevel && result.activeLevel.side === 'SUPPORT') ? 'TOUCHED' : 'NOT_TOUCHED',
          level: (result.activeLevel && result.activeLevel.side === 'SUPPORT') ? result.activeLevel.price : null,
        },
        resistance: {
          status: (result.activeLevel && result.activeLevel.side === 'RESISTANCE') ? 'TOUCHED' : 'NOT_TOUCHED',
          level: (result.activeLevel && result.activeLevel.side === 'RESISTANCE') ? result.activeLevel.price : null,
        },
        confirmation: result.confirmation
          ? {
            status: result.confirmation.passed ? 'PASS' : 'FAIL',
            bodySize: result.confirmation.confirmationBodySize,
            referenceBodySize: result.confirmation.referenceBodySize,
          }
          : null,
      },
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
