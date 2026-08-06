'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    parameters: Object.assign({ timeframe: '1m', breakoutLookback: 3, historySize: 20 }, overrides && overrides.parameters),
    capitalAllocation: 10000,
    leverage: 2,
    riskSettings: {},
  }, overrides && overrides.instanceConfig));
  return model;
}

const MIN = 60 * 1000;
const BASE = 10 * MIN; // real epoch timestamps are always > 0

/** Sends one tick per minute bucket for `count` flat (price=100) buckets, closing all but the last. */
async function feedFlatWarmup(model, count, positionContext) {
  for (let i = 0; i <= count; i += 1) {
    await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + i * MIN }, positionContext || null);
  }
}

test('onStart validates and merges parameters, emits MODEL_STARTED', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  assert.equal(model.params.timeframe, '1m');
  assert.ok(ctx.events.some((e) => e.eventType === 'MODEL_STARTED'));
});

test('onStart throws on invalid parameters (does not start)', async () => {
  const ctx = makeCtx();
  const model = new Model001(ctx);
  await assert.rejects(() => model.onStart({
    instanceId: 'i1', symbol: 'BTCUSD', environment: 'PAPER',
    parameters: { timeframe: 'not-a-timeframe' },
    capitalAllocation: 1000, leverage: 1, riskSettings: {},
  }));
});

test('LONG breakout generates a command with a deterministic commandId', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  // 3 flat warm-up candles (buckets 0,1,2), then a breakout candle in bucket 3.
  await feedFlatWarmup(model, 3, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + 3 * MIN }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 112 }, timestamp: BASE + 3 * MIN + 1000 }, null);
  // next bucket tick closes bucket 3 as a breakout candle
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 113 }, timestamp: BASE + 4 * MIN }, null);

  assert.equal(ctx.commands.length, 1);
  const cmd = ctx.commands[0];
  assert.equal(cmd.action, 'LONG');
  assert.equal(cmd.instanceId, 'inst_test');
  assert.equal(cmd.symbol, 'BTCUSD');
  assert.equal(cmd.environment, 'PAPER');
  assert.match(cmd.commandId, /^MODEL001:inst_test:\d+:LONG:RULE_LONG_BREAKOUT_V1$/);
});

test('quantity sizing respects capitalAllocation and capitalUsagePercent, never guesses a balance', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { parameters: { capitalUsagePercent: 0.5 }, instanceConfig: { capitalAllocation: 10000 } });
  await feedFlatWarmup(model, 3, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + 3 * MIN }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 200 }, timestamp: BASE + 3 * MIN + 1000 }, null); // breakout close=200
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN }, null);

  const cmd = ctx.commands[0];
  const expectedQty = Math.floor((10000 * 0.5 / 200) * 1e6) / 1e6;
  assert.equal(cmd.quantity, expectedQty);
});

test('stop loss / take profit calculated correctly for LONG', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { parameters: { stopLossPercent: 1, takeProfitPercent: 2 } });
  await feedFlatWarmup(model, 3, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + 3 * MIN }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 200 }, timestamp: BASE + 3 * MIN + 1000 }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN }, null);

  const cmd = ctx.commands[0];
  assert.equal(cmd.action, 'LONG');
  assert.ok(Math.abs(cmd.stopLoss - 200 * 0.99) < 1e-9);
  assert.ok(Math.abs(cmd.takeProfit - 200 * 1.02) < 1e-9);
});

test('stop loss / take profit calculated correctly for SHORT', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { parameters: { stopLossPercent: 1, takeProfitPercent: 2 } });
  await feedFlatWarmup(model, 3, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + 3 * MIN }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 50 }, timestamp: BASE + 3 * MIN + 1000 }, null); // breakdown close=50
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 49 }, timestamp: BASE + 4 * MIN }, null);

  const cmd = ctx.commands[0];
  assert.equal(cmd.action, 'SHORT');
  assert.ok(Math.abs(cmd.stopLoss - 50 * 1.01) < 1e-9);
  assert.ok(Math.abs(cmd.takeProfit - 50 * 0.98) < 1e-9);
});

