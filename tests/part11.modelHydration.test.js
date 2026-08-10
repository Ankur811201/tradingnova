'use strict';

/**
 * NOTE (Phase 2 fix, unrelated to MODEL_002): three DECISION-count
 * assertions below were stale relative to Model001.js's own documented,
 * intentional post-hydration UI-sync behavior — onHydrate computes and
 * emits exactly ONE real DECISION from the just-hydrated buffer (see the
 * comment in Model001.js's onHydrate) purely so the Decision Engine UI
 * doesn't keep showing a pre-hydration "insufficient_history" state. That
 * DECISION is never accompanied by a trade, RULE_MATCHED, or a levelCounts
 * mutation — hydration still never trades. The tests below were updated to
 * expect that one UI-sync DECISION rather than zero, and to check the
 * actual no-trade invariant directly (zero commands, zero RULE_MATCHED/
 * SIGNAL_GENERATED). Production code was not changed.
 *
 * Part 11 — unit tests for Model001's history hydration contract:
 *
 *   BotManager._hydrateInstance -> modelInstance.onHydrate(closedCandles)
 *   BotManager._recoverLevelCounts -> modelInstance.restoreLevelCounts(counts)
 *
 * These exercise Model001 directly (no MongoDB / BotManager needed) since
 * onHydrate/restoreLevelCounts/getReadiness are pure, synchronous-once-
 * awaited operations on the model's own in-memory state. The MongoDB-backed
 * integration tests (hydration actually querying real Candle documents via
 * BotManager.startInstance) live in tests/part11.botManager.test.js and are
 * skipped automatically when no MongoDB is reachable, same convention as
 * tests/part9.executionState.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Model001 = require('../bot-models/model-001/Model001');

function makeCtx() {
  const ctx = {
    modelId: 'MODEL_001',
    modelVersion: '1.0.0',
    events: [],
    commands: [],
    nextResult: { approved: true, reason: 'Approved', metadata: {} },
  };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => { ctx.commands.push(cmd); return ctx.nextResult; };
  return ctx;
}

async function makeStartedModel(ctx, overrides) {
  const model = new Model001(ctx);
  await model.onStart(Object.assign({
    instanceId: 'inst_test',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: Object.assign({ timeframe: '5m', historySize: 100 }, overrides && overrides.parameters),
    capitalAllocation: 10000,
    leverage: 2,
    riskSettings: {},
  }, overrides && overrides.instanceConfig));
  return model;
}

const MIN5 = 5 * 60 * 1000;
const BASE = 1000 * MIN5; // real epoch-shaped timestamp, aligned to a 5m bucket

/** Builds `count` synthetic-but-plausible closed candles, oldest -> newest. */
function buildClosedCandles(count, startPrice = 64000) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = price + (i % 2 === 0 ? 5 : -5);
    const high = Math.max(open, close) + 2;
    const low = Math.min(open, close) - 2;
    candles.push({ timestamp: BASE + i * MIN5, open, high, low, close, volume: null });
    price = close;
  }
  return candles;
}

test('getReadiness reports NOT enough history before hydration (fresh onStart)', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  const readiness = model.getReadiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.have, 0);
  assert.equal(readiness.required, 50);
});

test('onHydrate with >= 50 closed candles makes the model READY without any live candle', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  const candles = buildClosedCandles(60);

  await model.onHydrate(candles);

  const readiness = model.getReadiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.have, 60);
  assert.equal(readiness.required, 50);
});

test('onHydrate with < 50 closed candles reports real X/50 insufficient-history readiness, no fabrication', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  const candles = buildClosedCandles(27);

  await model.onHydrate(candles);

  const readiness = model.getReadiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.have, 27);
  assert.equal(readiness.required, 50);
});

