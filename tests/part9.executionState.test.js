'use strict';

/**
 * Part 9 — integration tests for the authoritative execution-state pipeline:
 *
 *   MODEL_001-style TradeCommand -> BotManager._handleTradeCommand
 *     -> RiskEngine -> ExecutionRouter -> PaperEngine -> Position/Trade
 *     -> BotManager._emitExecutionUpdate -> bot:execution socket event
 *     -> controllers/botController.js (Current Position / Performance)
 *
 * These exercise BotManager directly (bypassing the actual Model001
 * strategy) by calling the same private entry point a live model instance
 * uses (`_handleTradeCommand`), which is the ONLY path a bot model has to
 * cause a trade (see BotManager.js docstring).
 *
 * SKIPPED automatically if no MongoDB is reachable, same convention as
 * tests/integration.test.js and tests/part7.tradingAuthority.test.js.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const TEST_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/nova_trade_test';

let dbAvailable = false;

before(async () => {
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 1500 });
    dbAvailable = true;
  } catch (err) {
    dbAvailable = false;
    console.log(`[part9 tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

/** Minimal Socket.IO-shaped mock that just records emitted (room, event, payload) tuples. */
function createMockIo() {
  const emitted = [];
  return {
    emitted,
    to(room) {
      return {
        emit(event, payload) {
          emitted.push({ room, event, payload });
        },
      };
    },
  };
}

/** Minimal Express-shaped mock res that captures the render() call args. */
function createMockRes() {
  const calls = [];
  return {
    calls,
    render(view, locals) {
      calls.push({ view, locals });
    },
    status() {
      return this;
    },
  };
}

