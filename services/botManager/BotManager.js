'use strict';

const fs = require('fs');
const path = require('path');
const BotInstance = require('../../models/BotInstance');
const BotModelMetadata = require('../../models/BotModelMetadata');
const StrategyEvent = require('../../models/StrategyEvent');
const candleBackfillService = require('../marketData/CandleBackfillService');
const { getUsableRecentHistory } = require('../marketData/usableHistoryQuery');
const riskEngine = require('../riskEngine/RiskEngine');
const executionRouter = require('../execution/ExecutionRouter');
const { validateTradeCommand } = require('../../bot-models/TradeCommandSchema');
const { newInstanceId } = require('../../utils/ids');
const logger = require('../../utils/logger');
const { env } = require('../../config/env');
const { AppError } = require('../../utils/apiResponse');

// PART 11: how many recent CLOSED candles to hydrate a newly-started
// instance with. patternEngine.js requires >= 50 (50-period EMA is the
// binding requirement); a small justified buffer is added on top so a
// bot doesn't land exactly on the boundary after normal candle churn.
// Capped at the instance's own historySize since the model never keeps
// more than that in memory anyway — no point loading more.
const HYDRATION_MIN_CANDLES = 60;

// NOTE: this constant lives under bot-models/model-001/ but is already
// treated as shared candle infrastructure elsewhere in the codebase (e.g.
// CandlePersistenceService imports it the same way) rather than as
// Model001-specific strategy logic — it's just the one place the
// "no timeframe configured on this instance" fallback is defined. Reused
// here so timeframe routing (below) works generically for ANY bot model
// instance that receives candle updates, not only MODEL_001.
const { DEFAULT_PARAMETERS, TIMEFRAMES_MS } = require('../../bot-models/model-001/config');
const {
  validateLevels, validateTargets, validateSizing, validateLeverage,
} = require('../../bot-models/model-001/configContract');

// PHASE Q — strategy-sensitive configuration fields cannot be changed while
// an instance is RUNNING (same policy already applied to `timeframe` before
// Part 13). Require PAUSE/STOP, save, then Start/Restart. Chosen because
// Model001 only re-reads levels/sizing/targets/leverage from instanceConfig
// once, in onStart — mutating them mid-run would silently desync the live
// strategy state from the persisted config.

const BOT_MODELS_DIR = path.join(__dirname, '..', '..', 'bot-models');

/**
 * BotManager — generic bot runtime infrastructure.
 * Contains NO Model 001 (or any) strategy logic. Its job is purely:
 *   discover/register models -> create/start/pause/stop instances ->
 *   receive events/commands from live model instances -> validate ->
 *   forward to RiskEngine -> forward approved commands to ExecutionRouter.
 */
class BotManager {
  // Bounds for the deferred closed-position -> Trade-record lookup (see
  // dispatchMarketData) — how long/how many attempts before a genuinely
  // missing Trade record is logged as a miss rather than retried forever.
  static CLOSED_TRADE_LOOKUP_MAX_ATTEMPTS = 10;
  static CLOSED_TRADE_LOOKUP_MAX_WAIT_MS = 60000;

  constructor() {
    this.registeredModels = new Map(); // modelId -> { modelId, modelVersion, create }
    this.liveInstances = new Map(); // instanceId -> { modelInstance, dbInstanceId, unsubscribers: [] }
    // PART 11: instanceId -> { state, have, required, updatedAt }. Purely
    // in-memory runtime readiness, separate from BotInstance.status
    // (RUNNING/PAUSED/STOPPED/ERROR persisted lifecycle). Never persisted:
    // it is always recomputed fresh on every startInstance() call.
    this.readiness = new Map();
    // PART 11.1 — per-instance lifecycle lock. Two concurrent Start/Stop/
    // Pause/Restart/Config/Delete calls for the SAME instanceId must never
    // interleave (that's what let two concurrent Start requests both read
    // STOPPED before either wrote RUNNING, spinning up two MODEL_001
    // runtimes). Different instanceIds are never blocked by each other —
    // this map holds one settle-chain per instanceId, not a global lock.
    this.instanceLocks = new Map();
    this.ioRef = null;
  }

  attachSocketServer(io) {
    this.ioRef = io;
  }

  /**
   * Scans bot-models subdirectories for an index.js exporting { modelId, modelVersion, create }.
   * Part 1 ships with no strategy folders, so this is typically a no-op until Part 3.
   */
  /**
   * PART 11.1 — serializes lifecycle operations (start/pause/stop/restart/
   * config/delete) per instanceId. Each call for a given instanceId is
   * queued strictly behind whatever previous call for that SAME instanceId
   * is still in flight, whether that prior call succeeded or failed.
   * Different instanceIds never wait on each other — the queue lives per
   * key in `this.instanceLocks`, not as one global lock.
   *
   * The caller of `_withLock` gets the real result/rejection of `fn()`;
   * only the internal chain-continuation promise is made non-rejecting, so
   * one instance's failed operation can never wedge the queue for that
   * instance's subsequent operations.
   */
  _withLock(instanceId, fn) {
    const prior = this.instanceLocks.get(instanceId) || Promise.resolve();
    const settledPrior = prior.catch(() => {});
    const result = settledPrior.then(() => fn());
    this.instanceLocks.set(instanceId, result.catch(() => {}));
    return result;
  }

