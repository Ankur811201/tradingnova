'use strict';

/**
 * NOTE (Phase 2 fix, unrelated to MODEL_002): this file previously drove
 * Model001 through a DEFAULT_RULESET_V1 breakout scenario (3-candle
 * warm-up, historySize:20, capitalUsagePercent/stopLossPercent/
 * takeProfitPercent parameters, commandId matching RULE_LONG_BREAKOUT_V1)
 * that no longer matches the current production model. Model001 now runs
 * the client's CLIENT_MASTER_LOGIC_V1 strategy end-to-end (topLevel/
 * bottomLevel touches, EMA50 trend, 3-candle buy/sell cycle, dynamicLot
 * sizing, stopLoss = candle extreme +/- slBufferPips*mintick, takeProfit
 * from configured `targets`), and validators.js now requires
 * historySize >= 50 (needed for the 50-period EMA) with no default
 * timeframe. Every scenario below was independently verified end-to-end
 * against the current, unmodified Model001.js/patternEngine.js/
 * validators.js before being written here. Production code was NOT
 * changed to make these pass.
 */

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

const MIN = 60 * 1000;
const BASE = 10 * MIN;

async function makeStartedModel(ctx, overrides) {
  const model = new Model001(ctx);
  await model.onStart(Object.assign({
    instanceId: 'inst_test',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    parameters: Object.assign({ timeframe: '1m', historySize: 100, topLevel: 130, bottomLevel: 95 }, overrides && overrides.parameters),
    capitalAllocation: 10000,
    leverage: 2,
    riskSettings: {},
  }, overrides && overrides.instanceConfig));
  return model;
}

/** Feeds one aggregated 1m candle's worth of ticks (open,high,low,close) into a single bucket. Does NOT close it — the next feedCandle/tick does that. */
async function feedCandle(model, bucketIndex, ohlc, positionContext) {
  const bucketStart = BASE + bucketIndex * MIN;
  const ticks = [ohlc.open, ohlc.high, ohlc.low, ohlc.close];
  for (let i = 0; i < ticks.length; i += 1) {
    await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: ticks[i] }, timestamp: bucketStart + i * 1000 }, positionContext);
  }
}

/** 47 flat warm-up candles + the verified 3-candle L1_WITH_BUY cycle (buckets 47-49), then closes bucket 49 via bucket 50's first tick. */
async function feedLongSetup(model, positionContext) {
  for (let b = 0; b < 47; b += 1) await feedCandle(model, b, { open: 100, high: 100, low: 100, close: 100 }, positionContext);
  await feedCandle(model, 47, { open: 99, high: 99, low: 98, close: 99 }, positionContext);
  await feedCandle(model, 48, { open: 99, high: 101, low: 98.5, close: 100.5 }, positionContext);
  await feedCandle(model, 49, { open: 100.5, high: 105, low: 94, close: 105 }, positionContext);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 105 }, timestamp: BASE + 50 * MIN }, positionContext);
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

test('onStart throws when no timeframe is configured at all', async () => {
  const ctx = makeCtx();
  const model = new Model001(ctx);
  await assert.rejects(() => model.onStart({
    instanceId: 'i1', symbol: 'BTCUSD', environment: 'PAPER',
    parameters: {},
    capitalAllocation: 1000, leverage: 1, riskSettings: {},
  }), /no configured timeframe/);
});

test('LONG (L1_WITH_BUY) generates a deterministic command from a real 3-candle buy cycle at support', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  await feedLongSetup(model, null);

  assert.equal(ctx.commands.length, 1);
  const cmd = ctx.commands[0];
  assert.equal(cmd.action, 'LONG');
  assert.equal(cmd.instanceId, 'inst_test');
  assert.equal(cmd.symbol, 'BTCUSD');
  assert.equal(cmd.environment, 'PAPER');
  assert.match(cmd.commandId, /^MODEL001:inst_test:\d+:LONG:L1_WITH_BUY$/);
});

test('SHORT (L1_AGAINST_SELL) generates a command from a real liquidity-sweep rejection at resistance', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { parameters: { topLevel: 110, bottomLevel: 80 } });
  await feedCandle(model, 0, { open: 100, high: 100, low: 100, close: 100 }, null);
  let price = 100;
  for (let i = 0; i < 34; i += 1) await feedCandle(model, 1 + i, { open: price, high: price, low: price, close: price }, null);
  for (let i = 0; i < 14; i += 1) {
    const o = price; const c = price - 2;
    await feedCandle(model, 35 + i, { open: o, high: o + 0.2, low: c - 0.2, close: c }, null);
    price = c;
  }
  await feedCandle(model, 49, { open: price, high: price + 0.5, low: price - 1, close: price - 0.5 }, null);
  await feedCandle(model, 50, { open: price, high: 112, low: price - 10, close: price - 8 }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: price - 8 }, timestamp: BASE + 51 * MIN }, null);

  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].action, 'SHORT');
  assert.equal(ctx.commands[0].metadata.ruleId, 'L1_AGAINST_SELL');
});