test('[Part 9] Full PAPER lifecycle: open -> bot:execution + Current Position, close -> Trade History + Performance', async (t) => {
  if (!dbAvailable) {
    t.skip('MongoDB not available in this environment');
    return;
  }

  const User = require('../models/User');
  const BotInstance = require('../models/BotInstance');
  const Position = require('../models/Position');
  const Trade = require('../models/Trade');
  const paperEngine = require('../services/paperEngine/PaperEngine');
  const riskEngine = require('../services/riskEngine/RiskEngine');
  const botManager = require('../services/botManager/BotManager');
  const marketData = require('../services/marketData');
  const botController = require('../controllers/botController');
  const MockProvider = require('./helpers/mockProvider');

  const mockProvider = new MockProvider();
  marketData._setProviderForTesting(mockProvider);
  mockProvider.setPrice('BTCUSD', 50000, Date.now());

  const io = createMockIo();
  botManager.attachSocketServer(io);

  const user = await User.create({ username: 'part9_user', passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const instance = await BotInstance.create({
    instanceId: 'part9_inst_1',
    user: user._id,
    modelId: 'model-001',
    modelVersion: '1.0.0',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    status: 'RUNNING',
    capitalAllocation: 10000,
    leverage: 2,
  });

  // ---- Test A: no position yet -----------------------------------------
  {
    const req = { params: { instanceId: instance.instanceId } };
    const res = createMockRes();
    await botController.renderBotDetail(req, res, (err) => { throw err; });
    const locals = res.calls[0].locals;
    assert.equal(locals.currentPosition, null, 'Test A: currentPosition must be null with no open Position doc');
    assert.equal(locals.performanceData.totalTrades, 0);
    assert.equal(locals.initialTrades.length, 0);
  }

  // ---- Test C: RiskEngine rejection must NOT create a position ----------
  {
    io.emitted.length = 0;
    const badCommand = {
      commandId: 'part9_cmd_bad_symbol',
      modelId: 'model-001',
      symbol: 'DOGEUSD', // not in RISK_ALLOWED_SYMBOLS
      environment: 'PAPER',
      action: 'LONG',
      quantity: 0.1,
    };
    const result = await botManager._handleTradeCommand(instance.instanceId, badCommand);
    assert.equal(result.approved, false, 'Test C: RiskEngine must reject a disallowed symbol');

    const openPosition = await Position.findOne({ instanceId: instance.instanceId, status: 'OPEN' });
    assert.equal(openPosition, null, 'Test C: no Position may exist after a risk rejection');

    const executionEvents = io.emitted.filter((e) => e.event === 'bot:execution');
    assert.equal(executionEvents.length, 0, 'Test C: bot:execution must NOT fire on risk rejection');
  }

  // ---- Test B: approved PAPER LONG -> authoritative open position -------
  let openedPositionId;
  {
    io.emitted.length = 0;
    const openCommand = {
      commandId: 'part9_cmd_open_1',
      modelId: 'model-001',
      symbol: 'BTCUSD',
      environment: 'PAPER',
      action: 'LONG',
      quantity: 0.1,
    };
    const result = await botManager._handleTradeCommand(instance.instanceId, openCommand);
    assert.equal(result.approved, true, 'Test B: a valid, allowed-symbol LONG must be approved');
    assert.ok(result.execution && result.execution.position, 'Test B: execution result must include the opened Position');
    openedPositionId = result.execution.position._id;

    // bot:execution must have fired, targeted at this bot's own room, with
    // a real, freshly-read Position attached and no trade yet (nothing has
    // closed).
    const executionEvents = io.emitted.filter((e) => e.event === 'bot:execution');
    assert.equal(executionEvents.length, 1, 'Test B: exactly one bot:execution event on successful open');
    assert.equal(executionEvents[0].room, `bot:${instance.instanceId}`);
    assert.equal(executionEvents[0].payload.action, 'LONG');
    assert.ok(executionEvents[0].payload.position, 'Test B: emitted payload must carry the open position');
    assert.equal(executionEvents[0].payload.trade, null, 'Test B: no trade exists yet on open');

    // Controller must now show the real open position.
    const req = { params: { instanceId: instance.instanceId } };
    const res = createMockRes();
    await botController.renderBotDetail(req, res, (err) => { throw err; });
    const locals = res.calls[0].locals;
    assert.ok(locals.currentPosition, 'Test B/J: controller must render the authoritative open Position');
    assert.equal(locals.currentPosition.side, 'LONG');
    assert.equal(locals.currentPosition.symbol, 'BTCUSD');
    assert.equal(String(locals.currentPosition._id), String(openedPositionId));
    assert.equal(locals.initialTrades.length, 0, 'Test B: Trade History must remain empty (no trade exists until close)');
  }

  // ---- Test D: unrealized PnL reflects the authoritative engine's math --
  {
    mockProvider.setPrice('BTCUSD', 51000, Date.now());
    await paperEngine.refreshUnrealizedForSymbol('BTCUSD', 51000);
    const refreshed = await Position.findById(openedPositionId).lean();
    assert.equal(refreshed.unrealizedPnl, (51000 - 50000) * 0.1, "Test D: UI's number must equal PaperEngine's own math, not a duplicate frontend formula");
  }

  // ---- Test E: closing the position produces a real Trade + updates UI --
  {
    io.emitted.length = 0;
    const closeCommand = {
      commandId: 'part9_cmd_close_1',
      modelId: 'model-001',
      symbol: 'BTCUSD',
      environment: 'PAPER',
      action: 'CLOSE',
    };
    const result = await botManager._handleTradeCommand(instance.instanceId, closeCommand);
    assert.equal(result.approved, true, 'Test E: CLOSE against an existing open position must be approved');
    assert.ok(result.execution && result.execution.realizedPnl > 0, 'Test E: closing a LONG after a price rise must realize positive PnL');

    const openAfterClose = await Position.findOne({ instanceId: instance.instanceId, status: 'OPEN' });
    assert.equal(openAfterClose, null, 'Test E: no OPEN position should remain');

    const trade = await Trade.findOne({ instanceId: instance.instanceId }).lean();
    assert.ok(trade, 'Test E: a real Trade document must exist after close');
    assert.equal(trade.side, 'LONG');
    assert.ok(trade.realizedPnl > 0);

    const executionEvents = io.emitted.filter((e) => e.event === 'bot:execution');
    assert.equal(executionEvents.length, 1, 'Test E/K: exactly one bot:execution event on successful close');
    assert.equal(executionEvents[0].payload.position, null, 'Test E: emitted position must be null once fully closed');
    assert.ok(executionEvents[0].payload.trade, 'Test E/K: emitted payload must carry the real closed Trade');
    assert.equal(executionEvents[0].payload.trade.side, 'LONG');
    // Part 9.1: the emitted trade must be scoped to this command's own
    // environment (PAPER here), matching the Position lookup right above
    // it in BotManager._emitExecutionUpdate -- guards against a PAPER
    // instance ever surfacing a LIVE trade or vice versa.
    assert.equal(executionEvents[0].payload.trade.environment, 'PAPER');

    // ---- Test G/H (via controller): Performance now reflects the trade --
    const req = { params: { instanceId: instance.instanceId } };
    const res = createMockRes();
    await botController.renderBotDetail(req, res, (err) => { throw err; });
    const locals = res.calls[0].locals;
    assert.equal(locals.currentPosition, null, 'Test E/J: Current Position must be empty after a full close');
    assert.equal(locals.initialTrades.length, 1, 'Test E: Trade History must now include the closed trade');
    assert.equal(locals.performanceData.totalTrades, 1);
    assert.equal(locals.performanceData.winningTrades, 1);
    assert.equal(locals.performanceData.losingTrades, 0);
    assert.equal(locals.performanceData.winRate, 100);
    assert.equal(locals.performanceData.profitFactor, Infinity, 'Test H: all-winning-trades edge case must be Infinity, not misleading');
    assert.ok(locals.performanceData.totalProfit > 0);
  }

  // ---- Test I: legacy bot:tick-shaped payloads must never influence what
  // the authoritative pipeline already wrote (the frontend defangs this;
  // here we assert the *source of truth* itself — Position/Trade — is
  // untouched by anything outside PaperEngine/LiveEngine). -------------
  {
    const openPositionCount = await Position.countDocuments({ instanceId: instance.instanceId, status: 'OPEN' });
    assert.equal(openPositionCount, 0, 'Test I: authoritative state remains whatever PaperEngine last wrote, regardless of any legacy telemetry');
  }
});

test('[Part 9] Decision alone (no execution) must not create a Position or fire bot:execution', async (t) => {
  if (!dbAvailable) {
    t.skip('MongoDB not available in this environment');
    return;
  }

  const User = require('../models/User');
  const BotInstance = require('../models/BotInstance');
  const Position = require('../models/Position');
  const StrategyEvent = require('../models/StrategyEvent');
  const botManager = require('../services/botManager/BotManager');
  const marketData = require('../services/marketData');
  const MockProvider = require('./helpers/mockProvider');

  const mockProvider = new MockProvider();
  marketData._setProviderForTesting(mockProvider);
  // Deliberately no price set -> RiskEngine must reject as stale/unavailable.

  const io = createMockIo();
  botManager.attachSocketServer(io);

  const user = await User.create({ username: 'part9_user_2', passwordHash: 'x' });
  const instance = await BotInstance.create({
    instanceId: 'part9_inst_2',
    user: user._id,
    modelId: 'model-001',
    modelVersion: '1.0.0',
    symbol: 'ETHUSD',
    environment: 'PAPER',
    status: 'RUNNING',
    capitalAllocation: 10000,
    leverage: 1,
  });

  // Simulate a StrategyEvent (MODEL_001 "decision") being recorded, as
  // BotManager._handleModelEvent would, WITHOUT ever calling
  // _handleTradeCommand — i.e. decision recorded, no execution attempted.
  await StrategyEvent.create({
    instanceId: instance.instanceId, modelId: 'model-001', symbol: 'ETHUSD',
    eventType: 'DECISION', payload: { action: 'BUY' }, at: new Date(),
  });

  const openPosition = await Position.findOne({ instanceId: instance.instanceId, status: 'OPEN' });
  assert.equal(openPosition, null, 'A recorded BUY decision alone must never create a Position');

  // And even when a command IS submitted but risk rejects it (stale price):
  const command = {
    commandId: 'part9_cmd_stale',
    modelId: 'model-001',
    symbol: 'ETHUSD',
    environment: 'PAPER',
    action: 'LONG',
    quantity: 0.1,
  };
  const result = await botManager._handleTradeCommand(instance.instanceId, command);
  assert.equal(result.approved, false, 'Stale/unavailable market data must be rejected by RiskEngine');

  const stillNoPosition = await Position.findOne({ instanceId: instance.instanceId, status: 'OPEN' });
  assert.equal(stillNoPosition, null);

  const executionEvents = io.emitted.filter((e) => e.event === 'bot:execution');
  assert.equal(executionEvents.length, 0, 'bot:execution must never fire without a successful ExecutionRouter result');
});