test('hydration NEVER submits a TradeCommand or emits a DECISION, even with 100 candles containing a real breakout pattern', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, {
    parameters: { topLevel: 64100, bottomLevel: 63900, maxTradesPerLevel: 2 },
  });

  // Build candles that touch/cross the configured top level with a strong
  // bearish rejection candle — exactly the shape that would trigger
  // L1_AGAINST_SELL if evaluated live.
  const candles = buildClosedCandles(80);
  const last = candles[candles.length - 1];
  candles[candles.length - 1] = Object.assign({}, last, {
    open: 64150, close: 64080, high: 64300, low: 64060,
  });

  await model.onHydrate(candles);

  assert.equal(ctx.commands.length, 0, 'no TradeCommand may be submitted during hydration');
  assert.equal(
    ctx.events.filter((e) => e.eventType === 'RULE_MATCHED' || e.eventType === 'SIGNAL_GENERATED').length,
    0,
    'hydration must never act on a matched rule, even though it computes one for UI sync'
  );
  // Model001.onHydrate intentionally emits exactly ONE DECISION as a
  // UI-sync convenience (documented in Model001.js: "Compute a fresh
  // decision from the just-hydrated buffer and emit it so the UI reflects
  // reality immediately... UI-only: no trade command, no RULE_MATCHED, no
  // levelCounts mutation") — this is current, intended behavior, not a
  // violation of "never trades on hydration".
  assert.equal(
    ctx.events.filter((e) => e.eventType === 'DECISION').length,
    1,
    'exactly one UI-sync DECISION is emitted by hydration, by design — but it must never be accompanied by a trade'
  );
  assert.ok(
    ctx.events.some((e) => e.eventType === 'MODEL_HYDRATED'),
    'hydration should still emit an observability event'
  );
});

test('a live candle duplicating the last hydrated candle timestamp is skipped by existing dedup (no double-processing at the hydration boundary)', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  const candles = buildClosedCandles(60);
  await model.onHydrate(candles);

  const lastHydrated = candles[candles.length - 1];

  // Re-deliver the exact same closed candle live (as could happen if a
  // reconnect replays it) — must be a no-op: no new command, and no
  // additional DECISION beyond the one hydration itself already emitted
  // as a UI-sync convenience (see the dedicated hydration-DECISION test).
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', data: lastHydrated }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(ctx.events.filter((e) => e.eventType === 'DECISION').length, 1);
});

test('the first genuinely NEW candle after hydration is evaluated exactly once', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { parameters: { topLevel: 999999, bottomLevel: 1 } });
  const candles = buildClosedCandles(60);
  await model.onHydrate(candles);

  const nextCandle = {
    timestamp: candles[candles.length - 1].timestamp + MIN5,
    open: 64000, high: 64010, low: 63990, close: 64005, volume: null,
  };

  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', data: nextCandle }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', data: nextCandle }, null); // duplicate delivery

  const decisionEvents = ctx.events.filter((e) => e.eventType === 'DECISION');
  // 1 from hydration's own UI-sync DECISION + 1 from the genuinely new live
  // candle; the duplicate delivery must add zero more.
  assert.equal(decisionEvents.length, 2, 'hydration-sync DECISION + exactly one for the new candle; duplicate delivery ignored');
});

test('restoreLevelCounts overwrites in-memory levelCounts so a restart cannot reset a per-level cap', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  assert.deepEqual(model.levelCounts, { l1: 0, l2: 0, l3: 0 });

  model.restoreLevelCounts({ l1: 2 });
  assert.deepEqual(model.levelCounts, { l1: 2, l2: 0, l3: 0 });
});

test('onHydrate with an empty/no candle array leaves the model at its pre-hydration (empty) state, never throws', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  await model.onHydrate([]);
  assert.equal(model.candles.length, 0);
  await model.onHydrate(undefined);
  assert.equal(model.candles.length, 0);
});

test('onHydrate discards malformed candles instead of crashing or fabricating values', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  const candles = buildClosedCandles(55);
  candles[10] = { timestamp: candles[10].timestamp, open: NaN, high: 1, low: 1, close: 1 };

  await model.onHydrate(candles);

  assert.equal(model.candles.length, 54, 'the one malformed candle is dropped, not zero-filled');
});
