'use strict';

/**
 * BotModelBase — the contract every Bot Model (e.g. Part 3's Model 001) must implement.
 *
 * A Bot Model NEVER:
 *  - receives Delta API credentials
 *  - writes directly to MongoDB (orders/positions/portfolio)
 *  - calls PaperEngine or LiveEngine directly
 *  - calls Delta Exchange directly
 *
 * A Bot Model ONLY:
 *  - receives normalized market data + config/context via the methods below
 *  - emits TradeCommand / StrategyEvent / StatusUpdate / Error objects back to BotManager
 *
 * Flow: BotModel -> BotManager -> RiskEngine -> ExecutionRouter -> PaperEngine | LiveEngine
 */
class BotModelBase {
  /**
   * @param {object} ctx
   * @param {string} ctx.modelId
   * @param {string} ctx.modelVersion
   * @param {(event: object) => void} ctx.emit - call with a StrategyEvent/StatusUpdate/Error envelope
   * @param {(command: object) => Promise<object>} ctx.submitTradeCommand - routes a TradeCommand through BotManager
   */
  constructor(ctx) {
    if (new.target === BotModelBase) {
      throw new Error('BotModelBase is abstract and cannot be instantiated directly');
    }
    this.modelId = ctx.modelId;
    this.modelVersion = ctx.modelVersion;
    this._emit = ctx.emit;
    this._submitTradeCommand = ctx.submitTradeCommand;
  }

  /**
   * Called by BotManager once when a Bot Instance starts.
   * @param {object} instanceConfig - { instanceId, symbol, environment, parameters, capitalAllocation, leverage, riskSettings, levels, targets, sizing }
   *   PART 13: levels = {top, bottom} (nullable), targets = [{price}] (possibly
   *   empty), sizing = {mode: 'CAPITAL'|'LOT', value} — always present with
   *   schema defaults, never undefined.
   */
  async onStart(_instanceConfig) {
    throw new Error(`${this.constructor.name}.onStart not implemented`);
  }

  /**
   * Called by BotManager on every normalized market data update (price or candle)
   * for the instance's configured symbol.
   * @param {object} marketUpdate - { type: 'price'|'candle', symbol, data, timestamp }
   * @param {object} positionContext - current open position for this instance, or null
   */
  async onMarketData(_marketUpdate, _positionContext) {
    throw new Error(`${this.constructor.name}.onMarketData not implemented`);
  }

  /** Called by BotManager when the instance is paused. */
  async onPause() {}

  /** Called by BotManager when the instance is stopped. */
  async onStop() {}

  /**
   * PART 11 — optional hook. Called by BotManager exactly once, right after
   * onStart and strictly BEFORE the instance is registered to receive live
   * market data, with the most recent CLOSED canonical candles already
   * persisted in MongoDB for this instance's (symbol, timeframe).
   *
   * Implementations MUST silently reconstruct analysis state (candle
   * buffers, indicator inputs, last-processed timestamp, etc.) and MUST
   * NOT emit a DECISION, StrategyEvent implying a trade signal, or a
   * TradeCommand as a result of this call. Hydration rebuilds state; it
   * never trades on history.
   *
   * A model that doesn't override this simply starts with empty history,
   * same as before Part 11 (backward compatible).
   * @param {object[]} _closedCandles oldest -> newest
   */
  async onHydrate(_closedCandles) {}

  /**
   * PART A (multi-timeframe infra) — optional hook. Called by BotManager
   * once per timeframe the model declared via its registration's
   * `requiredTimeframes` (see each model folder's index.js), AFTER onHydrate and
   * strictly BEFORE the instance is registered to receive live market data
   * — the same hydration-before-dispatch guarantee onHydrate already has.
   * Each call carries the CLOSED candles for exactly one declared
   * timeframe, oldest -> newest, at the history depth that timeframe
   * requested. Same rules as onHydrate: reconstruct state silently, never
   * emit a DECISION/StrategyEvent implying a trade signal, never submit a
   * TradeCommand.
   *
   * A model that declares no requiredTimeframes, or doesn't override this,
   * simply never receives it — no behavior change from before Part A.
   * @param {string} _timeframe e.g. '1h', '1d'
   * @param {object[]} _closedCandles oldest -> newest
   */
  async onHydrateTimeframe(_timeframe, _closedCandles) {}

  /**
   * PART 11 — optional hook. Called by BotManager right after onHydrate
   * with per-level trade counts reconstructed from this instance's
   * authoritative StrategyEvent history, so a restart cannot reset a
   * per-level trade cap and allow trades that should already be blocked.
   * @param {object} _counts e.g. { l1: 2, l2: 0, l3: 0 }
   */
  restoreLevelCounts(_counts) {}

  /**
   * PART 11 — optional hook. Returns { ready, have, required } describing
   * whether the model currently has enough history to produce real
   * decisions. BotManager surfaces this as instance-level "strategy
   * readiness" (HYDRATING / READY / INSUFFICIENT_HISTORY) without
   * changing the BotInstance.status lifecycle field.
   */
  getReadiness() {
    return { ready: true, have: 0, required: 0 };
  }

  // --- Helpers available to subclasses ---

  emitStrategyEvent(eventType, payload = {}) {
    this._emit({ kind: 'StrategyEvent', eventType, payload, at: Date.now() });
  }

  emitStatusUpdate(status, detail = '') {
    this._emit({ kind: 'StatusUpdate', status, detail, at: Date.now() });
  }

  emitError(message, meta = {}) {
    this._emit({ kind: 'Error', message, meta, at: Date.now() });
  }

  /**
   * Submit a standardized TradeCommand. This is routed through BotManager -> RiskEngine
   * -> ExecutionRouter. Returns the RiskEngine decision + execution result (if approved).
   * @param {object} command
   * @param {string} command.commandId - MUST be unique per logical signal for idempotency
   * @param {string} command.instanceId
   * @param {string} command.symbol
   * @param {'PAPER'|'LIVE'} command.environment
   * @param {'LONG'|'SHORT'|'CLOSE'|'NO_ACTION'} command.action
   * @param {number} [command.quantity]
   * @param {number} [command.stopLoss]
   * @param {number} [command.takeProfit]
   * @param {string} [command.reason]
   * @param {object} [command.metadata]
   */
  async submitTradeCommand(command) {
    return this._submitTradeCommand({
      ...command,
      modelId: this.modelId,
      modelVersion: this.modelVersion,
      timestamp: Date.now(),
    });
  }
}

module.exports = BotModelBase;
