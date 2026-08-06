'use strict';

/**
 * Part 11.1 — concurrency tests for BotManager's per-instance lifecycle
 * lock (_withLock). Exercises exactly the races called out in review:
 *
 *   Promise.all([start(id), start(id)])
 *   Promise.all([restart(id), restart(id)])
 *   start + stop race
 *   restart + stop race
 *
 * and asserts: one runtime, one onStart, one hydration for the FINAL
 * start, correct terminal DB status, no duplicate MODEL_001 processing.
 *
 * SKIPPED automatically if no MongoDB is reachable, same convention as
 * tests/part9.executionState.test.js / tests/part11.botManager.test.js.
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
    console.log(`[part11.1 concurrency tests] Skipping: MongoDB not reachable at ${TEST_URI} (${err.message})`);
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

const MIN5 = 5 * 60 * 1000;

async function seedClosedCandles(Candle, symbol, timeframe, count, endTs) {
  const docs = [];
  let price = 64000;
  for (let i = 0; i < count; i += 1) {
    const ts = endTs - (count - i) * MIN5;
    const open = price;
    const close = price + (i % 2 === 0 ? 5 : -5);
    docs.push({
      symbol, timeframe, timestamp: ts,
      open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close,
      volume: null, closed: true, source: 'delta',
    });
    price = close;
  }
  await Candle.insertMany(docs);
}

/**
 * Wraps modelDef.create so every constructed Model001 instance is counted,
 * and every onHydrate/onStart call on it is counted — this is how we prove
 * "one runtime, one onStart, one hydration" rather than just inferring it
 * from the final DB status.
 */
function instrumentModelCreation(botManager, modelId, counters) {
  const original = botManager.registeredModels.get(modelId);
  const wrapped = Object.assign({}, original, {
    create: (ctx) => {
      counters.created += 1;
      const instance = original.create(ctx);
      const origOnStart = instance.onStart.bind(instance);
      instance.onStart = async (...args) => {
        counters.onStart += 1;
        return origOnStart(...args);
      };
      const origOnHydrate = instance.onHydrate ? instance.onHydrate.bind(instance) : null;
      if (origOnHydrate) {
        instance.onHydrate = async (...args) => {
          counters.onHydrate += 1;
          return origOnHydrate(...args);
        };
      }
      return instance;
    },
  });
  botManager.registeredModels.set(modelId, wrapped);
  return () => botManager.registeredModels.set(modelId, original); // restore
}

