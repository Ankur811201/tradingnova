const EventEmitter = require('events');
const BotInstance = require('../models/BotInstance');
const TechnicalAnalysisService = require('./TechnicalAnalysisService');
const PositionManager = require('./PositionManager');

// =============================================================
// NOVA TRADE -- PART 7: LEGACY TRADING AUTHORITY REMOVED
//
// BotEngineManager is now TELEMETRY/UI-COMPATIBILITY ONLY for the
// bot-detail page (bot:tick, bot:thinking, bot:log). It must NEVER
// again create/mutate authoritative trading state:
//   - no Trade documents
//   - no Position documents
//   - no authoritative Signal documents
//   - no calls into RiskEngine / ExecutionRouter / PaperEngine / LiveEngine
//   - no mutation of instance.currentPosition into a real position
//
// The ONLY path that may create a bot trade or position is:
//   MODEL_001 -> submitTradeCommand() -> BotManager._handleTradeCommand()
//   -> RiskEngine -> ExecutionRouter -> PaperEngine/LiveEngine
//   (see services/botManager/BotManager.js)
//
// The Signal and Trade models are intentionally no longer required
// here -- this file has no legitimate reason to touch either collection.
// =============================================================

class BotEngineManager extends EventEmitter {
  constructor() {
    super();

    this.activeInstances = new Map();
    this.io = null;
  }

  // =========================================================
  // INITIALIZE SOCKET.IO
  // =========================================================

  init(io) {
    this.io = io;
    console.log('[BotEngineManager] Socket.IO initialized');
  }


  // =========================================================
  // START BOT
  // =========================================================

  async startInstance(instanceId) {
    try {
      if (this.activeInstances.has(instanceId)) {
        console.log('[BOT ALREADY RUNNING]', instanceId);
        return this.activeInstances.get(instanceId);
      }

      const botDoc = await BotInstance
        .findOne({ instanceId })
        .lean();

      if (!botDoc) {
        throw new Error(
          `Bot instance ${instanceId} not found`
        );
      }


      // IMPORTANT:
      // Support both old and new BotInstance field names.
      const symbol =
        botDoc.symbol ||
        botDoc.tradingPair;

      const config =
        botDoc.config ||
        botDoc.parameters ||
        {};


      if (!symbol) {
        throw new Error(
          `Bot ${instanceId} has no trading symbol`
        );
      }


      const runtimeState = {
        instanceId,

        modelId:
          botDoc.modelId ||
          'MODEL_001',

        symbol,

        config,

        status: 'RUNNING',

        lastPrice: 0,

        currentPosition: null,

        thinking: {
          factors: {},
          decision: 'WAIT',
          humanReason:
            'Initializing technical analysis context...'
        }
      };


      this.activeInstances.set(
        instanceId,
        runtimeState
      );


      await BotInstance.updateOne(
        { instanceId },
        { status: 'RUNNING' }
      );


      console.log('\n======================================');
      console.log('🤖 BOT STARTED');
      console.log('======================================');

      console.log({
        instanceId,
        modelId: runtimeState.modelId,
        symbol: runtimeState.symbol,
        config: runtimeState.config
      });

      console.log(
        '[ACTIVE BOTS]',
        [...this.activeInstances.keys()]
      );


      this.emitToRoom(
        instanceId,
        'bot:status',
        {
          instanceId,
          status: 'RUNNING'
        }
      );


      this.log(
        instanceId,
        'INFO',
        `Bot started for ${symbol}`
      );


      return runtimeState;

    } catch (error) {

      console.error(
        '[BOT START ERROR]',
        instanceId,
        error
      );

      throw error;
    }
  }


  // =========================================================
  // STOP BOT
  // =========================================================

  async stopInstance(instanceId) {

    if (!this.activeInstances.has(instanceId)) {

      console.log(
        '[BOT STOP] Bot not active:',
        instanceId
      );

      return;
    }


    this.activeInstances.delete(instanceId);


    await BotInstance.updateOne(
      { instanceId },
      { status: 'PAUSED' }
    );


    console.log(
      '[BOT STOPPED]',
      instanceId
    );


    this.emitToRoom(
      instanceId,
      'bot:status',
      {
        instanceId,
        status: 'PAUSED'
      }
    );
  }


  // =========================================================
  // RECEIVE MARKET PRICE
  // =========================================================

