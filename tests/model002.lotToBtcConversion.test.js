'use strict';

/**
 * Regression tests for the LOT -> BTC quantity conversion fix.
 *
 * Confirmed business rule: 1 lot = 0.001 BTC.
 *
 * Before the fix, Model002._confirmAndSubmit set `finalQuantity = lot`
 * directly (bot-models/model-002/Model002.js), so a risk-calculated lot
 * of 10 flowed downstream as a quantity of "10" — silently treated as
 * 10 BTC by TradeCommand/RiskEngine/ExecutionRouter/PaperEngine/
 * LiveEngine/DeltaAdapter/PnL, instead of the intended 0.010 BTC.
 *
 * The fix changes exactly one line: `finalQuantity = lot * 0.001`.
 * `lot` itself is left untouched everywhere it is surfaced for
 * decision/audit/UI purposes (command.metadata.lot, DECISION payload
 * `lot`, `checks.lot`).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Model002 = require('../bot-models/model-002/Model002');
const { computeNotional } = require('../utils/pnl');

const MIN = 60000;
const BASE = 1_700_000_000_000;

function makeCtx() {
  const ctx = { events: [], commands: [] };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => { ctx.commands.push(cmd); return { approved: true, reason: 'Approved', metadata: {} }; };
  return ctx;
}

function flat(count, price, startTs) {
  const arr = [];
  for (let i = 0; i < count; i += 1) {
    arr.push({ timestamp: startTs + i * MIN, open: price, high: price + 0.01, low: price - 0.01, close: price, volume: null });
  }
  return arr;
}

async function startedModel(parameters, instanceOverrides) {
  const ctx = makeCtx();
  const model = new Model002(ctx);
  await model.onStart(Object.assign({
    instanceId: 'inst1', symbol: 'BTCUSD', environment: 'PAPER',
    parameters: Object.assign({ timeframe: '1m', trend: 'BULLISH', support: [60000, 50, 25], resistance: [999000, 998000, 997000] }, parameters),
    capitalAllocation: 10000, leverage: 10, riskSettings: {},
  }, instanceOverrides));
  return { ctx, model };
}

function lastDecision(ctx) {
  return ctx.events.filter((e) => e.eventType === 'DECISION').pop();
}

// Same worked example as the investigation (Phase 5): Capital=$1,000,
// Leverage=1x, entry=$63,188, risk-calculated lot=10.
async function runLot10Scenario(instanceOverrides) {
  const { ctx, model } = await startedModel(
    { trend: 'BULLISH', support: [63132, 50, 25], resistance: [999000, 998000, 997000] },
    instanceOverrides,
  );
  await model.onHydrate(flat(20, 64000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 63182, high: 63192, low: 63132, close: 63172, volume: null }; // touches support 63132
  const c2 = { timestamp: BASE + 21 * MIN, open: 63181, high: 63186, low: 63180.5, close: 63183, volume: null }; // touches Candle1 body-high(63182)
  const breakout = { timestamp: BASE + 22 * MIN, open: 63184, high: 63192, low: 63183, close: 63188, volume: null }; // closes above 63186, entryPrice = 63188

  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: breakout.timestamp, data: breakout }, null);
  return { ctx, model };
}

test('LOT->BTC: lot=10 produces finalQuantity=0.010 (1 lot = 0.001 BTC), not 10', async () => {
  const { ctx } = await runLot10Scenario({ capitalAllocation: 1000, leverage: 1 });

  assert.equal(ctx.commands.length, 1, 'a valid risk-calculated lot must still produce a TradeCommand');
  const cmd = ctx.commands[0];

  assert.equal(cmd.metadata.riskLength, 61); // 63188 - 63127
  assert.equal(cmd.metadata.lot, 10, 'riskLength 61 -> lot 10, per the natural-number lot table');
  assert.equal(cmd.metadata.finalQuantity, 0.010, 'finalQuantity must be lot * 0.001');
  assert.equal(cmd.quantity, 0.010, 'TradeCommand.quantity must carry the BTC-converted value downstream');
});

test('LOT->BTC: raw `lot` remains 10 (unconverted) in decision/audit data alongside the converted finalQuantity', async () => {
  const { ctx } = await runLot10Scenario({ capitalAllocation: 1000, leverage: 1 });

  const cmd = ctx.commands[0];
  assert.equal(cmd.metadata.lot, 10, 'command.metadata.lot must stay the raw lot count');

  const decision = lastDecision(ctx);
  assert.equal(decision.payload.lot, 10, 'DECISION payload.lot must stay the raw lot count');
  assert.equal(decision.payload.checks.lot, 10, 'DECISION payload.checks.lot must stay the raw lot count');
  assert.equal(decision.payload.finalQuantity, 0.010, 'DECISION payload.finalQuantity must be the BTC-converted value');
});

test('LOT->BTC: entry=63188, quantity=0.010 -> notional=$631.88 (utils/pnl.computeNotional, unmodified)', () => {
  // Proves downstream notional math (RiskEngine/PaperEngine both call
  // utils/pnl.computeNotional / the equivalent price*quantity formula)
  // now produces the expected dollar notional once fed the corrected
  // BTC quantity -- no change was made to pnl.js itself.
  const notional = computeNotional(63188, 0.010);
  assert.equal(Math.round(notional * 100) / 100, 631.88);
});

test('LOT->BTC: finalNotional on the DECISION payload reflects the converted BTC quantity, not the raw lot', async () => {
  const { ctx } = await runLot10Scenario({ capitalAllocation: 1000, leverage: 1 });
  const decision = lastDecision(ctx);
  // finalNotional = entryPrice(63188) * finalQuantity(0.010)
  assert.equal(Math.round(decision.payload.finalNotional * 100) / 100, 631.88);
});
