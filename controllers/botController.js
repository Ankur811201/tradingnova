const BotInstance = require('../models/BotInstance');
const Trade = require('../models/Trade');
const Position = require('../models/Position');
const Signal = require('../models/Signal');
const StrategyEvent = require('../models/StrategyEvent');
const { computePerformance, computeTodayProfit } = require('../utils/performance');
const { buildTradeStory } = require('../utils/tradeStory');
const botManager = require('../services/botManager/BotManager');
// Single source of truth for MODEL_002 reason-code -> human-readable text —
// shared with the live formatter in public/js/bot-detail-ws.js (loaded
// browser-side via <script>, see views/bot-detail.ejs). Required here
// (Node/CommonJS side of the same UMD module) so server-rendered Decision
// History uses the exact same wording as live decisions after a page
// refresh, never a second/duplicate map.
const { formatModel002Reason } = require('../public/js/renderers/model002-reason-map.js');

// NOVA TRADE -- PART 9: real position/PnL/trade-history/performance.
//
// Performance metrics need every closed Trade for this instance, not just
// the most recent 50 shown in the Trade History tab, so it is queried
// separately (still scoped to instanceId + the bot's own environment so
// PAPER and LIVE trades can never be mixed together -- see Position/Trade
// schemas, both of which carry `environment`). PERFORMANCE_TRADES_LIMIT is
// a generous safety cap, not a product limit: a single bot instance is not
// expected to accumulate more closed trades than this within the lifetime
// of the app, but an unbounded query is avoided regardless.
const PERFORMANCE_TRADES_LIMIT = 5000;

exports.renderBotDetail = async (req, res, next) => {
  try {
    const { instanceId } = req.params;

    // Load base metadata
    const bot = await BotInstance.findOne({ instanceId }).lean();
    if (!bot) {
      return res.status(404).render('404', { title: 'Bot Instance Not Found' });
    }

    // Fetch initial historical/execution records in parallel.
    //
    // NOVA TRADE -- PART 8: `Signal` is kept here only for template
    // backward-compatibility (it has zero writers post-Part-7, see
    // services/BotEngineManager.js, so `signals` is always empty in
    // practice). The real Decision Engine / Decision History data now comes
    // from `StrategyEvent` (eventType: 'DECISION'), written exclusively by
    // MODEL_001 via BotManager -- see bot-models/model-001/Model001.js and
    // services/botManager/BotManager.js.
    //
    // NOVA TRADE -- PART 9: `currentPosition` and `perfTrades` are the new
    // authoritative execution-state sources. `currentPosition` replaces the
    // legacy `botEngineManager.getInstanceRuntimeState(instanceId)` lookup
    // (removed below -- see Phase J of the Part 9 prompt); it is a real
    // Position document (or null) written exclusively by
    // PaperEngine/LiveEngine via ExecutionRouter. `perfTrades` is every
    // closed Trade for this instance, used to compute Total Profit/Win
    // Rate/Profit Factor/Today's Profit -- never derived from the legacy
    // runtime or from decision/signal data.
    const [trades, signals, decisionEvents, currentPosition, perfTrades] = await Promise.all([
      Trade.find({ instanceId, environment: bot.environment }).sort({ createdAt: -1 }).limit(50).lean(),
      Signal.find({ instanceId }).sort({ createdAt: -1 }).limit(50).lean(),
      StrategyEvent.find({ instanceId, eventType: 'DECISION' }).sort({ at: -1 }).limit(200).lean(),
      Position.findOne({ instanceId, environment: bot.environment, status: 'OPEN' }).lean(),
      Trade.find({ instanceId, environment: bot.environment })
        .sort({ closedAt: -1 })
        .limit(PERFORMANCE_TRADES_LIMIT)
        .lean(),
    ]);

    const perf = computePerformance(perfTrades);
    const todayProfit = computeTodayProfit(perfTrades);

    // Current PnL / ROI-on-margin: both are real derived ratios of two
    // authoritative Position fields (unrealizedPnl, margin) -- not an
    // invented value. margin is guaranteed > 0 by PaperEngine/LiveEngine
    // (computeMargin throws on non-positive leverage), so this is safe.
    let currentPositionView = null;
    if (currentPosition) {
      currentPositionView = {
        ...currentPosition,
        pnlPct: currentPosition.margin
          ? (currentPosition.unrealizedPnl / currentPosition.margin) * 100
          : null,
      };
    }

    res.render('bot-detail', {
      title: `Nova Trade | ${bot.name} (${bot.modelId})`,
      bot,
      currentPosition: currentPositionView,
      // PART 11 — PHASE F/O: real, in-memory MODEL_001 readiness at render
      // time (HYDRATING/READY/INSUFFICIENT_HISTORY/ERROR/NOT_RUNNING), so a
      // hard page refresh shows the true state immediately instead of a
      // generic "Monitoring" placeholder until the next live socket event.
      strategyReadiness: botManager.getReadiness(bot.instanceId),
      // NOVA TRADE -- PART 9: named `performanceData`, NOT `performance`.
      // EJS compiles templates with `with(locals){...}`, and both Node and
      // browser environments expose a global `performance` (the Performance
      // Timing API). A local named `performance` would only shadow that
      // global when actually present in `locals`; any render call that
      // forgets to pass it (as several existing Part 7/8 tests do) would
      // silently fall through to the global object instead of being
      // `undefined`, defeating every `typeof performance !== 'undefined'`
      // guard in the template. Renaming sidesteps the collision entirely.
      performanceData: { ...perf, todayProfit },
      initialTrades: trades,
      initialSignals: signals,
      // Newest first (as queried) for the Decision History tab; the most
      // recent one (decisionEvents[0]) is also the Decision Engine panel's
      // initial state.
      initialDecisions: decisionEvents,
      initialDecision: decisionEvents.length ? decisionEvents[0] : null,
      // NOVA TRADE -- PART 15 PHASE B/STEP 5: real "Live Trade Story"
      // timeline, replacing the dead `Signal`-backed one. Built purely from
      // `trades`, `decisionEvents`, and `currentPosition` -- all already
      // queried above for other panels -- so this adds zero new Mongo
      // queries (see utils/tradeStory.js).
      initialTradeStory: buildTradeStory({ decisionEvents, trades, currentPosition: currentPositionView }),
      // Passed as a function value (not pre-applied to the data) so the
      // template can gate it to MODEL_002 only — MODEL_001's own `reason`
      // strings are already human-readable sentences and must render
      // unchanged (see views/bot-detail.ejs Decision History).
      formatModel002Reason,
    });
  } catch (error) {
    next(error);
  }
};
