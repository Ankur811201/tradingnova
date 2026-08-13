'use strict';

const http = require('http');
const { env, validateEnv } = require('./config/env');
const { connectDatabase } = require('./config/database');
const { createApp } = require('./app');
const { initSockets } = require('./sockets');
const logger = require('./utils/logger');
const botManager = require('./services/botManager/BotManager');
const socketBus = require('./utils/socketBus');
const paperEngine = require('./services/paperEngine/PaperEngine');
const { getMarketDataProvider } = require('./services/marketData');
const SystemSetting = require('./models/SystemSetting');
const botEngineManager = require('./services/BotEngineManager');
const candlePersistenceService = require('./services/marketData/CandlePersistenceService');


async function main() {
  validateEnv();

  await connectDatabase();
  await logger.info('SYSTEM', 'MongoDB connected');

  // Ensure the global safety singleton exists, defaulting to the safest state.
  await SystemSetting.getSingleton(env.LIVE_TRADING_DEFAULT_ENABLED);

  const { app, sessionMiddleware } = createApp();
  const httpServer = http.createServer(app);

  const io = initSockets(httpServer, sessionMiddleware);
  logger.attachSocketServer(io);
  botManager.attachSocketServer(io);
  candlePersistenceService.attachSocketServer(io);
  socketBus.attachIO(io);
  botEngineManager.init(io);

  await botManager.discoverModels();

  // Startup recovery: reconcile MongoDB's RUNNING BotInstance records
  // against this freshly-started process's empty liveInstances Map. An
  // ungraceful termination of a prior process (crash, deploy, OOM) never
  // demotes a RUNNING bot to STOPPED — only a graceful stop does that —
  // so without this, such a bot's status field (and every UI reading it)
  // keeps reporting RUNNING while it silently never receives another
  // candle. Must complete before market-data subscriptions are wired up
  // below, so hydration is always finished before any live dispatch could
  // possibly reach a recovered instance.
  const recovery = await botManager.recoverRunningInstances();
  if (recovery.length) {
    await logger.info('BOT', `Startup recovery: ${recovery.filter((r) => r.recovered).length}/${recovery.length} RUNNING bot instance(s) recovered`);
  }

  // Wire market-data price updates -> paper P&L refresh + bot dispatch + socket broadcast.
  // Only subscribes to symbols that are actually referenced by an existing bot
  // instance or that the allowed-symbols list declares, to avoid unbounded
  // polling of arbitrary symbols.
const provider = getMarketDataProvider();

for (const symbol of env.RISK_ALLOWED_SYMBOLS) {
  try {
    provider.subscribePrice(symbol, async ({ price, timestamp }) => {

      // =====================================================
      // 1. Broadcast live market data to frontend
      // =====================================================

      io.to('room:market').emit('market:price', {
        symbol,
        price,
        timestamp
      });

      io.to('room:market').emit(
        'market:status',
        provider.getConnectionStatus()
      );


      // =====================================================
      // 2. Update paper trading positions
      // =====================================================

      try {
        await paperEngine.refreshUnrealizedForSymbol(
          symbol,
          price
        );
      } catch (err) {
        await logger.error(
          'TRADING',
          `refreshUnrealizedForSymbol failed for ${symbol}: ${err.message}`
        );
      }


      // =====================================================
      // 3. Persist real candles (symbol/timeframe from BotInstance) —
      //    CandlePersistenceService remains the ONE canonical candle
      //    builder: MongoDB, the chart (via its own Socket.IO broadcast
      //    inside the service), AND the real MODEL_001 trading pipeline
      //    (step 4 below) all now read the exact same candle object.
      // =====================================================

      let candleEvents = [];
      try {
        candleEvents = await candlePersistenceService.processTick(
          symbol,
          price,
          timestamp
        );
      } catch (err) {
        await logger.error(
          'CANDLE',
          `candlePersistenceService.processTick failed for ${symbol}: ${err.message}`
        );
      }


      // =====================================================
      // 4. Dispatch CLOSED canonical candles to BotManager (MODEL_001, etc)
      //
      //    Only closed=true events are forwarded here — a still-forming
      //    candle is for the chart/MongoDB only (already handled inside
      //    candlePersistenceService.processTick above) and must never reach
      //    a bot model's strategy evaluation.
      //
      //    Raw price ticks are intentionally no longer dispatched to
      //    BotManager in production. The type:'price' input on
      //    BotManager.dispatchMarketData / Model001 still exists and is
      //    left in place for tests and backward compatibility only — see
      //    bot-models/model-001/candleAggregator.js.
      // =====================================================

      for (const event of candleEvents) {
        if (!event.candle.closed) continue;

        console.log(
          `[CANDLE] ${event.symbol} ${event.timeframe} closed timestamp=${event.candle.timestamp}`
        );
        console.log(
          `[BOT] Dispatching canonical ${event.symbol} ${event.timeframe} candle to BotManager`
        );

        try {
          await botManager.dispatchMarketData({
            type: 'candle',
            symbol: event.symbol,
            timeframe: event.timeframe,
            timestamp: event.candle.timestamp,
            data: {
              timestamp: event.candle.timestamp,
              open: event.candle.open,
              high: event.candle.high,
              low: event.candle.low,
              close: event.candle.close,
              volume: event.candle.volume,
              closed: event.candle.closed,
            },
          });
        } catch (err) {
          await logger.error(
            'BOT',
            `dispatchMarketData (candle) failed for ${event.symbol} ${event.timeframe}: ${err.message}`
          );
        }
      }


      // =====================================================
      // 5. Single Bot Engine — live tick + decision engine (legacy,
      //    unchanged in Part 6 — still driven by raw ticks)
      // =====================================================

      try {
        await botEngineManager.processPriceTick(
          symbol,
          {
            price,
            timestamp
          }
        );
      } catch (err) {
        await logger.error(
          'BOT',
          `BotEngineManager processPriceTick failed for ${symbol}: ${err.message}`
        );
      }

    });

  } catch (err) {

    // Expected when market provider isn't configured
    logger.warn(
      'MARKET_DATA',
      `Could not subscribe to ${symbol}: ${err.message}`
    );
  }
}

  httpServer.listen(env.PORT, () => {
    logger.info('SYSTEM', `Nova Trade server listening on port ${env.PORT} (${env.NODE_ENV})`);
    console.log(`\n  Nova Trade backend running at http://localhost:${env.PORT}`);
    console.log(`  Health check:            http://localhost:${env.PORT}/api/health`);
    console.log(`  Delta configured:        ${env.DELTA_CONFIGURED}`);
    console.log(`  Market data provider:    ${env.MARKET_DATA_PROVIDER}`);
    console.log(`  Live trading default:    ${env.LIVE_TRADING_DEFAULT_ENABLED}\n`);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('SYSTEM', `Unhandled promise rejection: ${reason instanceof Error ? reason.message : reason}`, {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
  process.on('uncaughtException', (err) => {
    logger.error('SYSTEM', `Uncaught exception: ${err.message}`, { stack: err.stack });
  });

  const shutdown = async (signal) => {
    await logger.info('SYSTEM', `Received ${signal}, shutting down gracefully`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