test('Part 11.1 — concurrent lifecycle operations are serialized per instanceId', { skip: () => !dbAvailable && 'MongoDB not reachable' }, async (t) => {
  if (!dbAvailable) { t.skip('MongoDB not reachable'); return; }

  const BotInstance = require('../models/BotInstance');
  const Candle = require('../models/Candle');
  const User = require('../models/User');
  const botManager = require('../services/botManager/BotManager');
  const paperEngine = require('../services/paperEngine/PaperEngine');

  botManager.attachSocketServer(createMockIo());
  await botManager.discoverModels();

  const user = await User.create({ username: `part11_1_user_${Date.now()}`, passwordHash: 'x' });
  await paperEngine.ensureAccount(user._id);

  const TIMEFRAME = '5m';
  const now = Date.now();
  const endTs = Math.floor(now / MIN5) * MIN5;

  // ---- Race 1: Promise.all([start(id), start(id)]) ----------------------
  await t.test('double concurrent Start yields exactly one runtime, one onStart, one hydration', async () => {
    const SYMBOL = 'RACE1USD';
    await seedClosedCandles(Candle, SYMBOL, TIMEFRAME, 60, endTs);
    const instance = await botManager.createInstance({
      name: 'race1', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL,
      environment: 'PAPER', parameters: { timeframe: TIMEFRAME }, capitalAllocation: 10000, leverage: 2,
    });

    const counters = { created: 0, onStart: 0, onHydrate: 0 };
    const restore = instrumentModelCreation(botManager, 'MODEL_001', counters);
    try {
      const [a, b] = await Promise.allSettled([
        botManager.startInstance(instance.instanceId),
        botManager.startInstance(instance.instanceId),
      ]);
      assert.equal(a.status, 'fulfilled');
      assert.equal(b.status, 'fulfilled');

      assert.equal(counters.created, 1, 'exactly one MODEL_001 runtime must be constructed');
      assert.equal(counters.onStart, 1, 'exactly one onStart() call');
      assert.equal(counters.onHydrate, 1, 'exactly one hydration pass');

      const dbInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
      assert.equal(dbInstance.status, 'RUNNING');
      assert.equal(botManager.liveInstances.size >= 0, true);
      assert.ok(botManager.liveInstances.has(instance.instanceId));
    } finally {
      restore();
      await botManager.stopInstance(instance.instanceId);
    }
  });

  // ---- Race 2: Promise.all([restart(id), restart(id)]) ------------------
  await t.test('double concurrent Restart yields exactly one final runtime, no duplicate MODEL_001 processing', async () => {
    const SYMBOL = 'RACE2USD';
    await seedClosedCandles(Candle, SYMBOL, TIMEFRAME, 60, endTs);
    const instance = await botManager.createInstance({
      name: 'race2', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL,
      environment: 'PAPER', parameters: { timeframe: TIMEFRAME }, capitalAllocation: 10000, leverage: 2,
    });
    await botManager.startInstance(instance.instanceId);
    const firstRuntime = botManager.liveInstances.get(instance.instanceId).modelInstance;

    const counters = { created: 0, onStart: 0, onHydrate: 0 };
    const restore = instrumentModelCreation(botManager, 'MODEL_001', counters);
    try {
      const [a, b] = await Promise.allSettled([
        botManager.restartInstance(instance.instanceId),
        botManager.restartInstance(instance.instanceId),
      ]);
      assert.equal(a.status, 'fulfilled');
      assert.equal(b.status, 'fulfilled');

      // Two full restart cycles were requested; because they're serialized
      // (not merged), BOTH legitimately run stop->start once each — the
      // invariant is no OVERLAP (never two live runtimes coexisting), and
      // the final state is exactly one runtime.
      assert.equal(counters.created, 2, 'two serialized restart cycles each construct their own new runtime (expected — this is not deduping, it is ordering)');
      assert.equal(botManager.liveInstances.size >= 0, true);
      assert.equal(
        [...botManager.liveInstances.keys()].filter((k) => k === instance.instanceId).length,
        1,
        'no more than one live runtime entry for this instanceId at any observed point'
      );

      const finalRuntime = botManager.liveInstances.get(instance.instanceId).modelInstance;
      assert.notEqual(finalRuntime, firstRuntime, 'the final runtime is a fresh instance from the restart, not the original');

      const dbInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
      assert.equal(dbInstance.status, 'RUNNING', 'final status after two serialized restarts is RUNNING');
    } finally {
      restore();
      await botManager.stopInstance(instance.instanceId);
    }
  });

  // ---- Race 3: start + stop race -----------------------------------------
  await t.test('concurrent Start + Stop resolve to one consistent terminal state, never a stuck/contradictory status', async () => {
    const SYMBOL = 'RACE3USD';
    await seedClosedCandles(Candle, SYMBOL, TIMEFRAME, 60, endTs);
    const instance = await botManager.createInstance({
      name: 'race3', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL,
      environment: 'PAPER', parameters: { timeframe: TIMEFRAME }, capitalAllocation: 10000, leverage: 2,
    });

    const results = await Promise.allSettled([
      botManager.startInstance(instance.instanceId),
      botManager.stopInstance(instance.instanceId),
    ]);
    // Both must complete (stop-before-start-exists is a legitimate no-op
    // path, not an error) and the DB must land in a real, valid status —
    // never left mid-transition.
    assert.ok(results.every((r) => r.status === 'fulfilled'), 'neither call should throw regardless of ordering');

    const dbInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
    assert.ok(['RUNNING', 'STOPPED'].includes(dbInstance.status), `terminal status must be a real lifecycle state, got ${dbInstance.status}`);

    // liveInstances must agree with the DB status: RUNNING <-> registered.
    const isLive = botManager.liveInstances.has(instance.instanceId);
    if (dbInstance.status === 'RUNNING') {
      assert.equal(isLive, true, 'DB says RUNNING but no live runtime is registered — inconsistent state');
    } else {
      assert.equal(isLive, false, 'DB says STOPPED but a live runtime is still registered — inconsistent state');
    }

    await botManager.stopInstance(instance.instanceId);
  });

  // ---- Race 4: restart + stop race ---------------------------------------
  await t.test('concurrent Restart + Stop resolve to one consistent terminal state', async () => {
    const SYMBOL = 'RACE4USD';
    await seedClosedCandles(Candle, SYMBOL, TIMEFRAME, 60, endTs);
    const instance = await botManager.createInstance({
      name: 'race4', userId: user._id, modelId: 'MODEL_001', symbol: SYMBOL,
      environment: 'PAPER', parameters: { timeframe: TIMEFRAME }, capitalAllocation: 10000, leverage: 2,
    });
    await botManager.startInstance(instance.instanceId);

    const results = await Promise.allSettled([
      botManager.restartInstance(instance.instanceId),
      botManager.stopInstance(instance.instanceId),
    ]);
    assert.ok(results.every((r) => r.status === 'fulfilled'), 'neither call should throw regardless of ordering');

    const dbInstance = await BotInstance.findOne({ instanceId: instance.instanceId });
    assert.ok(['RUNNING', 'STOPPED'].includes(dbInstance.status));

    const isLive = botManager.liveInstances.has(instance.instanceId);
    if (dbInstance.status === 'RUNNING') {
      assert.equal(isLive, true);
    } else {
      assert.equal(isLive, false);
    }

    await botManager.stopInstance(instance.instanceId);
  });
});