  async discoverModels() {
    let entries = [];
    try {
      entries = fs.readdirSync(BOT_MODELS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (err) {
      await logger.warn('BOT', `Could not scan bot-models directory: ${err.message}`);
      return [];
    }

    const found = [];
    for (const entry of entries) {
      const indexPath = path.join(BOT_MODELS_DIR, entry.name, 'index.js');
      if (!fs.existsSync(indexPath)) continue;
      try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const mod = require(indexPath);
        if (!mod.modelId || !mod.modelVersion || typeof mod.create !== 'function') {
          await logger.warn('BOT', `Skipping invalid bot model at ${indexPath}: missing modelId/modelVersion/create`);
          continue;
        }
        this.registeredModels.set(mod.modelId, mod);
        await BotModelMetadata.findOneAndUpdate(
          { modelId: mod.modelId },
          {
            modelId: mod.modelId,
            name: mod.name || mod.modelId,
            version: mod.modelVersion,
            description: mod.description || '',
            author: mod.author || '',
            supportedSymbols: mod.supportedSymbols || [],
            defaultParameters: mod.defaultParameters || {},
            // PART A (multi-timeframe infra): optional, additive. A model
            // that doesn't export this (e.g. MODEL_001) registers with [],
            // identical to pre-Part-A behavior.
            requiredTimeframes: mod.requiredTimeframes || [],
            isEnabled: true,
          },
          { upsert: true, new: true }
        );
        found.push(mod.modelId);
        await logger.info('BOT', `Registered bot model ${mod.modelId}@${mod.modelVersion}`);
      } catch (err) {
        await logger.error('BOT', `Failed to load bot model at ${indexPath}: ${err.message}`);
      }
    }
    return found;
  }

  async listAvailableModels() {
    return BotModelMetadata.find({ isEnabled: true }).lean();
  }

  /** Creates a new (STOPPED) bot instance in the database. */
  async createInstance({
    name ,userId, modelId, symbol, environment, parameters = {},
    capitalAllocation, leverage = 1, riskSettings = {},
    sizing = null, levels = null, targets = null,
  }) {
    const modelMeta = await BotModelMetadata.findOne({ modelId, isEnabled: true });
    if (!modelMeta) {
      throw new AppError(`Bot model "${modelId}" is not registered or is disabled`, 404);
    }
    if (!capitalAllocation || capitalAllocation <= 0) {
      throw new AppError('capitalAllocation must be positive', 400);
    }
    if (!['PAPER', 'LIVE'].includes(environment)) {
      throw new AppError('environment must be PAPER or LIVE', 400);
    }

    // PHASE J — leverage was previously only bounds-checked on
    // updateConfiguration, never on create; a bot could be created above
    // env.RISK_MAX_LEVERAGE and only get caught later by RiskEngine at
    // trade time. Validate up front instead.
    const maxLeverage = env.RISK_MAX_LEVERAGE || 20;
    let normalizedLeverage, normalizedLevels, normalizedTargets, normalizedSizing;
    try {
      normalizedLeverage = validateLeverage(leverage, maxLeverage);
      // PHASE E/F/H — same validators updateConfiguration uses; a value
      // supplied at creation is held to identical rules as one supplied later.
      normalizedLevels = validateLevels(levels);
      normalizedTargets = validateTargets(targets);
      normalizedSizing = validateSizing(sizing);
    } catch (err) {
      throw new AppError(err.message, 400);
    }

    // PART 13.1 -- PHASE D: timeframe is now an explicit, persisted field
    // on every instance from the moment it's created, never a runtime
    // guess resolved later. If the creator didn't supply one, '5m' is
    // chosen HERE, once, as a deliberate product default for brand-new
    // bots, and written into `parameters` below -- it is never re-derived
    // for an already-existing instance (see validators.js, which now
    // throws instead of defaulting). An explicitly supplied timeframe must
    // be one BotManager/the chart/CandlePersistenceService actually
    // recognize (TIMEFRAMES_MS), checked up front for the same reason
    // leverage/levels/targets/sizing are: fail at creation, not at Start.
    const requestedTimeframe = parameters && parameters.timeframe;
    if (requestedTimeframe !== undefined && requestedTimeframe !== null && requestedTimeframe !== '') {
      if (!Object.prototype.hasOwnProperty.call(TIMEFRAMES_MS, requestedTimeframe)) {
        throw new AppError(`Invalid timeframe "${requestedTimeframe}". Supported: ${Object.keys(TIMEFRAMES_MS).join(', ')}`, 400);
      }
    }
    const resolvedParameters = Object.assign(
      { timeframe: DEFAULT_PARAMETERS.timeframe },
      parameters,
    );

    const instance = await BotInstance.create({
      instanceId: newInstanceId(),
      name,
      user: userId,
      modelId,
      modelVersion: modelMeta.version,
      symbol,
      environment,
      status: 'STOPPED',
      parameters: resolvedParameters,
      capitalAllocation,
      leverage: normalizedLeverage,
      riskSettings,
      configVersion: 2,
      sizing: normalizedSizing || { mode: 'CAPITAL', value: null },
      levels: normalizedLevels || { top: null, bottom: null },
      targets: normalizedTargets || [],
    });

    await logger.info('BOT', `Bot instance created: ${instance.instanceId} (${modelId} on ${symbol}, ${environment})`);
    return instance;
  }
 async deleteInstance(instanceId) {
    return this._withLock(instanceId, async () => {
      const result = await this._deleteInstanceUnlocked(instanceId);
      // No further operations can legitimately target a deleted instance —
      // drop its lock entry so the map doesn't grow forever across
      // create/delete churn.
      this.instanceLocks.delete(instanceId);
      this.readiness.delete(instanceId);
      return result;
    });
  }

  async _deleteInstanceUnlocked(instanceId) {

    const instance = await BotInstance.findOne({ instanceId });

    if (!instance) {
        throw new Error("Bot not found");
    }

    if (instance.status === "RUNNING") {
        throw new Error("Stop the bot before deleting it.");
    }

    await BotInstance.deleteOne({ instanceId });

}

  /** Public entry point — serialized per instanceId (see _withLock). */
  async startInstance(instanceId) {
    return this._withLock(instanceId, () => this._startInstanceUnlocked(instanceId));
  }

  async _startInstanceUnlocked(instanceId) {
    const dbInstance = await BotInstance.findOne({ instanceId });
    if (!dbInstance) throw new AppError('Bot instance not found', 404);
    // Idempotent: Start clicked twice (double-click, retry) must not spin
    // up a second runtime for the same instance. Safe against concurrency
    // now because _withLock guarantees this fresh DB read can never race
    // another start/stop/restart for this same instanceId — by the time
    // this line runs, any prior in-flight call for this instanceId has
    // already fully completed and its status write is visible here.
    if (dbInstance.status === 'RUNNING') return dbInstance;

    const modelDef = this.registeredModels.get(dbInstance.modelId);
    if (!modelDef) {
      throw new AppError(`Bot model "${dbInstance.modelId}" is not currently registered in this running process`, 409);
    }

    const modelInstance = modelDef.create({
      modelId: dbInstance.modelId,
      modelVersion: dbInstance.modelVersion,
      emit: (event) => this._handleModelEvent(dbInstance.instanceId, event),
      submitTradeCommand: (cmd) => this._handleTradeCommand(dbInstance.instanceId, cmd),
    });

    await modelInstance.onStart({
      instanceId: dbInstance.instanceId,
      symbol: dbInstance.symbol,
      environment: dbInstance.environment,
      parameters: dbInstance.parameters,
      capitalAllocation: dbInstance.capitalAllocation,
      leverage: dbInstance.leverage,
      riskSettings: dbInstance.riskSettings,
      // PART 13 — canonical config contract. dbInstance.levels/targets/sizing
      // are plain Mongoose subdocuments here; toObject() keeps Model001 (and
      // any future model) from having to know about Mongoose document
      // internals. Absent on pre-Part-13 bots only in the sense that their
      // values are the schema defaults (top/bottom null, sizing CAPITAL,
      // targets []) — never undefined — so downstream code never has to
      // null-check the container itself.
      levels: dbInstance.levels ? dbInstance.levels.toObject() : { top: null, bottom: null },
      targets: (dbInstance.targets || []).map((t) => ({ price: t.price })),
      sizing: dbInstance.sizing ? dbInstance.sizing.toObject() : { mode: 'CAPITAL', value: null },
    });

    // PART 11 — PHASE C/D/E/F: hydrate history + recover per-level trade
    // counts BEFORE this instance is registered into liveInstances (i.e.
    // before it can receive any live market data). Because dispatchMarketData
    // only ever sees instances already present in liveInstances, and this
    // whole block runs synchronously-awaited inside one HTTP request with
    // no interleaving visible to other code, no live candle for this
    // instance can be dispatched, missed, or double-processed relative to
    // hydration — the ordering itself is the race guard.
    this._setReadiness(instanceId, 'HYDRATING', { have: 0, required: 0 });
    try {
      await this._hydrateInstance(dbInstance, modelInstance);
      await this._recoverLevelCounts(dbInstance, modelInstance);
      await this._recoverSafetyState(dbInstance, modelInstance);
    } catch (err) {
      await logger.error('BOT', `History hydration failed for ${instanceId}: ${err.message}`);
      this._setReadiness(instanceId, 'ERROR', { have: 0, required: 0, error: err.message });
      throw new AppError(`Failed to hydrate bot instance history: ${err.message}`, 500);
    }

    this.liveInstances.set(instanceId, { modelInstance, unsubscribers: [], wasPositionOpen: false, lastOpenPositionId: null, pendingClosedTradeLookup: null });

    dbInstance.status = 'RUNNING';
    dbInstance.startedAt = new Date();
    dbInstance.lastError = null;
    await dbInstance.save();

    const readiness = typeof modelInstance.getReadiness === 'function'
      ? modelInstance.getReadiness()
      : { ready: true, have: 0, required: 0 };
    this._setReadiness(instanceId, readiness.ready ? 'READY' : 'INSUFFICIENT_HISTORY', readiness);

    await logger.info('BOT', `Bot instance started: ${instanceId}`);
    this._broadcastStatus(dbInstance);
    return dbInstance;
  }

  /**
   * PART 11 — PHASE C: loads the most recent CLOSED canonical candles for
   * this instance's exact (symbol, timeframe) from MongoDB and hands them
   * to the model's onHydrate() hook (a no-op for models that don't define
   * one). Never fabricates candles; if nothing has been persisted yet the
   * model simply starts with an empty buffer, same as before Part 11.
   */
  async _hydrateInstance(dbInstance, modelInstance) {
    // PART 13.1 -- PHASE D: no `|| DEFAULT_PARAMETERS.timeframe` fallback
    // here. _hydrateInstance only ever runs after modelInstance.onStart
    // (see startInstance above) has already succeeded, and onStart now
    // throws for a missing timeframe (validators.js) before this method is
    // reached -- so dbInstance.parameters.timeframe is guaranteed to be a
    // real, explicit value by this point. A fallback here would just hide
    // that guarantee ever broke.
    if (typeof modelInstance.onHydrate === 'function') {
      const timeframe = dbInstance.parameters.timeframe;
      const wantCount = Math.max(
        HYDRATION_MIN_CANDLES,
        Math.min((dbInstance.parameters && dbInstance.parameters.historySize) || 0, 200)
      );
      const candles = await this._hydrateOneTimeframe(dbInstance, timeframe, wantCount);
      await modelInstance.onHydrate(candles);
    }

    // PART A (multi-timeframe infra): additionally hydrate every timeframe
    // the model declared via BotModelMetadata.requiredTimeframes, each to
    // its own requested history depth, and hand each off to the optional
    // onHydrateTimeframe hook. A model that declares none (e.g. MODEL_001)
    // or doesn't implement the hook makes this a no-op — identical to
    // pre-Part-A behavior.
    if (typeof modelInstance.onHydrateTimeframe === 'function') {
      const modelDef = this.registeredModels.get(dbInstance.modelId);
      const required = (modelDef && modelDef.requiredTimeframes) || [];
      for (const entry of required) {
        const candles = await this._hydrateOneTimeframe(dbInstance, entry.timeframe, entry.history);
        await modelInstance.onHydrateTimeframe(entry.timeframe, candles);
      }
    }
  }

  /**
   * PART A (multi-timeframe infra): shared "give me `wantCount` real usable
   * recent closed candles for (symbol, timeframe), backfilling from the
   * market data provider if Mongo doesn't already have enough" logic,
   * extracted so both the model's own entry timeframe and any number of
   * declared requiredTimeframes hydrate through the exact same real-data
   * path (PART 12.1 usable-history semantics, PART 12 backfill semantics —
   * unchanged, just no longer hardcoded to a single timeframe).
   */
  async _hydrateOneTimeframe(dbInstance, timeframe, wantCount) {
    const tfMs = TIMEFRAMES_MS[timeframe];

    // PART 12.1 — PHASE 2/4/17: "enough history" means enough USABLE
    // RECENT CONTIGUOUS closed candles, not just `wantCount` documents
    // however old or gapped. A gap-riddled or stale (e.g. yesterday's)
    // Mongo history must still trigger backfill even if raw doc count is
    // already >= wantCount.
    let usable = await getUsableRecentHistory({ symbol: dbInstance.symbol, timeframe, tfMs, targetCount: wantCount });

    if (!usable.sufficient) {
      this._setReadiness(dbInstance.instanceId, 'BACKFILLING', { have: usable.usable, required: wantCount });
      try {
        await candleBackfillService.ensureSufficientHistory({
          symbol: dbInstance.symbol,
          timeframe,
          targetCount: wantCount,
        });
      } catch (err) {
        // Only programmer errors (bad symbol/timeframe type) reach here —
        // CandleBackfillService itself never rejects for "no historical
        // data available". Log and continue with whatever real history
        // Mongo already has (PHASE N: never crash, never fabricate).
        await logger.warn('BOT', `Historical backfill errored for ${dbInstance.symbol} ${timeframe}: ${err.message}`);
      }

      // PART 12.1 — PHASE 6: re-derive usable history from Mongo after
      // backfill; never assume the backfill call alone made us sufficient.
      usable = await getUsableRecentHistory({ symbol: dbInstance.symbol, timeframe, tfMs, targetCount: wantCount });
    }

    // PART 12.1 — PHASE 7: hydrate from the coherent contiguous recent
    // window only — never old candles + gap + recent candles merely to
    // reach wantCount.
    return usable.usableCandles.map((c) => ({
      timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }));
  }

  /**
   * PART 11 — PHASE D/LEVELCOUNTS: reconstructs per-level trade counts
   * from this instance's own authoritative StrategyEvent history
   * (eventType 'RULE_MATCHED', which Model001 emits with payload.metadata
   * containing `levelUpdated` immediately after a level-limited signal is
   * matched — see Model001.js). This is a real, already-persisted record
   * of every level-limited signal ever matched for this instance, so a
   * restart can no longer reset levelCounts to zero and let a level trade
   * past maxTradesPerLevel again.
   */
  async _recoverLevelCounts(dbInstance, modelInstance) {
    if (typeof modelInstance.restoreLevelCounts !== 'function') return;

    const events = await StrategyEvent.find({
      instanceId: dbInstance.instanceId,
      eventType: 'RULE_MATCHED',
    }).select('payload').lean();

    const counts = {};
    for (const evt of events) {
      const level = evt.payload && evt.payload.metadata && evt.payload.metadata.levelUpdated;
      if (!level) continue;
      counts[level] = (counts[level] || 0) + 1;
    }

    modelInstance.restoreLevelCounts(counts);
  }

  /**
   * Generic (model-agnostic) restart-recovery for a consecutive-loss safety
   * counter: reconstructs the current consecutive-loss streak from this
   * instance's own authoritative, already-persisted `Trade` history (the
   * single source of truth PaperEngine/LiveEngine both write to on every
   * position close — see Trade.js) rather than trusting any in-memory
   * value, so a restart can never silently forget that a bot was already
   * safety-paused or reset an in-progress loss streak to zero.
   *
   * Scoped by BOTH instanceId and environment: a Trade's `instanceId`
   * alone is not a sufficient key — if an instanceId were ever reused or
   * queried without the environment filter, a PAPER trade history could
   * bleed into a LIVE bot's safety reconstruction (or vice versa). Every
   * Trade already carries its own `environment` field (see Trade.js), so
   * this costs nothing to add and removes the ambiguity entirely.
   *
   * Model-agnostic by the same convention as _recoverLevelCounts: only
   * runs if the model instance defines `restoreSafetyState(state)` — a
   * no-op for any model (e.g. MODEL_001) that doesn't. Walks the most
   * recent closed trades newest-first and counts consecutive losses
   * (realizedPnl < 0) until the first non-loss (WIN realizedPnl > 0, or
   * BREAK_EVEN realizedPnl === 0 — both break the streak), then reports
   * `paused` as true if that count already reached the model's own
   * configured limit. The model is the sole authority on what its limit
   * is and on what "paused" then means for it; this method only supplies
   * the historical fact of how many consecutive losses precede right now.
   *
   * Restart-safe dedup: ALL of the recent Trade `_id`s loaded above for
   * this instanceId+environment — not only the ones that happened to fall
   * within the current consecutive-loss streak — are passed alongside the
   * reconstructed count/paused state so the model's dedup set can be
   * seeded with them (see ConsecutiveLossSafety.restoreState). Seeding
   * only the streak's own trades would leave every OTHER recently-loaded
   * trade (e.g. one behind an older WIN, still well within the lookback
   * window) unprotected against a redelivered/replayed close event for
   * it specifically. Seeding the full loaded set closes that gap
   * entirely: none of the recent, already-known trades can ever be
   * double-counted, restart or not. The consecutive-loss CALCULATION
   * itself is unchanged — it still only walks/counts the leading loss
   * streak, exactly as before; only which trade ids get seeded into the
   * dedup set has changed.
   */
  async _recoverSafetyState(dbInstance, modelInstance) {
    if (typeof modelInstance.restoreSafetyState !== 'function') return;

    const Trade = require('../../models/Trade');
    const recentTrades = await Trade.find({ instanceId: dbInstance.instanceId, environment: dbInstance.environment })
      .sort({ closedAt: -1 })
      .limit(50)
      .select('realizedPnl closedAt')
      .lean();

    // Seed dedup with EVERY trade loaded in this lookback window, regardless
    // of whether it fell inside the current loss streak.
    const processedTradeIds = recentTrades.map((trade) => String(trade._id));

    // Consecutive-loss calculation itself — unchanged from before.
    let consecutiveLosses = 0;
    for (const trade of recentTrades) {
      if (trade.realizedPnl < 0) {
        consecutiveLosses += 1;
      } else {
        // First WIN or BREAK_EVEN encountered walking backward from the
        // most recent trade breaks the streak — stop counting.
        break;
      }
    }

    const limit = typeof modelInstance.getSafetyLossLimit === 'function' ? modelInstance.getSafetyLossLimit() : null;
    const paused = limit !== null ? consecutiveLosses >= limit : false;

    modelInstance.restoreSafetyState({ consecutiveLosses, paused, processedTradeIds });
  }

  _setReadiness(instanceId, state, extra = {}) {
    const entry = Object.assign({ state, updatedAt: Date.now() }, extra);
    this.readiness.set(instanceId, entry);
    if (this.ioRef) {
      this.ioRef.to(`bot:${instanceId}`).emit('bot:readiness', Object.assign({ instanceId }, entry));
    }
    return entry;
  }

  /** Current in-memory strategy readiness for an instance, or a NOT_RUNNING default. */
  getReadiness(instanceId) {
    return this.readiness.get(instanceId) || { state: 'NOT_RUNNING', have: 0, required: 0, updatedAt: null };
  }

  async pauseInstance(instanceId) {
    return this._withLock(instanceId, () => this._pauseInstanceUnlocked(instanceId));
  }

  async _pauseInstanceUnlocked(instanceId) {
    const dbInstance = await BotInstance.findOne({ instanceId });
    if (!dbInstance) throw new AppError('Bot instance not found', 404);

    const live = this.liveInstances.get(instanceId);
    if (live) {
      await live.modelInstance.onPause();
    }
    dbInstance.status = 'PAUSED';
    await dbInstance.save();
    await logger.info('BOT', `Bot instance paused: ${instanceId}`);
    this._broadcastStatus(dbInstance);
    return dbInstance;
  }

  async stopInstance(instanceId) {
    return this._withLock(instanceId, () => this._stopInstanceUnlocked(instanceId));
  }

  async _stopInstanceUnlocked(instanceId) {
    const dbInstance = await BotInstance.findOne({ instanceId });
    if (!dbInstance) throw new AppError('Bot instance not found', 404);

    const live = this.liveInstances.get(instanceId);
    if (live) {
      await live.modelInstance.onStop();
      live.unsubscribers.forEach((unsub) => {
        try { unsub(); } catch (_e) { /* noop */ }
      });
      this.liveInstances.delete(instanceId);
    }
    dbInstance.status = 'STOPPED';
    dbInstance.stoppedAt = new Date();
    await dbInstance.save();
    this.readiness.delete(instanceId);
    await logger.info('BOT', `Bot instance stopped: ${instanceId}`);
    this._broadcastStatus(dbInstance);
    return dbInstance;
  }

  async restartInstance(instanceId) {
    // PART 11.1: stop+start must happen as ONE atomic unit under the lock —
    // calling the public (locked) startInstance/stopInstance here would
    // deadlock (each would wait on a lock this very call already holds),
    // so restart calls the unlocked internals directly. This also closes
    // the restart+stop / restart+restart races: a concurrent stop/restart
    // for the same instanceId is queued behind this whole sequence, never
    // interleaved into the middle of it.
    return this._withLock(instanceId, async () => {
      await this._stopInstanceUnlocked(instanceId);
      return this._startInstanceUnlocked(instanceId);
    });
  }

  /**
   * PART 11 — PHASE M: Save Configuration. Validates and persists only the
   * CURRENT editable BotInstance fields; never invents support for fields
   * the backend doesn't already enforce elsewhere. Nothing is written
   * unless every supplied field passes validation — a failed save must
   * never leave a half-applied config.
   *
   * timeframe changes a running instance's aggregation window and hydration
   * pair, which the live runtime cannot safely absorb mid-flight — the
   * safer minimal rule (per the Part 11 prompt) is: timeframe cannot be
   * changed while RUNNING; pause or stop first. All other fields may be
   * saved at any time (capitalAllocation/leverage take effect on next
   * start/restart, matching existing onStart() semantics).
   */
  async updateConfiguration(instanceId, updates = {}) {
    return this._withLock(instanceId, () => this._updateConfigurationUnlocked(instanceId, updates));
  }

  async _updateConfigurationUnlocked(instanceId, updates = {}) {
    const dbInstance = await BotInstance.findOne({ instanceId });
    if (!dbInstance) throw new AppError('Bot instance not found', 404);

    const patch = {};
    const paramPatch = {};
    const has = (k) => updates[k] !== undefined && updates[k] !== null && updates[k] !== '';

    if (has('capital')) {
      const capital = Number(updates.capital);
      if (!Number.isFinite(capital) || capital <= 0) {
        throw new AppError('capital must be a positive finite number', 400);
      }
      patch.capitalAllocation = capital;
    }

    if (has('leverage')) {
      // PHASE Q — leverage previously had NO running-state guard (unlike
      // timeframe), meaning a RUNNING bot's leverage could change under a
      // live position without a restart. Closed here: leverage now follows
      // the same "pause/stop first" policy as timeframe/levels/sizing/targets.
      if (dbInstance.status === 'RUNNING') {
        throw new AppError('Cannot change leverage while the bot is RUNNING. Pause or stop it first.', 409);
      }
      const maxLeverage = env.RISK_MAX_LEVERAGE || 20;
      try {
        patch.leverage = validateLeverage(updates.leverage, maxLeverage);
      } catch (err) {
        throw new AppError(err.message, 400);
      }
    }

    if (has('timeframe')) {
      if (!Object.prototype.hasOwnProperty.call(TIMEFRAMES_MS, updates.timeframe)) {
        throw new AppError(`Invalid timeframe "${updates.timeframe}". Supported: ${Object.keys(TIMEFRAMES_MS).join(', ')}`, 400);
      }
      if (dbInstance.status === 'RUNNING') {
        throw new AppError('Cannot change timeframe while the bot is RUNNING. Pause or stop it first.', 409);
      }
      paramPatch.timeframe = updates.timeframe;
    }

    // PHASE D/E — canonical Top/Bottom Level. Accepts either a nested
    // `levels: {top, bottom}` object or flat `topLevel`/`bottomLevel` keys
    // (the latter kept for a gentler migration path from the old
    // parameters.topLevel/bottomLevel naming — new writes always land in
    // the canonical `levels` column either way, never back into `parameters`).
    if (has('levels') || has('topLevel') || has('bottomLevel')) {
      if (dbInstance.status === 'RUNNING') {
        throw new AppError('Cannot change levels while the bot is RUNNING. Pause or stop it first.', 409);
      }
      const rawLevels = has('levels')
        ? updates.levels
        : { top: updates.topLevel, bottom: updates.bottomLevel };
      try {
        patch.levels = validateLevels(rawLevels);
      } catch (err) {
        throw new AppError(err.message, 400);
      }
    }

    // PHASE F/G — Target Levels.
    if (has('targets')) {
      if (dbInstance.status === 'RUNNING') {
        throw new AppError('Cannot change targets while the bot is RUNNING. Pause or stop it first.', 409);
      }
      try {
        patch.targets = validateTargets(updates.targets) || [];
      } catch (err) {
        throw new AppError(err.message, 400);
      }
    }

    // PHASE H/I — Sizing Mode.
    if (has('sizing') || has('sizingMode')) {
      if (dbInstance.status === 'RUNNING') {
        throw new AppError('Cannot change sizing mode while the bot is RUNNING. Pause or stop it first.', 409);
      }
      const rawSizing = has('sizing')
        ? updates.sizing
        : { mode: updates.sizingMode, value: updates.lotValue };
      try {
        patch.sizing = validateSizing(rawSizing);
      } catch (err) {
        throw new AppError(err.message, 400);
      }
    }

    if (has('riskPct')) {
      const riskPct = Number(updates.riskPct);
      if (!Number.isFinite(riskPct) || riskPct < 0 || riskPct > 100) {
        throw new AppError('riskPct must be a number between 0 and 100', 400);
      }
      // NOTE: stored for display/config continuity only — RiskEngine's
      // actual enforcement uses riskSettings.maxPositionSizeUsd /
      // maxDailyLossUsd (see services/riskEngine/RiskEngine.js), not this
      // field. Not wiring riskPct into RiskEngine is intentional: that
      // would be a new feature, out of scope for Part 11.
      paramPatch.riskPct = riskPct;
    }

    for (const key of ['emaLength', 'breakoutLookback', 'minBodyRatio']) {
      if (has(key)) {
        const num = Number(updates[key]);
        if (!Number.isFinite(num) || num < 0) {
          throw new AppError(`${key} must be a non-negative number`, 400);
        }
        paramPatch[key] = num;
      }
    }

    if (Object.keys(paramPatch).length) {
      patch.parameters = Object.assign({}, dbInstance.parameters || {}, paramPatch);
    }

    if (!Object.keys(patch).length) {
      throw new AppError('No valid configuration fields supplied', 400);
    }

    Object.assign(dbInstance, patch);
    await dbInstance.save();
    await logger.info('BOT', `Bot instance configuration updated: ${instanceId} (${Object.keys(patch).join(', ')})`);
    this._broadcastStatus(dbInstance);
    return dbInstance;
  }

  /** Stops every RUNNING instance. Does NOT close any positions. */
  async stopAllInstances() {
    const running = await BotInstance.find({ status: 'RUNNING' });
    const results = [];
    for (const inst of running) {
      try {
        await this.stopInstance(inst.instanceId);
        results.push({ instanceId: inst.instanceId, ok: true });
      } catch (err) {
        results.push({ instanceId: inst.instanceId, ok: false, error: err.message });
      }
    }
    return results;
  }

  /**
   * Dispatches a normalized market update to all live instances watching that symbol.
   * Called by the market-data subscription wiring in server.js/sockets.
   *
   * Routing rule:
   *  - type: 'price'  -> symbol match only (unchanged; kept for backward
   *    compatibility / tests / any bot model that still wants raw ticks).
   *  - type: 'candle' -> symbol AND timeframe match. A canonical candle for
   *    one (symbol, timeframe) must only reach instances actually configured
   *    for that exact timeframe — never every instance on the symbol. This
   *    applies to any bot model, not just MODEL_001.
   */
  /**
   * PART A (multi-timeframe infra): true if `timeframe` is either this
   * instance's own entry/dispatch timeframe (dbInstance.parameters.timeframe,
   * unchanged, always present) or one of its model's declared
   * requiredTimeframes (read from the in-memory registeredModels entry —
   * the exact same object discoverModels() already validated and cached at
   * startup, so no extra DB round trip on the hot dispatch path). A model
   * that never sets requiredTimeframes (e.g. MODEL_001) yields exactly the
   * single-timeframe set that existed before Part A.
   */
  _instanceAcceptsTimeframe(dbInstance, timeframe) {
    if (dbInstance.parameters.timeframe === timeframe) return true;
    const modelDef = this.registeredModels.get(dbInstance.modelId);
    const required = (modelDef && modelDef.requiredTimeframes) || [];
    return required.some((entry) => entry.timeframe === timeframe);
  }

  async dispatchMarketData(marketUpdate) {
    for (const [instanceId, live] of this.liveInstances.entries()) {
      const dbInstance = await BotInstance.findOne({ instanceId });
      if (!dbInstance || dbInstance.status !== 'RUNNING' || dbInstance.symbol !== marketUpdate.symbol) continue;

      if (marketUpdate.type === 'candle') {
        // PART 13.1 -- PHASE D: dbInstance.status === 'RUNNING' here is only
        // reachable after onStart succeeded, which now requires an
        // explicit, valid timeframe (validators.js). No silent default.
        //
        // PART A (multi-timeframe infra): a candle now reaches this instance
        // if it matches EITHER the instance's own entry/dispatch timeframe
        // OR one of its model's declared requiredTimeframes (see
        // BotModelMetadata.requiredTimeframes / discoverModels above). For
        // any model that declares no requiredTimeframes (e.g. MODEL_001)
        // this set has exactly one member — byte-identical to the old
        // exact-match check.
        if (!this._instanceAcceptsTimeframe(dbInstance, marketUpdate.timeframe)) continue;
      }

      const Position = require('../../models/Position');
      const positionContext = await Position.findOne({
        instanceId, symbol: dbInstance.symbol, status: 'OPEN',
      }).lean();

      // Real WIN/LOSS detection (additive, generic): if this instance had
      // an open position last tick and now has none, the position just
      // closed. Look up its authoritative Trade record (realizedPnl,
      // closeReason — the exact same record PaperEngine/LiveEngine already
      // create on every close, see Trade.js) and hand it to the model via
      // an optional hook, exactly once per closed position. A model that
      // doesn't define onPositionClosed is entirely unaffected (MODEL_001).
      //
      // Position-close vs Trade-create race: PaperEngine.closePosition
      // writes Position + Trade inside one Mongo transaction, but
      // LiveEngine.closePosition does NOT — it saves the Position (making
      // it externally invisible as OPEN) BEFORE creating the Trade record.
      // A single immediate Trade.findOne() right after detecting the
      // Position's disappearance can therefore race a real, in-flight
      // Trade write and find nothing. Instead of trusting that one query,
      // an unresolved lookup is deferred onto `live.pendingClosedTradeLookup`
      // and retried on every subsequent tick for this instance (bounded by
      // both an attempt count and a wall-clock timeout) until the Trade
      // record is found — or, if it genuinely never appears, the miss is
      // logged loudly rather than silently dropped.
      if (typeof live.modelInstance.onPositionClosed === 'function') {
        if (live.wasPositionOpen && !positionContext && !live.pendingClosedTradeLookup) {
          // live.lastOpenPositionId is the _id of the exact Position document
          // that was OPEN on the previous tick (captured below, every tick,
          // before it can disappear). This is the strongest existing
          // correlation to the Trade that will be created for this close —
          // Trade.position is a direct ObjectId ref to that same Position
          // (see models/Trade.js) — so the lookup below can identify the
          // exact Trade instead of guessing via symbol + newest closedAt.
          live.pendingClosedTradeLookup = {
            positionId: live.lastOpenPositionId,
            symbol: dbInstance.symbol,
            attempts: 0,
            sinceTs: Date.now(),
          };
        }

        if (live.pendingClosedTradeLookup) {
          const pending = live.pendingClosedTradeLookup;
          pending.attempts += 1;

          const Trade = require('../../models/Trade');
          // Exact correlation: the Trade belonging to THIS closed position,
          // not merely "the newest Trade for this instance/symbol" (which
          // could still be an older, already-processed Trade if this one
          // hasn't been written yet — the exact race this part fixes).
          // instanceId/environment are preserved as defense-in-depth so a
          // PAPER Trade can never be matched while running LIVE (or vice
          // versa); symbol is kept only as an extra sanity filter, never as
          // the primary identity, per the "symbol is not enough" rule.
          const closedTrade = pending.positionId
            ? await Trade.findOne({
              position: pending.positionId,
              instanceId,
              environment: dbInstance.environment,
              symbol: pending.symbol,
            }).lean()
            : null;

          if (closedTrade) {
            live.pendingClosedTradeLookup = null;
            try {
              await live.modelInstance.onPositionClosed(closedTrade);
            } catch (err) {
              await logger.error('BOT', `Bot instance ${instanceId} errored in onPositionClosed: ${err.message}`);
            }
          } else if (!pending.positionId
                     || pending.attempts >= BotManager.CLOSED_TRADE_LOOKUP_MAX_ATTEMPTS
                     || Date.now() - pending.sinceTs >= BotManager.CLOSED_TRADE_LOOKUP_MAX_WAIT_MS) {
            await logger.error(
              'BOT',
              `Bot instance ${instanceId}: detected a closed position for ${pending.symbol} ` +
              `(position=${pending.positionId || 'unknown'}) but no matching Trade record appeared after ` +
              `${pending.attempts} attempts / ${Date.now() - pending.sinceTs}ms — ` +
              `giving up. This trade's WIN/LOSS outcome was NOT applied to the consecutive-loss safety counter.`
            );
            live.pendingClosedTradeLookup = null;
          }
          // else: still unresolved and within bounds — retried again on the next tick.
        }
      }
      live.wasPositionOpen = Boolean(positionContext);
      live.lastOpenPositionId = positionContext ? positionContext._id : null;

      try {
        await live.modelInstance.onMarketData(marketUpdate, positionContext || null);
      } catch (err) {
        dbInstance.status = 'ERROR';
        dbInstance.lastError = err.message;
        await dbInstance.save();
        await logger.error('BOT', `Bot instance ${instanceId} errored on market data: ${err.message}`);
        this._broadcastStatus(dbInstance);
      }
    }
  }

  async _handleModelEvent(instanceId, event) {
    const dbInstance = await BotInstance.findOne({ instanceId });
    if (!dbInstance) return;

    if (event.kind === 'StrategyEvent') {
      await StrategyEvent.create({
        instanceId, modelId: dbInstance.modelId, symbol: dbInstance.symbol,
        eventType: event.eventType, payload: event.payload, at: new Date(event.at),
      });
      dbInstance.lastSignalAt = new Date();
      await dbInstance.save();
      if (this.ioRef) this.ioRef.to('room:bots').emit('bot:event', { instanceId, ...event });

      // NOVA TRADE -- PART 8: real MODEL_001 decisions (see Model001._emitDecision)
      // additionally get a dedicated, per-bot socket event. Unlike the generic
      // bot:event above (broadcast to the shared room:bots for the fleet page),
      // bot:decision is sent ONLY to bot:<instanceId> — the bot-detail page's
      // own room (see sockets/index.js `subscribe:bot`) — per the Part 8
      // requirement that decisions are never broadcast globally. This is the
      // sole source of truth the Decision Engine UI should treat as authoritative.
      if (event.eventType === 'DECISION' && this.ioRef) {
        this.ioRef.to(`bot:${instanceId}`).emit('bot:decision', {
          instanceId,
          modelId: dbInstance.modelId,
          ...event.payload,
        });
      }
    } else if (event.kind === 'StatusUpdate') {
      if (this.ioRef) this.ioRef.to('room:bots').emit('bot:event', { instanceId, ...event });
    } else if (event.kind === 'Error') {
      dbInstance.status = 'ERROR';
      dbInstance.lastError = event.message;
      await dbInstance.save();
      await logger.error('BOT', `Bot instance ${instanceId} reported error: ${event.message}`, event.meta);
      this._broadcastStatus(dbInstance);
    }
  }

  /**
   * Receives a TradeCommand emitted by a running Bot Model. Validates schema,
   * forwards to RiskEngine, and on approval forwards to ExecutionRouter.
   * This is the ONLY path a Bot Model has to cause a trade.
   */
  async _handleTradeCommand(instanceId, rawCommand) {
    const { valid, errors, normalized } = validateTradeCommand({ ...rawCommand, instanceId });
    if (!valid) {
      await logger.warn('BOT', `Malformed TradeCommand from instance ${instanceId} rejected: ${errors.join('; ')}`);
      return { approved: false, reason: `Malformed command: ${errors.join('; ')}` };
    }

    if (normalized.action === 'NO_ACTION') {
      return { approved: true, reason: 'NO_ACTION - no execution required', metadata: {} };
    }

    const riskResult = await riskEngine.evaluate(normalized);
    if (!riskResult.approved) {
      if (this.ioRef) {
        this.ioRef.to('room:bots').emit('bot:event', {
          instanceId, kind: 'StatusUpdate', status: 'RISK_REJECTED', detail: riskResult.reason,
        });
        // PART 14 -- PHASE D: risk:rejected telemetry. Scoped to the bot's
        // own room, matching the existing bot:decision/bot:execution
        // precedent (authoritative per-bot state is never broadcast to
        // room:bots). Payload carries only fields RiskEngine actually
        // computed -- nothing fabricated.
        this.ioRef.to(`bot:${instanceId}`).emit('risk:rejected', {
          instanceId,
          commandId: normalized.commandId,
          action: normalized.action,
          symbol: normalized.symbol,
          reason: riskResult.reason,
          metadata: riskResult.metadata,
        });
      }
      return riskResult;
    }

    const dbInstance = await BotInstance.findOne({ instanceId });
    try {
      const executionResult = await executionRouter.route(normalized, dbInstance);
      if (this.ioRef) this.ioRef.to('room:bots').emit('bot:event', {
        instanceId, kind: 'StatusUpdate', status: 'EXECUTED', detail: normalized.action,
      });
      await this._emitExecutionUpdate(instanceId, normalized);
      this._emitExecutionTelemetry(instanceId, normalized, executionResult);
      return { ...riskResult, execution: executionResult };
    } catch (err) {
      await logger.error('BOT', `Execution failed for command ${normalized.commandId}: ${err.message}`);
      // PART 14 -- PHASE D: an execution that fails strictly AFTER RiskEngine
      // approval (e.g. a PaperEngine balance/fee check, a rejected Delta
      // order) was previously silent to the UI beyond this log line --
      // Decision History would show BUY, Trade/Position would stay empty,
      // and nothing told the operator why. trade:rejected makes that
      // failure visible in real time, scoped to the bot's own room.
      if (this.ioRef) {
        this.ioRef.to(`bot:${instanceId}`).emit('trade:rejected', {
          instanceId,
          commandId: normalized.commandId,
          action: normalized.action,
          symbol: normalized.symbol,
          reason: err.message,
        });
      }
      return { ...riskResult, execution: null, executionError: err.message };
    }
  }

  /**
   * PART 14 -- PHASE D: position:opened / position:closed / trade:created
   * telemetry. Derived strictly from the real Position document
   * ExecutionRouter/PaperEngine/LiveEngine just returned (and, for a
   * close, the resulting Trade document re-read from Mongo -- a Trade only
   * ever exists once a position is closed, see Trade.js) -- nothing here
   * recomputes or invents a value. Scoped to the bot's own room, same as
   * bot:execution. Reuses the existing Socket.IO server (this.ioRef); no
   * second socket server, no duplicate emit path.
   */
  _emitExecutionTelemetry(instanceId, normalizedCommand, executionResult) {
    if (!this.ioRef || !executionResult) return;
    const room = `bot:${instanceId}`;

    if ((normalizedCommand.action === 'LONG' || normalizedCommand.action === 'SHORT') && executionResult.position) {
      this.ioRef.to(room).emit('position:opened', { instanceId, position: executionResult.position });
    }

    if (normalizedCommand.action === 'CLOSE' && executionResult.position) {
      this.ioRef.to(room).emit('position:closed', { instanceId, position: executionResult.position });

      const Trade = require('../../models/Trade');
      Trade.findOne({ instanceId, environment: normalizedCommand.environment })
        .sort({ closedAt: -1 })
        .lean()
        .then((trade) => {
          if (trade && this.ioRef) {
            this.ioRef.to(room).emit('trade:created', { instanceId, trade });
          }
        })
        .catch((err) => logger.error('BOT', `Failed to emit trade:created for ${instanceId}: ${err.message}`));
    }
  }

  /**
   * NOVA TRADE -- PART 9: the ONLY place that emits authoritative
   * position/trade execution state to the bot-detail page. Called strictly
   * AFTER ExecutionRouter has successfully routed a command to
   * PaperEngine/LiveEngine -- never from a decision alone, never from
   * RiskEngine rejection (see the try/catch in _handleTradeCommand, which
   * only reaches this call inside the success path). Re-reads both
   * collections fresh from the database rather than trusting any
   * in-memory result shape, so the emitted payload is guaranteed to match
   * what a page refresh would show (Test J/K parity).
   *
   * Emitted only to the bot's own room (`bot:<instanceId>`), matching the
   * existing bot:decision precedent -- never broadcast to room:bots.
   */
  async _emitExecutionUpdate(instanceId, normalizedCommand) {
    if (!this.ioRef) return;
    try {
      const Position = require('../../models/Position');
      const Trade = require('../../models/Trade');

      const position = await Position.findOne({
        instanceId, environment: normalizedCommand.environment, status: 'OPEN',
      }).lean();

      // A trade record only exists once a position has been closed. Only
      // look one up when the command was a CLOSE, to avoid re-sending a
      // stale previously-closed trade on every LONG/SHORT open. Scoped by
      // environment too, same as the Position lookup above -- an instance
      // must never surface a trade from the other environment.
      let trade = null;
      if (normalizedCommand.action === 'CLOSE') {
        trade = await Trade.findOne({
          instanceId, environment: normalizedCommand.environment,
        }).sort({ closedAt: -1 }).lean();
      }

      this.ioRef.to(`bot:${instanceId}`).emit('bot:execution', {
        instanceId,
        action: normalizedCommand.action,
        position: position || null,
        trade: trade || null,
      });
    } catch (err) {
      await logger.error('BOT', `Failed to emit bot:execution for ${instanceId}: ${err.message}`);
    }
  }

  _broadcastStatus(dbInstance) {
    if (this.ioRef) {
      this.ioRef.to('room:bots').emit('bot:status', {
        instanceId: dbInstance.instanceId,
        status: dbInstance.status,
        lastError: dbInstance.lastError,
      });
    }
  }
}

module.exports = new BotManager();