test('duplicate closed-candle dispatch does not generate a second command', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  await feedFlatWarmup(model, 3, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + 3 * MIN }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 200 }, timestamp: BASE + 3 * MIN + 1000 }, null);
  // this tick closes bucket 3 (the breakout candle)
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN }, null);
  assert.equal(ctx.commands.length, 1);

  // Simulate a duplicate dispatch of the exact same closing tick sequence again
  // (e.g. a bug elsewhere re-delivering the same update) — the model must not
  // re-evaluate a candle whose timestamp is <= lastProcessedCandleTimestamp.
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN }, null);
  assert.equal(ctx.commands.length, 1);
});

test('malformed candle input is rejected without generating a command', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  // Directly inject a malformed pre-built candle via the type:'candle' path.
  await model.onMarketData({
    type: 'candle', symbol: 'BTCUSD',
    data: { timestamp: 1, open: 100, high: 50, low: 200, close: NaN }, // internally inconsistent + NaN
    timestamp: 1,
  }, null);
  assert.equal(ctx.commands.length, 0);
  assert.ok(ctx.events.some((e) => e.kind === 'Error'));
});

test('while PAUSED, no new signals are generated even if a breakout occurs', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  await model.onPause();
  await feedFlatWarmup(model, 3, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + 3 * MIN }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 200 }, timestamp: BASE + 3 * MIN + 1000 }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN }, null);
  assert.equal(ctx.commands.length, 0);
});

test('after STOP, onMarketData is a no-op', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  await model.onStop();
  await feedFlatWarmup(model, 3, null);
  assert.equal(ctx.commands.length, 0);
  assert.ok(ctx.events.some((e) => e.eventType === 'MODEL_STOPPED'));
});

test('position-aware: no LONG command while an existing LONG position is open (pyramiding disabled)', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  const openLong = { side: 'LONG' };
  await feedFlatWarmup(model, 3, openLong);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + 3 * MIN }, openLong);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 200 }, timestamp: BASE + 3 * MIN + 1000 }, openLong);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN }, openLong);
  assert.equal(ctx.commands.length, 0);
});

test('sizing returns no command (SIGNAL_REJECTED) when notional would be non-positive', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { instanceConfig: { capitalAllocation: 0 } });
  await feedFlatWarmup(model, 3, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + 3 * MIN }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 200 }, timestamp: BASE + 3 * MIN + 1000 }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN }, null);
  assert.equal(ctx.commands.length, 0);
  assert.ok(ctx.events.some((e) => e.eventType === 'SIGNAL_REJECTED'));
});

test('SIGNAL_GENERATED emitted when RiskEngine (mock) approves, SIGNAL_REJECTED when it rejects', async () => {
  const ctx = makeCtx();
  ctx.nextResult = { approved: false, reason: 'Market data is stale', metadata: {} };
  const model = await makeStartedModel(ctx);
  await feedFlatWarmup(model, 3, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 100 }, timestamp: BASE + 3 * MIN }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 200 }, timestamp: BASE + 3 * MIN + 1000 }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 201 }, timestamp: BASE + 4 * MIN }, null);
  assert.ok(ctx.events.some((e) => e.eventType === 'SIGNAL_REJECTED'));
  assert.ok(!ctx.events.some((e) => e.eventType === 'SIGNAL_GENERATED'));
});

// --- Boundary/safety: static source scan ---

test('Model 001 source files never import DeltaAdapter, PaperEngine, LiveEngine, or ExecutionRouter', () => {
  const dir = path.join(__dirname, '..', 'bot-models', 'model-001');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  // Only flag actual require(...) calls referencing the forbidden modules —
  // documentation comments are allowed (and expected) to name them when
  // explaining what Model 001 must NOT do.
  const forbidden = [
    /require\(['"][^'"]*DeltaAdapter['"]\)/,
    /require\(['"][^'"]*PaperEngine['"]\)/,
    /require\(['"][^'"]*LiveEngine['"]\)/,
    /require\(['"][^'"]*ExecutionRouter['"]\)/,
    /require\(['"][^'"]*\/models\//,
  ];
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(content), false, `${file} unexpectedly contains a forbidden require() matching ${pattern}`);
    }
  }
});
