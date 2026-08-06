'use strict';

const botManager = require('../services/botManager/BotManager');
const BotInstance = require('../models/BotInstance');
const Candle = require('../models/Candle');
const { success, AppError } = require('../utils/apiResponse');
const { getMarketDataProvider } = require('../services/marketData');
const botEngineManager = require('../services/BotEngineManager');

const CANDLES_DEFAULT_LIMIT = 300;
const CANDLES_MAX_LIMIT = 500;

/**
 * Computes a lightweight, request-time "trading readiness" view without
 * changing the persisted BotInstance.status contract (still RUNNING/PAUSED/
 * STOPPED/ERROR only). A RUNNING bot with disconnected/stale market data is
 * a real, common state — the UI should be able to show that plainly instead
 * of implying the bot is actively trading. See root README "Part 4 audit
 * findings" for why this was added.
 */
function attachReadiness(instance) {
  const provider = getMarketDataProvider();
  const status = provider.getConnectionStatus();
  const marketDataConnected = Boolean(status.connected);
  const marketDataFresh = marketDataConnected && provider.isDataFresh(instance.symbol);

  let tradingReadiness = 'BLOCKED';
  if (instance.status === 'RUNNING' && marketDataConnected && marketDataFresh) {
    tradingReadiness = 'READY';
  } else if (instance.status !== 'RUNNING') {
    tradingReadiness = 'NOT_RUNNING';
  }

  // PART 11 — PHASE F: real, in-memory MODEL_001 strategy readiness
  // (HYDRATING / READY / INSUFFICIENT_HISTORY / ERROR / NOT_RUNNING) from
  // BotManager, distinct from tradingReadiness above (which only reflects
  // market-data connectivity). A bot can be `status: RUNNING` and
  // `tradingReadiness: READY` while still `strategyReadiness.state:
  // INSUFFICIENT_HISTORY` if it hasn't accumulated 50 closed candles yet.
  const strategyReadiness = botManager.getReadiness(instance.instanceId);

  return Object.assign({}, instance, {
    marketData: {
      connected: marketDataConnected,
      fresh: marketDataFresh,
      providerName: status.providerName,
    },
    tradingReadiness: tradingReadiness,
    strategyReadiness: strategyReadiness,
  });
}

async function listInstances(req, res, next) {
  try {
    const instances = await BotInstance.find({ user: req.session.userId }).sort({ createdAt: -1 }).lean();
    return success(res, instances.map(attachReadiness));
  } catch (err) {
    return next(err);
  }
}

