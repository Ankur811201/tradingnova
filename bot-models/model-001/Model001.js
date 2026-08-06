'use strict';

const BotModelBase = require('../BotModelBase');
const CandleAggregator = require('./candleAggregator');
const patternEngine = require('./patternEngine');
const { validateCandle, validateAndMergeParameters } = require('./validators');
const { TIMEFRAMES_MS } = require('./config');
const { resolveDirectionalTarget } = require('./configContract');

/**
 * Model 001 — Execution engine wrapper for Nova Trade.
 */
class Model001 extends BotModelBase {
  async onStart(instanceConfig) {

    
    // PART 13 -- PHASE D: canonical instanceConfig.levels (BotInstance.levels)
    // takes priority over the legacy parameters.topLevel/bottomLevel location.
    // A bot created before Part 13 has instanceConfig.levels.top/bottom ===
    // null (schema default), so it silently falls through to whatever it
    // already had in parameters.topLevel/bottomLevel, and if that was never
    // set either, validateAndMergeParameters' own hardcoded defaults apply —
    // exactly the same three-tier fallback that already existed, just with
    // one new preferred source on top. Nothing is renamed or removed.
    const mergedParams = Object.assign({}, instanceConfig.parameters);
    const canonicalLevels = instanceConfig.levels || {};
    if (Number.isFinite(canonicalLevels.top)) mergedParams.topLevel = canonicalLevels.top;
    if (Number.isFinite(canonicalLevels.bottom)) mergedParams.bottomLevel = canonicalLevels.bottom;

    this.params = validateAndMergeParameters(mergedParams);


   

    this.instanceId = instanceConfig.instanceId;
    this.symbol = instanceConfig.symbol;
    this.environment = instanceConfig.environment;
    this.capitalAllocation = instanceConfig.capitalAllocation;
    this.leverage = instanceConfig.leverage;
    this.riskSettings = instanceConfig.riskSettings || {};

    // PART 13 -- PHASE F/H: canonical target levels and sizing mode. Both
    // default safely for pre-Part-13 bots (targets: [], sizing: CAPITAL),
    // which reproduces exact pre-Part-13 behavior (no takeProfit attached,
    // quantity comes entirely from patternEngine's dynamic lot table).
    this.targets = Array.isArray(instanceConfig.targets) ? instanceConfig.targets : [];
    this.sizing = instanceConfig.sizing || { mode: 'CAPITAL', value: null };

    this.aggregator = new CandleAggregator(TIMEFRAMES_MS[this.params.timeframe]);
    this.candles = [];
    this.lastProcessedCandleTimestamp = null;
    this.paused = false;
    this.stopped = false;

    // Track trade counts per level limit
    this.levelCounts = { l1: 0, l2: 0, l3: 0 };

    // PART 11: matches patternEngine.js's own hardcoded `minRequired = 50`
    // (50-period EMA is the binding requirement). Exposed here so
    // BotManager can report real "X / 50 candles" readiness instead of a
    // bare WAIT/insufficient_history with no numbers attached.
    this.minRequiredHistory = 50;
     console.log(this.params);
console.log("historySize =", this.params.historySize);
console.log("timeframe =", this.params.timeframe);
console.log("minRequired =", this.minRequiredHistory);

    this.emitStrategyEvent('MODEL_STARTED', {
      symbol: this.symbol,
      environment: this.environment,
      timeframe: this.params.timeframe,
      ruleSet: this.params.ruleSet,
    });
  }

  /**
   * PART 11 — silent history reconstruction. Called by BotManager once,
   * after onStart and before the instance receives any live market data.
   * Populates this.candles / this.lastProcessedCandleTimestamp exactly as
   * if these candles had streamed in live, but WITHOUT calling
   * patternEngine.evaluateStrategy, WITHOUT emitting a DECISION, and
   * WITHOUT building/submitting a TradeCommand. This is what prevents
   * hydration from retroactively "executing" a historical BUY/SELL.
   *
   * Reuses the same validateCandle() gate and the same
   * lastProcessedCandleTimestamp dedup field that live onMarketData()
   * relies on, so a live candle that duplicates the last hydrated one is
   * still skipped by the existing dedup check once hydration finishes.
   */
 async onHydrate(closedCandles) {
  if (!Array.isArray(closedCandles) || !closedCandles.length) return;

  const valid = closedCandles
    .filter((c) => validateCandle(c))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!valid.length) return;