  async processPriceTick(symbol, priceTick) {

    // console.log('\n--------------------------------------');
    // console.log('📈 ENGINE PRICE INPUT');
    // console.log('--------------------------------------');

    // console.log({
    //   symbol,
    //   priceTick
    // });


    // console.log(
    //   '[ACTIVE BOT COUNT]',
    //   this.activeInstances.size
    // );


    // console.log(
    //   '[ACTIVE BOT SYMBOLS]',
    //   [...this.activeInstances.values()].map(
    //     bot => ({
    //       instanceId: bot.instanceId,
    //       symbol: bot.symbol,
    //       status: bot.status
    //     })
    //   )
    // );


    if (!priceTick) {
      console.warn(
        '[ENGINE] Empty price tick received'
      );

      return;
    }


    const price =
      Number(priceTick.price);

    const timestamp =
      priceTick.timestamp ||
      Date.now();


    if (!Number.isFinite(price)) {

      console.warn(
        '[ENGINE] Invalid price:',
        priceTick.price
      );

      return;
    }


    // =====================================================
    // PROCESS RUNNING BOTS
    // =====================================================

    for (
      const [instanceId, instance]
      of this.activeInstances.entries()
    ) {

      // console.log('[SYMBOL CHECK]', {
      //   instanceId,
      //   botSymbol: instance.symbol,
      //   marketSymbol: symbol,
      //   match: instance.symbol === symbol
      // });


      // Ignore market data for another pair
      if (instance.symbol !== symbol) {
        continue;
      }


      console.log(
        '✅ MARKET MATCHED BOT:',
        instanceId
      );


      instance.lastPrice = price;


      // ===================================================
      // POSITION PNL
      // ===================================================

      if (instance.currentPosition) {

        try {

          instance.currentPosition =
            PositionManager.calculateUnrealizedPnL(
              instance.currentPosition,
              price
            );

        } catch (error) {

          console.error(
            '[PNL ERROR]',
            instanceId,
            error
          );
        }
      }


      // ===================================================
      // STRATEGY
      // ===================================================

      let evaluation;

      try {

        evaluation =
          TechnicalAnalysisService
            .evaluateModelStrategy(
              instance.modelId,
              instance.config,
              price
            );


        // console.log(
        //   '🧠 STRATEGY RESULT',
        //   {
        //     instanceId,
        //     price,
        //     evaluation
        //   }
        // );

      } catch (error) {

        console.error(
          '[STRATEGY ERROR]',
          {
            instanceId,
            modelId: instance.modelId,
            config: instance.config,
            price,
            error
          }
        );

        continue;
      }


      if (!evaluation) {

        console.warn(
          '[STRATEGY] No evaluation returned:',
          instanceId
        );

        continue;
      }


      // ===================================================
      // THINKING STATE
      // ===================================================

      instance.thinking = {

        factors:
          evaluation.factors ||
          {},

        decision:
          evaluation.decision ||
          'WAIT',

        humanReason:
          evaluation.humanReason ||
          evaluation.reason ||
          'Monitoring market conditions...'
      };


      // ===================================================
      // SEND BOT TICK
      // ===================================================

      // console.log(
      //   '📤 EMIT bot:tick',
      //   {
      //     instanceId,
      //     price
      //   }
      // );


      this.emitToRoom(
        instanceId,
        'bot:tick',
        {
          instanceId,
          symbol,
          price,
          timestamp,
          position:
            instance.currentPosition
        }
      );


      // ===================================================
      // SEND BOT THINKING
      // ===================================================

      // console.log(
      //   '📤 EMIT bot:thinking',
      //   {
      //     instanceId,
      //     decision:
      //       instance.thinking.decision
      //   }
      // );


      this.emitToRoom(
        instanceId,
        'bot:thinking',
        {
          instanceId,

          factors:
            instance.thinking.factors,

          decision:
            instance.thinking.decision,

          humanReason:
            instance.thinking.humanReason
        }
      );


      // ===================================================
      // BUY / SELL
      // ===================================================

      if (
        evaluation.decision === 'BUY' ||
        evaluation.decision === 'SELL'
      ) {

        try {

          await this.handleTradeExecution(
            instance,
            price,
            evaluation
          );

        } catch (error) {

          console.error(
            '[TRADE EXECUTION ERROR]',
            instanceId,
            error
          );

        }
      }
    }
  }


  // =========================================================
  // LEGACY ANALYSIS RESULT (NO TRADING AUTHORITY)
  // =========================================================
  //
  // Called when the mock TechnicalAnalysisService reaches a BUY/SELL-like
  // result. This is retained ONLY so the bot-detail log terminal keeps
  // receiving a `bot:log` line for UI/runtime compatibility.
  //
  // It performs ZERO writes to Trade, Position, or Signal, makes NO calls
  // into RiskEngine/ExecutionRouter/PaperEngine/LiveEngine, and does NOT
  // mutate instance.currentPosition. BotManager -> MODEL_001 is the only
  // authoritative trading path (see services/botManager/BotManager.js).

  async handleTradeExecution(
    instance,
    price,
    evaluation
  ) {

    this.log(
      instance.instanceId,
      'INFO',
      `[LEGACY] Trading action ignored (${evaluation.decision} @ $${price}); BotManager/MODEL_001 is authoritative`
    );
  }



  // =========================================================
  // GET BOT RUNTIME
  // =========================================================

  getInstanceRuntimeState(instanceId) {

    return (
      this.activeInstances.get(instanceId) ||
      null
    );
  }


  // =========================================================
  // LOG EVENT
  // =========================================================

  log(instanceId, level, message) {

    const logData = {

      instanceId,

      level,

      message,

      timestamp:
        new Date()
    };


    console.log(
      `[BOT LOG] [${instanceId}] [${level}]`,
      message
    );


    this.emitToRoom(
      instanceId,
      'bot:log',
      logData
    );
  }


  // =========================================================
  // SOCKET ROOM EMITTER
  // =========================================================

  emitToRoom(instanceId, event, data) {

    if (!this.io) {

      console.warn(
        '[SOCKET EMIT FAILED] io not initialized:',
        event
      );

      return;
    }


    const room =
      `bot:${instanceId}`;


    console.log(
      `[SOCKET EMIT] ${event} → ${room}`
    );


    this.io
      .to(room)
      .emit(event, data);
  }
}


// ===========================================================
// SINGLETON
// ===========================================================

module.exports =
  new BotEngineManager();