'use strict';

/**
 * Part 6 — Safety Close -> Trade Race Fix.
 *
 * Exercises BotManager.dispatchMarketData's closed-Trade correlation
 * directly against real Position/Trade documents (Trade.position is a
 * real ObjectId ref to Position, see models/Trade.js). The bot model
 * itself is a lightweight stub (onMarketData is a no-op, onPositionClosed
 * just records what it was handed) so these tests exercise ONLY the
 * BotManager-level correlation fix, never MODEL_002 strategy logic.
 *
 * SKIPPED automatically if no MongoDB is reachable, same convention as
 * tests/part11.botManager.test.js / tests/part9.executionState.test.js.
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
    console.log(`[part6 safety trade correlation tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
  }
});

after(async () => {
  if (dbAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

function createMockIo() {
  return { to() { return { emit() {} }; } };
}

/** A stub bot model: no-op onMarketData, recording onPositionClosed. */
function makeStubModel() {
  const received = [];
  return {
    received,
    onMarketData: async () => {},
    onPositionClosed: async (trade) => { received.push(trade); },
  };
}

async function makeRunningInstance(BotInstance, { instanceId, symbol, environment = 'PAPER', timeframe = '5m' }) {
  return BotInstance.create({
    instanceId, name: instanceId, modelId: 'MODEL_002_STUB', symbol, environment,
    status: 'RUNNING', capitalAllocation: 1000, leverage: 1,
    parameters: { timeframe },
    user: new mongoose.Types.ObjectId(),
  });
}

async function makePosition(Position, { instanceId, symbol, environment = 'PAPER', status = 'OPEN' }) {
  return Position.create({
    instanceId, symbol, environment, source: 'BOT', user: new mongoose.Types.ObjectId(),
    side: 'LONG', entryPrice: 100, currentPrice: 100, quantity: 1, leverage: 1, margin: 100,
    status, openedAt: new Date(Date.now() - 60_000),
    closedAt: status === 'CLOSED' ? new Date() : null,
  });
}

async function makeTrade(Trade, { instanceId, symbol, environment = 'PAPER', positionId, realizedPnl, closedAt }) {
  return Trade.create({
    instanceId, symbol, environment, source: 'BOT', user: new mongoose.Types.ObjectId(),
    position: positionId, side: 'LONG', entryPrice: 100, exitPrice: 100 + realizedPnl,
    quantity: 1, leverage: 1, realizedPnl, fees: 0,
    openedAt: new Date(Date.now() - 60_000), closedAt: closedAt || new Date(),
  });
}