  // <-- Put debug logs HERE
  console.log("===== HYDRATION =====");
  console.log("Received:", closedCandles.length);
  console.log("Valid:", valid.length);
  console.log("HistorySize:", this.params.historySize);

  this.candles = valid.slice(-this.params.historySize);

  console.log("Loaded:", this.candles.length);
  console.log("Min Required:", this.minRequiredHistory);

  this.lastProcessedCandleTimestamp =
    this.candles[this.candles.length - 1].timestamp;

  this.emitStrategyEvent("MODEL_HYDRATED", {
    symbol: this.symbol,
    timeframe: this.params.timeframe,
    candlesLoaded: this.candles.length,
    minRequired: this.minRequiredHistory,
    lastProcessedCandleTimestamp: this.lastProcessedCandleTimestamp,
  });

  // NOVA TRADE -- post-hydration UI sync: the Decision Engine UI otherwise
  // keeps showing the pre-hydration decision (reason="insufficient_history")
  // until the next live candle closes. Compute a fresh decision from the
  // just-hydrated buffer and emit it so the UI reflects reality immediately.
  // This mirrors the entry-evaluation call in onCandleClose (patternEngine
  // .evaluateStrategy with the current candles/params/levelCounts) but is
  // UI-only: no trade command, no RULE_MATCHED, no levelCounts mutation.
  const hydrationDecision = patternEngine.evaluateStrategy(
    this.candles,
    this.params,
    this.levelCounts
  );
  this._emitDecision(hydrationDecision, this.candles[this.candles.length - 1]);
}

  /**
   * PART 11 — restores per-level trade counts reconstructed by BotManager
   * from this instance's authoritative StrategyEvent history, so a
   * restart cannot silently reset maxTradesPerLevel and allow a level to
   * trade again after it already hit its cap.
   */
  restoreLevelCounts(counts) {
    this.levelCounts = Object.assign({ l1: 0, l2: 0, l3: 0 }, counts || {});
  }

  getReadiness() {
    return {
      ready: this.candles.length >= this.minRequiredHistory,
      have: this.candles.length,
      required: this.minRequiredHistory,
    };
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
    this.aggregator = null;
  }

  async onMarketData(marketUpdate, positionContext) {
    if (this.paused || this.stopped) return;
    if (!marketUpdate || marketUpdate.symbol !== this.symbol) return;

    const closedCandle = this._resolveClosedCandle(marketUpdate);
    if (!closedCandle) return;

    if (!validateCandle(closedCandle)) {
      this.emitError('Malformed candle rejected', { candle: closedCandle });
      return;
    }

    if (this.lastProcessedCandleTimestamp !== null && closedCandle.timestamp <= this.lastProcessedCandleTimestamp) {
      return;
    }
    this.lastProcessedCandleTimestamp = closedCandle.timestamp;

    this.candles.push(closedCandle);
    if (this.candles.length > this.params.historySize) {
      this.candles.splice(0, this.candles.length - this.params.historySize);
    }

    this.emitStrategyEvent('CANDLE_PROCESSED', {
      timestamp: closedCandle.timestamp, close: closedCandle.close, bufferSize: this.candles.length,
    });

    let decision;

    if (!positionContext) {
      decision = patternEngine.evaluateStrategy(this.candles, this.params, this.levelCounts);
    } else {
      // An entry evaluation is intentionally skipped while a position is
      // already open (see patternEngine call above vs. this branch) — this
      // is existing Part-6/7 behavior, unchanged here. Because no real
      // analysis runs in this branch, the DECISION emitted below reports
      // that honestly (checks: null) instead of fabricating pass/fail
      // values patternEngine never computed.
      decision = {
        action: 'NO_ACTION',
        reason: 'position_open_entry_evaluation_skipped',
        analysis: null,
      };
    }

    // NOVA TRADE -- PART 8: emit the real, normalized MODEL_001 decision for
    // every closed candle (WAIT included) BEFORE the NO_ACTION early return
    // below, so WAIT decisions reach the Decision Engine UI too. This is the
    // only decision emission point in the model and reuses the same
    // candle-timestamp dedup above (line 65-68) that trade commands rely on,
    // so at most one DECISION is emitted per canonical closed candle.
    this._emitDecision(decision, closedCandle);

    if (decision.action === 'NO_ACTION') {
      return;
    }

    if (decision.levelUpdated) {
      this.levelCounts[decision.levelUpdated] += 1;
    }

    this.emitStrategyEvent('RULE_MATCHED', {
      ruleId: decision.ruleId, reason: decision.reason, lot: decision.lot, metadata: decision,
    });

    const command = this._buildTradeCommand(decision, closedCandle);
    if (!command) {
      this.emitStrategyEvent('SIGNAL_REJECTED', { reason: 'sizing_unavailable', ruleId: decision.ruleId });
      return;
    }

    let result;
    try {
      result = await this.submitTradeCommand(command);
    } catch (err) {
      this.emitError(`submitTradeCommand threw unexpectedly: ${err.message}`, { commandId: command.commandId });
      return;
    }

    if (result && result.approved) {
      this.emitStrategyEvent('SIGNAL_GENERATED', {
        commandId: command.commandId, action: command.action, executed: Boolean(result.execution),
      });
    } else {
      this.emitStrategyEvent('SIGNAL_REJECTED', {
        commandId: command.commandId, reason: (result && result.reason) || 'rejected', ruleId: decision.ruleId,
      });
    }
  }

  /**
   * Builds and emits the normalized real-decision payload (Part 8 decision
   * contract) as a StrategyEvent with eventType 'DECISION'. BotManager
   * persists this to StrategyEvent and additionally relays it to the
   * `bot:<instanceId>` room as `bot:decision` (see BotManager._handleModelEvent).
   *
   * `decision.action` is LONG/SHORT/NO_ACTION (patternEngine's vocabulary);
   * this maps it to the UI-facing BUY/SELL/WAIT vocabulary while keeping the
   * raw action available too. Every field under `checks` comes directly from
   * patternEngine's `analysis` object (see patternEngine.js) — nothing here
   * invents a value patternEngine did not actually compute.
   */
  _emitDecision(decision, candle) {
    const decisionLabel = decision.action === 'LONG' ? 'BUY'
      : decision.action === 'SHORT' ? 'SELL'
      : decision.action === 'CLOSE' ? 'CLOSE'
      : 'WAIT';

    this.emitStrategyEvent('DECISION', {
      symbol: this.symbol,
      timeframe: this.params.timeframe,
      candleTimestamp: candle.timestamp,
      action: decision.action,
      decision: decisionLabel,
      reason: decision.reason || decision.ruleId || null,
      ruleId: decision.ruleId || null,
      checks: this._buildChecksFromAnalysis(decision.analysis),
      // PART 13 -- PHASE U: real closed-candle history metadata (client
      // requirement #3). bodySize/direction are computed directly from the
      // actual candle, never fabricated — abs(close-open) and a strict
      // close-vs-open comparison, matching TEST 14/15 exactly.
      candle: this._buildCandleSummary(candle),
      levels: {
        top: this.params.topLevel,
        bottom: this.params.bottomLevel,
        entry: decision.action === 'LONG' || decision.action === 'SHORT' ? candle.close : null,
        stopLoss: null, // computed in _buildTradeCommand from analysis not yet available here; left null intentionally (Part 8 is decisions, not execution visualization)
        targets: (this.targets || []).map((t) => t.price),
      },
    });
  }

  /**
   * PART 13 -- PHASE U: real candle body size + bullish/bearish direction,
   * computed straight from the candle's own OHLC — the client's "history
   * containing candle body size + bullish/bearish information" requirement.
   */
  _buildCandleSummary(candle) {
    const bodySize = Math.abs(candle.close - candle.open);
    const direction = candle.close > candle.open ? 'BULLISH'
      : candle.close < candle.open ? 'BEARISH'
      : 'NEUTRAL';
    return {
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      bodySize,
      direction,
    };
  }

  /**
   * Maps patternEngine's raw `analysis` object (real, already-computed
   * values) onto the checks shape the Decision Engine UI understands. When
   * `analysis` is null (insufficient history, or evaluation was skipped
   * because a position is already open) this returns null so the UI shows
   * "unavailable" rather than a fake result. Volume is always UNAVAILABLE:
   * canonical candles never carry volume data (see Candle.js).
   */
  _buildChecksFromAnalysis(analysis) {
    if (!analysis) return null;
    return {
      trend: { status: analysis.trend, ema50: analysis.ema50 },
      support: { status: analysis.touchBottom ? 'TOUCHED' : 'NOT_TOUCHED', level: analysis.bottomLevel },
      resistance: { status: analysis.touchTop ? 'TOUCHED' : 'NOT_TOUCHED', level: analysis.topLevel },
      bodyExpansion: {
        status: analysis.isValidBody15x ? 'PASS' : 'FAIL',
        bodySize: analysis.bodySize,
        prevBodySize: analysis.prevBodySize,
      },
      volume: { status: 'UNAVAILABLE', value: null },
      liquiditySweep: { status: analysis.liquiditySweepHigh ? 'DETECTED' : 'NONE' },
      cycle3Candle: {
        status: analysis.cycle3CandleBuy ? 'BUY' : analysis.cycle3CandleSell ? 'SELL' : 'NONE',
      },
    };
  }

  _resolveClosedCandle(marketUpdate) {
    if (marketUpdate.type === 'price') {
      const price = marketUpdate.data && marketUpdate.data.price;
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
      return this.aggregator.addTick(price, marketUpdate.timestamp);
    }
    if (marketUpdate.type === 'candle') {
      return marketUpdate.data;
    }
    return null;
  }

  _buildTradeCommand(decision, candle) {
    const commandId = `MODEL001:${this.instanceId}:${candle.timestamp}:${decision.action}:${decision.ruleId || 'EXIT'}`;

    const base = {
      commandId: commandId,
      instanceId: this.instanceId,
      symbol: this.symbol,
      environment: this.environment,
      action: decision.action,
      timestamp: candle.timestamp,
      reason: decision.reason,
      metadata: Object.assign({ ruleId: decision.ruleId, ruleSet: this.params.ruleSet, timeframe: this.params.timeframe }),
    };

    if (decision.action === 'CLOSE') {
      return base;
    }

    const referencePrice = candle.close;
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) return null;

    // PART 13 -- PHASE H/L: LOT mode overrides the strategy's own dynamic
    // candle-points lot table with the user's explicit configured quantity.
    // This does NOT bypass RiskEngine — `quantity` still flows through the
    // exact same notional/capital/leverage/position-size checks RiskEngine
    // already runs on every command (see RiskEngine.evaluate step 10). CAPITAL
    // mode (default) is byte-for-byte the pre-Part-13 behavior.
    const quantity = (this.sizing && this.sizing.mode === 'LOT' && Number.isFinite(this.sizing.value))
      ? this.sizing.value
      : (decision.lot || 1);

    const bufferPips = (decision.slBufferPips || 10) * (this.params.mintick || 0.01);

    let stopLoss = null;
    if (decision.action === 'LONG') {
      stopLoss = candle.low - bufferPips;
    } else if (decision.action === 'SHORT') {
      stopLoss = candle.high + bufferPips;
    }

    // PART 13 -- PHASE F/G/S: wire the nearest direction-valid configured
    // target through to the existing single takeProfit pipeline (PaperEngine/
    // LiveEngine/Position already support this end-to-end — see PHASE S audit).
    // A LONG only accepts a target above entry, a SHORT only one below; if no
    // configured target satisfies that, takeProfit stays null exactly as it
    // did before targets existed. Multi-target partial exits are out of scope.
    const takeProfit = resolveDirectionalTarget(this.targets, decision.action, referencePrice);

    return Object.assign({}, base, { quantity: quantity, stopLoss: stopLoss, takeProfit: takeProfit });
  }
}

module.exports = Model001;