test('quantity comes from the dynamicLot table (CAPITAL sizing mode, default) — never guesses a balance', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  await feedLongSetup(model, null);
  const cmd = ctx.commands[0];
  // range (105-94)/mintick(0.01) = 1100 >= hiPoints(360) -> lotHi(4), default sizing.mode='CAPITAL'
  assert.equal(cmd.quantity, 4);
});

test('LOT sizing mode overrides the dynamic lot table with the explicitly configured quantity', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { instanceConfig: { sizing: { mode: 'LOT', value: 2.5 } } });
  await feedLongSetup(model, null);
  assert.equal(ctx.commands[0].quantity, 2.5);
});

test('stop loss for LONG is the candle low minus slBufferPips (in mintick units); no configured target means takeProfit stays null', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { parameters: { slBufferPips: 10, mintick: 0.01 } });
  await feedLongSetup(model, null);
  const cmd = ctx.commands[0];
  assert.ok(Math.abs(cmd.stopLoss - (94 - 10 * 0.01)) < 1e-9);
  assert.equal(cmd.takeProfit, null);
});

test('a configured target above entry is wired through to takeProfit for a LONG', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { instanceConfig: { targets: [{ price: 120 }] } });
  await feedLongSetup(model, null);
  assert.equal(ctx.commands[0].takeProfit, 120);
});

test('duplicate closed-candle dispatch does not generate a second command', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  await feedLongSetup(model, null);
  assert.equal(ctx.commands.length, 1);
  // Re-deliver the exact same closing tick again (e.g. a re-dispatch bug elsewhere).
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 105 }, timestamp: BASE + 50 * MIN }, null);
  assert.equal(ctx.commands.length, 1);
});

test('malformed candle input is rejected without generating a command', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  await model.onMarketData({
    type: 'candle', symbol: 'BTCUSD',
    data: { timestamp: 1, open: 100, high: 50, low: 200, close: NaN },
    timestamp: 1,
  }, null);
  assert.equal(ctx.commands.length, 0);
  assert.ok(ctx.events.some((e) => e.kind === 'Error'));
});

test('while PAUSED, no new signals are generated even if a real setup occurs', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  await model.onPause();
  await feedLongSetup(model, null);
  assert.equal(ctx.commands.length, 0);
});

test('after STOP, onMarketData is a no-op', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  await model.onStop();
  await feedCandle(model, 0, { open: 100, high: 100, low: 100, close: 100 }, null);
  assert.equal(ctx.commands.length, 0);
  assert.ok(ctx.events.some((e) => e.eventType === 'MODEL_STOPPED'));
});

test('position-aware: no duplicate LONG command while an existing LONG position is open', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx);
  const openLong = { side: 'LONG' };
  await feedLongSetup(model, openLong);
  assert.equal(ctx.commands.length, 0);
});

test('LOT sizing mode with an explicit zero quantity still submits the command as-is (current code has no positive-quantity guard in _buildTradeCommand beyond a positive referencePrice check)', async () => {
  const ctx = makeCtx();
  const model = await makeStartedModel(ctx, { instanceConfig: { sizing: { mode: 'LOT', value: 0 } } });
  await feedLongSetup(model, null);
  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].quantity, 0);
});

test('SIGNAL_GENERATED emitted when RiskEngine (mock) approves, SIGNAL_REJECTED when it rejects', async () => {
  const ctx = makeCtx();
  ctx.nextResult = { approved: false, reason: 'Market data is stale', metadata: {} };
  const model = await makeStartedModel(ctx);
  await feedLongSetup(model, null);
  assert.ok(ctx.events.some((e) => e.eventType === 'SIGNAL_REJECTED'));
  assert.ok(!ctx.events.some((e) => e.eventType === 'SIGNAL_GENERATED'));
});

// --- Boundary/safety: static source scan ---

test('Model 001 source files never import DeltaAdapter, PaperEngine, LiveEngine, or ExecutionRouter', () => {
  const dir = path.join(__dirname, '..', 'bot-models', 'model-001');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
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