async function getInstance(req, res, next) {
  try {
    const instance = await BotInstance.findOne({ instanceId: req.params.instanceId, user: req.session.userId }).lean();
    if (!instance) throw new AppError('Bot instance not found', 404);
    return success(res, attachReadiness(instance));
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/bot-instances/:instanceId/candles?limit=300
 *
 * Resolves instanceId -> BotInstance -> (symbol, timeframe), then reads
 * real, previously-persisted candles for that exact pair from the Candle
 * collection (see services/marketData/CandlePersistenceService.js). Never
 * fabricates data: if nothing has been persisted yet, returns an empty array.
 */
async function getCandles(req, res, next) {
  try {
    const instance = await BotInstance.findOne({
      instanceId: req.params.instanceId,
      user: req.session.userId,
    }).lean();
    if (!instance) throw new AppError('Bot instance not found', 404);

    const symbol = instance.symbol;
    const timeframe = instance.parameters && instance.parameters.timeframe;
    // PART 13.1 -- PHASE D: an existing bot with no configured timeframe
    // must not silently be shown/queried as if it were on the model's
    // default timeframe (see bot-models/model-001/validators.js, which
    // enforces the same rule at Start). Surface this as an explicit
    // configuration error instead of guessing.
    if (!timeframe) {
      throw new AppError('This bot has no configured timeframe. Set a timeframe in the bot configuration.', 409);
    }

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = CANDLES_DEFAULT_LIMIT;
    limit = Math.min(limit, CANDLES_MAX_LIMIT);

    // Newest-first for the limit to make sense, then reversed to oldest -> newest for the chart.
    const docs = await Candle.find({ symbol, timeframe })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    const candles = docs
      .reverse()
      .map((c) => ({
        time: Math.floor(c.timestamp / 1000), // Lightweight Charts expects seconds, not ms
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        closed: c.closed,
      }));

    return success(res, {
      instanceId: instance.instanceId,
      symbol,
      timeframe,
      count: candles.length,
      candles,
    });
  } catch (err) {
    return next(err);
  }
}

async function createInstance(req, res, next) {
  try {
    const {
      name, modelId, symbol, environment, parameters, capitalAllocation, leverage, riskSettings,
      // PART 13 -- PHASE C/O: canonical configuration contract fields,
      // accepted directly from the Create Bot form. All optional — absent
      // means "use schema defaults" (levels null/null, sizing CAPITAL,
      // targets []), which is identical to a pre-Part-13 bot.
      sizing, levels, targets,
    } = req.body;
    if (!modelId || !symbol || !environment || !capitalAllocation) {
      throw new AppError('modelId, symbol, environment, capitalAllocation are required', 400);
    }
    const instance = await botManager.createInstance({
      userId: req.session.userId,
      name,
      modelId, symbol, environment,
      parameters: parameters || {},
      capitalAllocation: Number(capitalAllocation),
      leverage: leverage ? Number(leverage) : 1,
      riskSettings: riskSettings || {},
      sizing: sizing || null,
      levels: levels || null,
      targets: targets || null,
    });
    return success(res, instance, 'Bot instance created', 201);
  } catch (err) {
    return next(err);
  }
}

async function assertOwnership(instanceId, userId) {
  const instance = await BotInstance.findOne({ instanceId });
  if (!instance) throw new AppError('Bot instance not found', 404);
  if (String(instance.user) !== userId) throw new AppError('Forbidden', 403);
  return instance;
}

async function startInstance(req, res, next) {
  try {
    const instanceId = req.params.instanceId;

    await assertOwnership(instanceId, req.session.userId);

    // Existing bot system
    const instance = await botManager.startInstance(instanceId);

    // Single bot live detail engine
    await botEngineManager.startInstance(instanceId);

    return success(res, instance, 'Bot instance started');

  } catch (err) {
    return next(err);
  }
}

async function pauseInstance(req, res, next) {
  try {
    await assertOwnership(req.params.instanceId, req.session.userId);
    const instance = await botManager.pauseInstance(req.params.instanceId);

    // Part 7: BotEngineManager has zero trading authority regardless of its
    // own lifecycle state, but its telemetry loop (bot:tick/bot:thinking)
    // must also stop once the authoritative BotManager instance is no
    // longer RUNNING, so the bot-detail UI doesn't keep "thinking" for a
    // paused bot. Best-effort: never let legacy cleanup fail the request.
    try {
      await botEngineManager.stopInstance(req.params.instanceId);
    } catch (legacyErr) {
      console.warn('[LEGACY] stopInstance on pause failed (non-fatal):', legacyErr.message);
    }

    return success(res, instance, 'Bot instance paused');
  } catch (err) {
    return next(err);
  }
}

async function stopInstance(req, res, next) {
  try {
    await assertOwnership(req.params.instanceId, req.session.userId);
    const instance = await botManager.stopInstance(req.params.instanceId);

    // Part 7: keep legacy telemetry lifecycle in sync (see pauseInstance).
    try {
      await botEngineManager.stopInstance(req.params.instanceId);
    } catch (legacyErr) {
      console.warn('[LEGACY] stopInstance on stop failed (non-fatal):', legacyErr.message);
    }

    return success(res, instance, 'Bot instance stopped');
  } catch (err) {
    return next(err);
  }
}

/**
 * PART 11 — PHASE M: Save Configuration. Previously the frontend posted to
 * a route (`/api/bot/:instanceId/config`) that did not exist anywhere in
 * routes/, so every "Save Configuration" click silently 404'd. This is the
 * real endpoint; see BotManager.updateConfiguration for validation rules.
 */
async function updateConfig(req, res, next) {
  try {
    await assertOwnership(req.params.instanceId, req.session.userId);
    const instance = await botManager.updateConfiguration(req.params.instanceId, req.body || {});
    return success(res, instance, 'Configuration saved');
  } catch (err) {
    return next(err);
  }
}

async function restartInstance(req, res, next) {
  try {
    await assertOwnership(req.params.instanceId, req.session.userId);
    const instance = await botManager.restartInstance(req.params.instanceId);

    // Part 7: keep legacy telemetry lifecycle in sync (see pauseInstance).
    try {
      await botEngineManager.stopInstance(req.params.instanceId);
      await botEngineManager.startInstance(req.params.instanceId);
    } catch (legacyErr) {
      console.warn('[LEGACY] restart sync failed (non-fatal):', legacyErr.message);
    }

    return success(res, instance, 'Bot instance restarted');
  } catch (err) {
    return next(err);
  }
}
async function deleteInstance(req, res) {

    const { instanceId } = req.params;

    try {

        // Part 7: make sure no stale legacy telemetry runtime entry (and its
        // socket room emissions) survives the authoritative bot being deleted.
        try {
          await botEngineManager.stopInstance(instanceId);
        } catch (legacyErr) {
          console.warn('[LEGACY] stopInstance on delete failed (non-fatal):', legacyErr.message);
        }

        await botManager.deleteInstance(instanceId);

        res.json({
            success: true,
            message: "Bot deleted successfully"
        });
        console.log("Delete request:", req.params.instanceId);

    } catch (err) {

        res.status(400).json({
            success: false,
            message: err.message
        });

    }

}

module.exports = {
  listInstances, getInstance, getCandles, createInstance,
  startInstance, pauseInstance, stopInstance, restartInstance, updateConfig, deleteInstance,
};
