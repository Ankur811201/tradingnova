'use strict';

/**
 * PHASE 2 — MODEL_002 layer/success safety.
 *
 * Confirmed requirements:
 *   1. Maximum 2 losing trades per layer.
 *   2. Maximum 6 layers.
 *   3. Maximum 1 successful/winning trade per bot.
 *
 * A RiskEngine rejection is NOT a trade, is not a loss, is not a success,
 * does not advance the layer, and does not consume the success allowance.
 * Only an actually executed and closed trade counts.
 *
 * Part A below unit-tests the pure LayerSafety state machine directly
 * (fast, deterministic, exhaustive over the transition table). Part B
 * drives the REAL Model002 through its onPositionClosed/onMarketData
 * wiring to prove the class is actually connected, that a stopped bot's
 * onMarketData gate blocks a new TradeCommand, that a RiskEngine
 * rejection never reaches the tracker at all, and that two bot instances
 * never share state.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { LayerSafety, MAX_LAYERS, MAX_LOSSES_PER_LAYER, MAX_SUCCESSFUL_TRADES_PER_BOT } = require('../bot-models/model-002/layerSafety');
const Model002 = require('../bot-models/model-002/Model002');

// =========================================================================
// PART A — pure LayerSafety state machine
// =========================================================================

test('PHASE2-1. a fresh tracker starts at Layer 1, 0 losses, 0 successes, NORMAL', () => {
  const s = new LayerSafety();
  assert.deepEqual(s.getState(), { currentLayer: 1, layerLossCount: 0, successfulTradeCount: 0, safetyStatus: 'NORMAL' });
});

test('PHASE2-2. first closed losing trade increments the layer loss count', () => {
  const s = new LayerSafety();
  const r = s.recordTradeOutcome('t1', -50);
  assert.equal(r.outcome, 'LOSS');
  assert.equal(r.transition, 'LOSS_RECORDED');
  assert.equal(s.currentLayer, 1);
  assert.equal(s.layerLossCount, 1);
  assert.equal(s.safetyStatus, 'NORMAL');
});

test('PHASE2-3/4/5. second loss in a layer (below MAX_LAYERS) advances to the next layer with loss count reset to 0', () => {
  const s = new LayerSafety();
  s.recordTradeOutcome('t1', -50);
  const r2 = s.recordTradeOutcome('t2', -30);
  assert.equal(r2.transition, 'LAYER_ADVANCED');
  assert.equal(s.currentLayer, 2);
  assert.equal(s.layerLossCount, 0, 'Layer 2 starts with loss count 0');
  assert.equal(s.safetyStatus, 'NORMAL');
});

test('PHASE2-6/7/8. Layer 6 is reachable; its 2nd loss stops the bot; Layer 7 is never created', () => {
  const s = new LayerSafety();
  let tradeN = 0;
  const loss = () => s.recordTradeOutcome(`t${++tradeN}`, -10);

  // Layers 1-5: 2 losses each -> advances 5 times -> currentLayer becomes 6.
  for (let layer = 1; layer <= 5; layer += 1) {
    loss();
    const r = loss();
    assert.equal(r.transition, 'LAYER_ADVANCED');
  }
  assert.equal(s.currentLayer, 6);
  assert.equal(s.layerLossCount, 0);
  assert.equal(s.safetyStatus, 'NORMAL');

  // Layer 6: 1st loss - still NORMAL.
  const l1 = loss();
  assert.equal(l1.transition, 'LOSS_RECORDED');
  assert.equal(s.currentLayer, 6, 'still Layer 6 — Layer 7 must never be created');
  assert.equal(s.safetyStatus, 'NORMAL');

  // Layer 6: 2nd loss - MAX_LAYER_STOPPED, currentLayer stays 6 forever.
  const l2 = loss();
  assert.equal(l2.transition, 'MAX_LAYER_STOPPED');
  assert.equal(s.currentLayer, 6, 'Layer 7 must never be created');
  assert.equal(s.safetyStatus, 'MAX_LAYER_STOPPED');

  // A further loss after the stop must not push past Layer 6 or change status.
  const l3 = loss();
  assert.equal(l3.transition, null, 'state is frozen once stopped');
  assert.equal(s.currentLayer, 6);
  assert.equal(s.safetyStatus, 'MAX_LAYER_STOPPED');

  assert.equal(MAX_LAYERS, 6);
  assert.equal(MAX_LOSSES_PER_LAYER, 2);
});

test('PHASE2-9. a winning closed trade sets successfulTradeCount = 1 and stops the bot', () => {
  const s = new LayerSafety();
  const r = s.recordTradeOutcome('w1', 25);
  assert.equal(r.outcome, 'WIN');
  assert.equal(r.transition, 'SUCCESS_STOPPED');
  assert.equal(s.successfulTradeCount, 1);
  assert.equal(s.safetyStatus, 'SUCCESS_STOPPED');
  assert.equal(MAX_SUCCESSFUL_TRADES_PER_BOT, 1);
});

test('PHASE2-10. a second successful trade after SUCCESS_STOPPED cannot increment the count further', () => {
  const s = new LayerSafety();
  s.recordTradeOutcome('w1', 25);
  const r2 = s.recordTradeOutcome('w2', 40); // a different, hypothetical second win
  assert.equal(r2.transition, null, 'frozen once stopped — no second increment');
  assert.equal(s.successfulTradeCount, 1, 'never reaches 2');
  assert.equal(s.safetyStatus, 'SUCCESS_STOPPED');
});

test('PHASE2-BREAK_EVEN. a flat (realizedPnl === 0) close is neither a loss nor a success', () => {
  const s = new LayerSafety();
  const r = s.recordTradeOutcome('be1', 0);
  assert.equal(r.outcome, 'BREAK_EVEN');
  assert.equal(r.transition, null);
  assert.equal(s.currentLayer, 1);
  assert.equal(s.layerLossCount, 0);
  assert.equal(s.successfulTradeCount, 0);
  assert.equal(s.safetyStatus, 'NORMAL');
});

test('PHASE2-15a. concurrency/dedup: the same tradeId can never be counted twice', () => {
  const s = new LayerSafety();
  s.recordTradeOutcome('dup1', -10);
  assert.equal(s.layerLossCount, 1);
  const replay = s.recordTradeOutcome('dup1', -10); // redelivered close event, same tradeId
  assert.equal(replay.duplicate, true);
  assert.equal(s.layerLossCount, 1, 'not double-counted');
});

test('PHASE2-14. restart recovery: replaying the full ordered trade history from scratch reproduces the exact live-processed state', () => {
  // "Live" processing, one trade at a time as they would have closed.
  const live = new LayerSafety();
  const trades = [
    { id: 't1', pnl: -10 }, { id: 't2', pnl: -10 },  // Layer 1 -> Layer 2
    { id: 't3', pnl: -10 }, { id: 't4', pnl: -10 },  // Layer 2 -> Layer 3
    { id: 't5', pnl: -10 },                          // Layer 3, 1 loss
  ];
  for (const t of trades) live.recordTradeOutcome(t.id, t.pnl);
  const liveState = live.getState();

  // "Recovery" — exactly what BotManager._recoverLayerSafetyState does:
  // a brand-new LayerSafety, replaying the same Trade history ordered by
  // closedAt ASC, nothing carried over from the live instance.
  const recovered = new LayerSafety();
  for (const t of trades) recovered.recordTradeOutcome(t.id, t.pnl);
  const recoveredState = recovered.getState();

  assert.deepEqual(recoveredState, liveState, 'a fresh replay of the same trade history must reproduce identical state after a restart');
  assert.equal(recoveredState.currentLayer, 3);
  assert.equal(recoveredState.layerLossCount, 1);
});

// =========================================================================
// PART B — wired into the real Model002
// =========================================================================

function makeCtx() {
  const ctx = { events: [], commands: [], riskApproved: true };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => {
    ctx.commands.push(cmd);
    return ctx.riskApproved
      ? { approved: true, reason: 'Approved', metadata: {} }
      : { approved: false, reason: 'Risk Rejected (test)', metadata: {} };
  };
  return ctx;
}

async function startedModel(ctx, instanceId) {
  const model = new Model002(ctx);
  await model.onStart({
    instanceId, symbol: 'BTCUSD', environment: 'PAPER',
    parameters: { timeframe: '1m', trend: 'BULLISH', support: [60000, 50, 25], resistance: [999000, 998000, 997000] },
    capitalAllocation: 10000, leverage: 10, riskSettings: {},
  });
  return model;
}

function tradeOf(id, realizedPnl) {
  return { _id: id, realizedPnl, reason: realizedPnl < 0 ? 'SL_HIT' : 'TP_HIT' };
}

test('PHASE2-B1. onPositionClosed drives the real Model002 layerSafety tracker (2 losses -> Layer 2)', async () => {
  const ctx = makeCtx();
  const model = await startedModel(ctx, 'inst_b1');
  await model.onPositionClosed(tradeOf('t1', -10));
  await model.onPositionClosed(tradeOf('t2', -10));
  assert.equal(model.layerSafety.currentLayer, 2);
  assert.equal(model.layerSafety.layerLossCount, 0);
  const stopEvent = ctx.events.find((e) => e.eventType === 'BOT_SAFETY_STOP');
  assert.equal(stopEvent, undefined, 'not stopped yet — only Layer 1->2, nowhere near Layer 6');
});

test('PHASE2-B2. a SUCCESS_STOPPED bot never generates another TradeCommand, even on a genuine confirmed pattern', async () => {
  const ctx = makeCtx();
  const model = await startedModel(ctx, 'inst_b2');
  await model.onPositionClosed(tradeOf('w1', 25));
  assert.equal(model.layerSafety.safetyStatus, 'SUCCESS_STOPPED');
  const stopEvent = ctx.events.find((e) => e.eventType === 'BOT_SAFETY_STOP' && e.payload.reason === 'successful_trade_reached');
  assert.ok(stopEvent);

  // Drive a real BULLISH+SUPPORT A/B/C sequence that would otherwise confirm a BUY.
  const MIN = 60000; const BASE = 1_700_000_000_000;
  const a = { timestamp: BASE + 19 * MIN, open: 60010, high: 60010.01, low: 60009.99, close: 60010, volume: null };
  const b = { timestamp: BASE + 20 * MIN, open: 60005, high: 60060, low: 59995, close: 60050, volume: null };
  const c = { timestamp: BASE + 21 * MIN, open: 60050, high: 60070, low: 60045, close: 60060, volume: null };
  const flat = [];
  for (let i = 0; i < 19; i += 1) flat.push({ timestamp: BASE + i * MIN, open: 60010, high: 60010.01, low: 60009.99, close: 60010, volume: null });
  await model.onHydrate(flat.concat([a]));
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c.timestamp, data: c }, null);

  assert.equal(ctx.commands.length, 0, 'no TradeCommand is ever submitted once SUCCESS_STOPPED');
  const wait = ctx.events.filter((e) => e.eventType === 'DECISION').map((e) => e.payload);
  assert.ok(wait.every((d) => d.decision === 'WAIT' && d.reason === 'bot_success_stopped'));
});

test('PHASE2-11/12. a RiskEngine rejection never reaches layerSafety — not a loss, not a success, no layer/count change', async () => {
  const ctx = makeCtx();
  ctx.riskApproved = false; // every submitTradeCommand call comes back Risk Rejected
  const model = await startedModel(ctx, 'inst_b3');

  const MIN = 60000; const BASE = 1_700_000_000_000;
  const a = { timestamp: BASE + 19 * MIN, open: 60010, high: 60010.01, low: 60009.99, close: 60010, volume: null };
  const b = { timestamp: BASE + 20 * MIN, open: 60005, high: 60060, low: 59995, close: 60050, volume: null };
  const c = { timestamp: BASE + 21 * MIN, open: 60050, high: 60070, low: 60045, close: 60060, volume: null };
  const flat = [];
  for (let i = 0; i < 19; i += 1) flat.push({ timestamp: BASE + i * MIN, open: 60010, high: 60010.01, low: 60009.99, close: 60010, volume: null });
  await model.onHydrate(flat.concat([a]));
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c.timestamp, data: c }, null);

  assert.equal(ctx.commands.length, 1, 'the pattern still confirms and submits — RiskEngine is what rejects it');
  const rejected = ctx.events.find((e) => e.eventType === 'SIGNAL_REJECTED');
  assert.ok(rejected, 'sanity: the submission really was rejected');

  // A rejection is not a closed trade — onPositionClosed is simply never
  // called for it (BotManager only calls it for a genuine Position close;
  // see BotManager._handleTradeCommand / dispatchMarketData). Confirm the
  // tracker is exactly as untouched as at onStart.
  assert.deepEqual(model.layerSafety.getState(), { currentLayer: 1, layerLossCount: 0, successfulTradeCount: 0, safetyStatus: 'NORMAL' });
});

test('PHASE2-13. Bot A safety state never affects Bot B (separate instances, separate trackers)', async () => {
  const ctxA = makeCtx();
  const ctxB = makeCtx();
  const botA = await startedModel(ctxA, 'inst_a');
  const botB = await startedModel(ctxB, 'inst_b');

  await botA.onPositionClosed(tradeOf('a1', -10));
  await botA.onPositionClosed(tradeOf('a2', -10)); // Bot A: Layer 1 -> Layer 2

  assert.equal(botA.layerSafety.currentLayer, 2);
  assert.deepEqual(botB.layerSafety.getState(), { currentLayer: 1, layerLossCount: 0, successfulTradeCount: 0, safetyStatus: 'NORMAL' }, 'Bot B is completely untouched');

  await botA.onPositionClosed(tradeOf('a3', 999)); // Bot A: SUCCESS_STOPPED
  assert.equal(botA.layerSafety.safetyStatus, 'SUCCESS_STOPPED');
  assert.equal(botB.layerSafety.safetyStatus, 'NORMAL', 'Bot B continues normally, unaffected by Bot A stopping');
});

test('PHASE2-restore. restoreLayerSafetyState seeds a fresh Model002 instance with recovered state (restart contract)', async () => {
  const ctx = makeCtx();
  const model = await startedModel(ctx, 'inst_restore');
  model.restoreLayerSafetyState({
    currentLayer: 4, layerLossCount: 1, successfulTradeCount: 0, safetyStatus: 'NORMAL',
    processedTradeIds: ['old1', 'old2', 'old3', 'old4', 'old5'],
  });
  assert.equal(model.layerSafety.currentLayer, 4);
  assert.equal(model.layerSafety.layerLossCount, 1);
  // A redelivered close for an already-recovered trade id must not double-count.
  const r = model.layerSafety.recordTradeOutcome('old3', -10);
  assert.equal(r.duplicate, true);
  assert.equal(model.layerSafety.layerLossCount, 1);
});