test('Part 6 — exact Position<->Trade correlation on close', { skip: () => !dbAvailable && 'MongoDB not reachable' }, async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not reachable'); return; }

  const BotInstance = require('../models/BotInstance');
  const Position = require('../models/Position');
  const Trade = require('../models/Trade');
  const botManager = require('../services/botManager/BotManager');

  botManager.attachSocketServer(createMockIo());

  const candleUpdate = (symbol, timeframe, ts) => ({
    type: 'candle', symbol, timeframe,
    open: 100, high: 101, low: 99, close: 100, timestamp: ts, closed: true,
  });

  // -----------------------------------------------------------------------
  // Test 1 / Test 5 — an OLDER Trade for the same instance/symbol already
  // exists; a NEW position closes with its own NEW Trade. Safety must
  // process the NEW Trade, never the older (or any third) one.
  // -----------------------------------------------------------------------
  {
    const instanceId = `part6_exact_${Date.now()}`;
    const symbol = 'BTCUSD';
    const dbInstance = await makeRunningInstance(BotInstance, { instanceId, symbol });
    const stub = makeStubModel();
    botManager.liveInstances.set(instanceId, {
      modelInstance: stub, unsubscribers: [], wasPositionOpen: false, lastOpenPositionId: null, pendingClosedTradeLookup: null,
    });

    // Trade A: an older, already-settled trade for the same instance/symbol.
    const posA = await makePosition(Position, { instanceId, symbol, status: 'CLOSED' });
    await makeTrade(Trade, { instanceId, symbol, positionId: posA._id, realizedPnl: -10, closedAt: new Date(Date.now() - 30_000) });

    // Trade C: another older trade, also for the same instance/symbol, closed more recently than A.
    const posC = await makePosition(Position, { instanceId, symbol, status: 'CLOSED' });
    await makeTrade(Trade, { instanceId, symbol, positionId: posC._id, realizedPnl: 77, closedAt: new Date(Date.now() - 20_000) });

    // Position B: opens now.
    const posB = await makePosition(Position, { instanceId, symbol, status: 'OPEN' });

    // Tick 1: dispatch sees posB OPEN -> captures wasPositionOpen/lastOpenPositionId, no lookup yet.
    await botManager.dispatchMarketData(candleUpdate(symbol, '5m', Date.now() - 5000));
    assert.equal(stub.received.length, 0, 'no premature close detected while position is still open');

    // Close position B and create ITS Trade (the newest of all, but the important part is its exact positionId, not recency).
    posB.status = 'CLOSED';
    posB.closedAt = new Date();
    await posB.save();
    const tradeB = await makeTrade(Trade, { instanceId, symbol, positionId: posB._id, realizedPnl: 42, closedAt: new Date() });

    // Tick 2: dispatch must detect the close and correlate to Trade B specifically.
    await botManager.dispatchMarketData(candleUpdate(symbol, '5m', Date.now()));

    assert.equal(stub.received.length, 1, 'exactly one onPositionClosed call for one closed position');
    assert.equal(String(stub.received[0]._id), String(tradeB._id), 'must select the Trade belonging to the exact closed position (B), not an older same-symbol trade (A or C)');
    assert.equal(stub.received[0].realizedPnl, 42);

    await BotInstance.deleteOne({ instanceId });
    botManager.liveInstances.delete(instanceId);
  }

  // -----------------------------------------------------------------------
  // Test 2 / Test 3 — Trade record not visible yet: must retry, and must
  // NOT consume an older Trade for the same symbol while waiting.
  // -----------------------------------------------------------------------
  {
    const instanceId = `part6_retry_${Date.now()}`;
    const symbol = 'ETHUSD';
    await makeRunningInstance(BotInstance, { instanceId, symbol });
    const stub = makeStubModel();
    botManager.liveInstances.set(instanceId, {
      modelInstance: stub, unsubscribers: [], wasPositionOpen: false, lastOpenPositionId: null, pendingClosedTradeLookup: null,
    });

    // An older trade already sitting in the DB for this instance/symbol.
    const posOld = await makePosition(Position, { instanceId, symbol, status: 'CLOSED' });
    await makeTrade(Trade, { instanceId, symbol, positionId: posOld._id, realizedPnl: -5, closedAt: new Date(Date.now() - 60_000) });

    const posNew = await makePosition(Position, { instanceId, symbol, status: 'OPEN' });
    await botManager.dispatchMarketData(candleUpdate(symbol, '5m', Date.now() - 5000)); // captures OPEN

    // Close the position, but DO NOT create its Trade yet (simulates the real race).
    posNew.status = 'CLOSED';
    posNew.closedAt = new Date();
    await posNew.save();

    await botManager.dispatchMarketData(candleUpdate(symbol, '5m', Date.now() - 2000)); // tick: detects close, Trade not visible -> must retry, not consume old
    assert.equal(stub.received.length, 0, 'must not consume the older same-symbol Trade while the real one is still missing');
    const live = botManager.liveInstances.get(instanceId);
    assert.ok(live.pendingClosedTradeLookup, 'a pending lookup must be kept for the next tick');
    assert.equal(String(live.pendingClosedTradeLookup.positionId), String(posNew._id));

    // Now the real Trade appears.
    const tradeNew = await makeTrade(Trade, { instanceId, symbol, positionId: posNew._id, realizedPnl: 15, closedAt: new Date() });
    await botManager.dispatchMarketData(candleUpdate(symbol, '5m', Date.now()));

    assert.equal(stub.received.length, 1);
    assert.equal(String(stub.received[0]._id), String(tradeNew._id), 'must process the correct (new) Trade once it becomes visible, never the older one');

    await BotInstance.deleteOne({ instanceId });
    botManager.liveInstances.delete(instanceId);
  }

  // -----------------------------------------------------------------------
  // Test 6 — Environment isolation: a Trade that matches the closed
  // position but lives under the wrong environment must never be matched.
  // -----------------------------------------------------------------------
  {
    const instanceId = `part6_env_${Date.now()}`;
    const symbol = 'SOLUSD';
    await makeRunningInstance(BotInstance, { instanceId, symbol, environment: 'PAPER' });
    const stub = makeStubModel();
    botManager.liveInstances.set(instanceId, {
      modelInstance: stub, unsubscribers: [], wasPositionOpen: false, lastOpenPositionId: null, pendingClosedTradeLookup: null,
    });

    const pos = await makePosition(Position, { instanceId, symbol, environment: 'PAPER', status: 'OPEN' });
    await botManager.dispatchMarketData(candleUpdate(symbol, '5m', Date.now() - 5000));

    pos.status = 'CLOSED';
    pos.closedAt = new Date();
    await pos.save();

    // A LIVE-environment Trade referencing this same position id (should never happen in
    // practice, but proves the environment filter is real, not decorative).
    await makeTrade(Trade, { instanceId, symbol, environment: 'LIVE', positionId: pos._id, realizedPnl: 999, closedAt: new Date() });

    await botManager.dispatchMarketData(candleUpdate(symbol, '5m', Date.now()));
    assert.equal(stub.received.length, 0, 'a Trade under the wrong environment must never be matched, even with the correct position id');

    // The genuine PAPER trade now appears.
    const tradePaper = await makeTrade(Trade, { instanceId, symbol, environment: 'PAPER', positionId: pos._id, realizedPnl: 8, closedAt: new Date() });
    await botManager.dispatchMarketData(candleUpdate(symbol, '5m', Date.now() + 1000));

    assert.equal(stub.received.length, 1);
    assert.equal(String(stub.received[0]._id), String(tradePaper._id));

    await BotInstance.deleteOne({ instanceId });
    botManager.liveInstances.delete(instanceId);
  }
});
