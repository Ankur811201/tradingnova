'use strict';

/**
 * MODEL_002 — same-side pattern tests (BULLISH+SUPPORT=BUY,
 * BEARISH+RESISTANCE=SELL). Covers every unambiguous step of the newly
 * confirmed requirement: touch detection, Candle 2 shape validation
 * (UpperP/LowerP/BodyP + candle nature), stop loss, risk length, and the
 * natural-number lot mapping — all verified against the requirement's own
 * worked examples first, then exercised end-to-end through Model002.
 *
 * Candle 3's confirmation-boundary formula is explicitly UNDEFINED (see
 * bot-models/model-002/sameSidePatternEngine.js's header comment) — this
 * file tests that the system honestly reports that instead of guessing,
 * not that BUY/SELL is ever actually produced (it cannot be yet).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Model002 = require('../bot-models/model-002/Model002');
const sp = require('../bot-models/model-002/sameSidePatternEngine');

const MIN = 60000;
const BASE = 1_700_000_000_000;

function flat(count, price, startTs) {
  const arr = [];
  for (let i = 0; i < count; i += 1) {
    arr.push({ timestamp: startTs + i * MIN, open: price, high: price + 0.01, low: price - 0.01, close: price, volume: null });
  }
  return arr;
}

function makeCtx() {
  const ctx = { events: [], commands: [] };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => { ctx.commands.push(cmd); return { approved: true, reason: 'Approved', metadata: {} }; };
  return ctx;
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

// =========================================================================
// A. BULLISH + SUPPORT -> BUY — pure formula verification
// =========================================================================

test('findTouchedLevel: support touch detection (exact price range, no invented tolerance)', () => {
  assert.equal(sp.findTouchedLevel([60000, 50, 25], { low: 60000, high: 60010 }).index, 1);
  assert.equal(sp.findTouchedLevel([60000, 50, 25], { low: 60010, high: 60020 }), null);
});

test('SL = Candle1.low - 5 (confirmed fixed buffer)', () => {
  assert.equal(sp.computeBuyStopLoss({ low: 60000 }), 59995);
});

test('Candle 2 body-high touch of Candle 1', () => {
  const candle1 = { open: 60050, close: 60040 }; // bodyHigh = 60050
  assert.equal(sp.candle2TouchesBodyHigh(candle1, { low: 60045, high: 60055 }), true);
  assert.equal(sp.candle2TouchesBodyHigh(candle1, { low: 60051, high: 60060 }), false);
});

test('UpperP/LowerP/Body/BodyP — exact requirement worked example (Open=100,Close=102,High=104,Low=99)', () => {
  const points = sp.computeCandle2Points({ open: 100, close: 102, high: 104, low: 99 }, 'BUY');
  assert.deepEqual(points, { upperP: 2, lowerP: 1, body: 2, bodyP: 5 });
});

test('BodyP maximum check', () => {
  assert.equal(sp.isBodyPMaximum({ upperP: 2, lowerP: 1, bodyP: 5 }), true);
  assert.equal(sp.isBodyPMaximum({ upperP: 6, lowerP: 1, bodyP: 5 }), false);
  assert.equal(sp.isBodyPMaximum({ upperP: 2, lowerP: 6, bodyP: 5 }), false);
});

test('bullish candle validation (Open < Close)', () => {
  assert.equal(sp.isCorrectCandleNature({ open: 100, close: 102 }, 'BUY'), true);
  assert.equal(sp.isCorrectCandleNature({ open: 102, close: 100 }, 'BUY'), false);
});

test('evaluateCandle2 (BUY): full pass', () => {
  const candle1 = { open: 60050, close: 60040 }; // bodyHigh = 60050
  const candle2 = { open: 100, close: 102, high: 104, low: 99 }; // touches nothing in real terms, isolated formula test below covers touch separately
  // Use a candle2 whose range touches candle1's bodyHigh AND matches the worked-example shape.
  const c2 = { open: 60050, close: 60052, high: 60054, low: 60049 };
  const result = sp.evaluateCandle2(candle1, c2, 'BUY');
  assert.equal(result.valid, true);
  assert.equal(result.points.bodyP, 5); // body=2, bodyP=5
});

test('evaluateCandle2 (BUY): fails on no body-high touch', () => {
  const candle1 = { open: 60050, close: 60040 };
  const c2 = { open: 61000, close: 61002, high: 61004, low: 60999 };
  const result = sp.evaluateCandle2(candle1, c2, 'BUY');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'candle2_did_not_touch_body_high');
});

test('evaluateCandle2 (BUY): fails when BodyP is not maximum', () => {
  const candle1 = { open: 60050, close: 60040 };
  // Large upper wick relative to a small body -> UpperP > BodyP
  const c2 = { open: 60050, close: 60051, high: 60070, low: 60049.5 };
  const result = sp.evaluateCandle2(candle1, c2, 'BUY');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'bodyP_not_maximum');
});

test('evaluateCandle2 (BUY): fails when candle is bearish', () => {
  const candle1 = { open: 60050, close: 60040 };
  const c2 = { open: 60052, close: 60050, high: 60054, low: 60049 }; // touches bodyHigh but close<open
  const result = sp.evaluateCandle2(candle1, c2, 'BUY');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'candle2_not_bullish');
});

test('riskLength = Entry - StopLoss (BUY)', () => {
  assert.equal(sp.computeBuyRiskLength(60300, 59995), 305);
});

test('lot mapping — every band, natural integers only', () => {
  assert.equal(sp.computeLotFromRiskLength(345), 4);   // 330-360
  assert.equal(sp.computeLotFromRiskLength(300), 5);   // 280-<330
  assert.equal(sp.computeLotFromRiskLength(250), 6);   // 200-<280
  assert.equal(sp.computeLotFromRiskLength(170), 7);   // 140-<200
  assert.equal(sp.computeLotFromRiskLength(120), 8);   // 110-<140
  assert.equal(sp.computeLotFromRiskLength(100), 9);   // 90-<110
  assert.equal(sp.computeLotFromRiskLength(50), 10);   // 0-<90
  assert.equal(sp.computeLotFromRiskLength(0), 10);
  for (const rl of [345, 300, 250, 170, 120, 100, 50, 0]) {
    assert.ok(Number.isInteger(sp.computeLotFromRiskLength(rl)), `lot for riskLength=${rl} must be an integer`);
  }
});

test('riskLength > 360 -> NO TRADE (null lot)', () => {
  assert.equal(sp.computeLotFromRiskLength(361), null);
  assert.equal(sp.computeLotFromRiskLength(1000), null);
});

test('riskLength exactly at a band boundary (330, 280, 200, 140, 110, 90) uses the lower band\'s lot, per the requirement\'s inclusive-lower-bound wording', () => {
  assert.equal(sp.computeLotFromRiskLength(330), 4);
  assert.equal(sp.computeLotFromRiskLength(280), 5);
  assert.equal(sp.computeLotFromRiskLength(200), 6);
  assert.equal(sp.computeLotFromRiskLength(140), 7);
  assert.equal(sp.computeLotFromRiskLength(110), 8);
  assert.equal(sp.computeLotFromRiskLength(90), 9);
});

// =========================================================================
// B. BEARISH + RESISTANCE -> SELL — pure formula verification (mirror)
// =========================================================================

test('findTouchedLevel: resistance touch detection', () => {
  assert.equal(sp.findTouchedLevel([65000, 64990, 64700], { low: 64995, high: 65005 }).index, 1);
});

test('SL = Candle1.high + 5 (confirmed fixed buffer)', () => {
  assert.equal(sp.computeSellStopLoss({ high: 65000 }), 65005);
});

test('Candle 2 body-low touch of Candle 1', () => {
  const candle1 = { open: 65000, close: 65010 }; // bodyLow = 65000
  assert.equal(sp.candle2TouchesBodyLow(candle1, { low: 64995, high: 65005 }), true);
  assert.equal(sp.candle2TouchesBodyLow(candle1, { low: 65001, high: 65010 }), false);
});

test('UpperP/LowerP/Body/BodyP — exact requirement worked example (Open=102,Close=100,High=103,Low=99)', () => {
  const points = sp.computeCandle2Points({ open: 102, close: 100, high: 103, low: 99 }, 'SELL');
  assert.deepEqual(points, { upperP: 1, lowerP: 1, body: 2, bodyP: 5 });
});

test('bearish candle validation (Open > Close)', () => {
  assert.equal(sp.isCorrectCandleNature({ open: 102, close: 100 }, 'SELL'), true);
  assert.equal(sp.isCorrectCandleNature({ open: 100, close: 102 }, 'SELL'), false);
});

test('evaluateCandle2 (SELL): full pass', () => {
  const candle1 = { open: 65000, close: 65010 }; // bodyLow = 65000
  const c2 = { open: 65000, close: 64998, high: 65001, low: 64996 }; // body=2, bodyP=5
  const result = sp.evaluateCandle2(candle1, c2, 'SELL');
  assert.equal(result.valid, true);
  assert.equal(result.points.bodyP, 5);
});

test('evaluateCandle2 (SELL): fails on no body-low touch', () => {
  const candle1 = { open: 65000, close: 65010 };
  const c2 = { open: 64000, close: 63998, high: 64001, low: 63996 };
  const result = sp.evaluateCandle2(candle1, c2, 'SELL');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'candle2_did_not_touch_body_low');
});

test('evaluateCandle2 (SELL): fails when BodyP is not maximum', () => {
  const candle1 = { open: 65000, close: 65010 };
  const c2 = { open: 65000, close: 64999, high: 65000.5, low: 64970 }; // huge lower wick
  const result = sp.evaluateCandle2(candle1, c2, 'SELL');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'bodyP_not_maximum');
});

test('evaluateCandle2 (SELL): fails when candle is bullish', () => {
  const candle1 = { open: 65000, close: 65010 };
  const c2 = { open: 64998, close: 65000, high: 65001, low: 64996 }; // touches but close>open
  const result = sp.evaluateCandle2(candle1, c2, 'SELL');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'candle2_not_bearish');
});

test('riskLength = StopLoss - Entry (SELL)', () => {
  assert.equal(sp.computeSellRiskLength(64700, 65005), 305);
});

// =========================================================================
// Candle 2 boundaries — CONFIRMED formula (fixed at Candle2.high/low)
// =========================================================================

test('computeBoundaries: fixed at Candle2.high/low', () => {
  assert.deepEqual(sp.computeBoundaries({ high: 60100, low: 60000 }), { upper: 60100, lower: 60000 });
});

test('evaluateBoundaryBreak (BUY): close strictly above upper -> BUY', () => {
  const b = { upper: 60100, lower: 60000 };
  assert.equal(sp.evaluateBoundaryBreak({ close: 60100.01 }, b, 'BUY').outcome, 'BUY');
});

test('evaluateBoundaryBreak (BUY): close exactly at upper -> WAIT (touching alone is not enough)', () => {
  const b = { upper: 60100, lower: 60000 };
  assert.equal(sp.evaluateBoundaryBreak({ close: 60100 }, b, 'BUY').outcome, 'WAIT');
});

test('evaluateBoundaryBreak (BUY): close inside the boundaries -> WAIT', () => {
  const b = { upper: 60100, lower: 60000 };
  assert.equal(sp.evaluateBoundaryBreak({ close: 60050 }, b, 'BUY').outcome, 'WAIT');
});

test('evaluateBoundaryBreak (BUY): close exactly at lower -> WAIT', () => {
  const b = { upper: 60100, lower: 60000 };
  assert.equal(sp.evaluateBoundaryBreak({ close: 60000 }, b, 'BUY').outcome, 'WAIT');
});

test('evaluateBoundaryBreak (BUY): close strictly below lower -> INVALID', () => {
  const b = { upper: 60100, lower: 60000 };
  assert.equal(sp.evaluateBoundaryBreak({ close: 59999.99 }, b, 'BUY').outcome, 'INVALID');
});

test('evaluateBoundaryBreak (SELL): close strictly below lower -> SELL', () => {
  const b = { upper: 65100, lower: 65000 };
  assert.equal(sp.evaluateBoundaryBreak({ close: 64999.99 }, b, 'SELL').outcome, 'SELL');
});

test('evaluateBoundaryBreak (SELL): close exactly at lower -> WAIT', () => {
  const b = { upper: 65100, lower: 65000 };
  assert.equal(sp.evaluateBoundaryBreak({ close: 65000 }, b, 'SELL').outcome, 'WAIT');
});

test('evaluateBoundaryBreak (SELL): close inside boundaries -> WAIT', () => {
  const b = { upper: 65100, lower: 65000 };
  assert.equal(sp.evaluateBoundaryBreak({ close: 65050 }, b, 'SELL').outcome, 'WAIT');
});

test('evaluateBoundaryBreak (SELL): close exactly at upper -> WAIT', () => {
  const b = { upper: 65100, lower: 65000 };
  assert.equal(sp.evaluateBoundaryBreak({ close: 65100 }, b, 'SELL').outcome, 'WAIT');
});

test('evaluateBoundaryBreak (SELL): close strictly above upper -> INVALID', () => {
  const b = { upper: 65100, lower: 65000 };
  assert.equal(sp.evaluateBoundaryBreak({ close: 65100.01 }, b, 'SELL').outcome, 'INVALID');
});

// =========================================================================
// End-to-end: Model002 3-candle state machine (BULLISH+SUPPORT)
// =========================================================================

test('E2E BUY: Candle 1 touch starts a pattern candidate, no trade yet', async () => {
  const { ctx, model } = await startedModel();
  await model.onHydrate(flat(20, 61000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(lastDecision(ctx).payload.reason, 'candle1_support_touch_awaiting_candle2');
});

test('E2E BUY: Candle 2 is not required to be the immediate next candle', async () => {
  const { ctx, model } = await startedModel();
  await model.onHydrate(flat(20, 61000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  const filler = { timestamp: BASE + 21 * MIN, open: 61000, high: 61010, low: 60990, close: 61005, volume: null }; // does not touch bodyHigh(60050) or any level
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: filler.timestamp, data: filler }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2', 'Candle 1 must still be held, waiting for a future body-high touch');
  assert.equal(model.patternCandidate.candle1.low, 60000);
  assert.equal(lastDecision(ctx).payload.reason, 'awaiting_candle2_body_touch');
});

test('E2E BUY: a newer Support touch while awaiting Candle 2 REPLACES Candle 1 (last-touch-wins) and recalculates SL', async () => {
  const { ctx, model } = await startedModel({ support: [60000, 59000, 58000] });
  await model.onHydrate(flat(20, 61000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  const newTouch = { timestamp: BASE + 21 * MIN, open: 59050, high: 59060, low: 59000, close: 59040, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: newTouch.timestamp, data: newTouch }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.candle1.low, 59000, 'Candle 1 must be replaced by the newer touch');
  assert.equal(model.patternCandidate.matchedLevel.price, 59000);
});

test('E2E BUY: valid Candle 2 advances the state machine, fixes boundaries at Candle2.high/low, exposes real UpperP/LowerP/BodyP, still no trade', async () => {
  const { ctx, model } = await startedModel();
  await model.onHydrate(flat(20, 61000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  const c2 = { timestamp: BASE + 21 * MIN, open: 60049, high: 60054, low: 60048.5, close: 60051, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');
  assert.deepEqual(model.patternCandidate.boundaries, { upper: 60054, lower: 60048.5 });
  const decision = lastDecision(ctx);
  assert.equal(decision.payload.reason, 'candle2_confirmed_awaiting_boundary_break');
  assert.equal(decision.payload.bodyP, 5);
  assert.equal(decision.payload.bodyPIsMaximum, true);
  assert.equal(decision.payload.candleNature, 'BULLISH');
  assert.equal(decision.payload.upperBoundary, 60054);
  assert.equal(decision.payload.lowerBoundary, 60048.5);
});

test('E2E BUY: invalid Candle 2 (bearish) discards the candidate and resumes searching', async () => {
  const { ctx, model } = await startedModel();
  await model.onHydrate(flat(20, 61000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  const c2 = { timestamp: BASE + 21 * MIN, open: 60052, high: 60054, low: 60049, close: 60050, volume: null }; // touches bodyHigh but bearish
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate, null, 'candidate must be discarded, not held');
  assert.equal(lastDecision(ctx).payload.reason, 'candle2_not_bullish');
});

test('E2E BUY: boundaries stay FIXED and pattern keeps waiting across several candles that stay inside them', async () => {
  const { ctx, model } = await startedModel();
  await model.onHydrate(flat(20, 61000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  const c2 = { timestamp: BASE + 21 * MIN, open: 60049, high: 60054, low: 60048.5, close: 60051, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);

  for (let i = 0; i < 4; i += 1) {
    const c = { timestamp: BASE + (22 + i) * MIN, open: 60051, high: 60053, low: 60049, close: 60052, volume: null };
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c.timestamp, data: c }, null);
    assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK', `must still be waiting after ${i + 1} inside-boundary candles`);
    assert.deepEqual(model.patternCandidate.boundaries, { upper: 60054, lower: 60048.5 }, 'boundaries must never move');
  }
  assert.equal(ctx.commands.length, 0);
});

test('E2E BUY: touching the upper boundary without closing through it -> WAIT, boundary unchanged', async () => {
  const { ctx, model } = await startedModel();
  await model.onHydrate(flat(20, 61000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  const c2 = { timestamp: BASE + 21 * MIN, open: 60049, high: 60054, low: 60048.5, close: 60051, volume: null };
  const touchNoClose = { timestamp: BASE + 22 * MIN, open: 60051, high: 60058, low: 60050, close: 60053, volume: null }; // wicks above 60054 but closes below
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touchNoClose.timestamp, data: touchNoClose }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');
  assert.equal(lastDecision(ctx).payload.reason, 'awaiting_boundary_break');
});

test('E2E BUY: close strictly above the upper boundary -> BUY, with correct SL/riskLength/lot, candidate cleared', async () => {
  const { ctx, model } = await startedModel();
  await model.onHydrate(flat(20, 61000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  const c2 = { timestamp: BASE + 21 * MIN, open: 60049, high: 60054, low: 60048.5, close: 60051, volume: null };
  const breakout = { timestamp: BASE + 22 * MIN, open: 60052, high: 60060, low: 60051, close: 60056, volume: null }; // closes above 60054
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: breakout.timestamp, data: breakout }, null);

  assert.equal(ctx.commands.length, 1);
  const cmd = ctx.commands[0];
  assert.equal(cmd.action, 'LONG');
  assert.equal(cmd.stopLoss, 59995); // Candle1.low(60000) - 5
  assert.equal(cmd.metadata.riskLength, 61); // 60056 - 59995
  assert.equal(cmd.metadata.lot, 10); // 0 <= 61 < 90
  assert.equal(model.patternCandidate, null, 'candidate must be cleared after a confirmed trade');
});

test('E2E BUY: close strictly below the lower boundary -> INVALID, no trade, candidate cleared, next candle can start fresh', async () => {
  const { ctx, model } = await startedModel();
  await model.onHydrate(flat(20, 61000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  const c2 = { timestamp: BASE + 21 * MIN, open: 60049, high: 60054, low: 60048.5, close: 60051, volume: null };
  const breakdown = { timestamp: BASE + 22 * MIN, open: 60049, high: 60049.5, low: 60040, close: 60040, volume: null }; // closes below 60048.5
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: breakdown.timestamp, data: breakdown }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate, null);
  assert.equal(lastDecision(ctx).payload.reason, 'invalidated_close_below_lower_boundary');

  // The candle immediately after an INVALID may become a fresh Candle 1 if it touches Support.
  const freshTouch = { timestamp: BASE + 23 * MIN, open: 55, high: 60, low: 50, close: 56, volume: null }; // touches default support level 50
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: freshTouch.timestamp, data: freshTouch }, null);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.candle1.low, 50);
});

// =========================================================================
// End-to-end: Model002 3-candle state machine (BEARISH+RESISTANCE)
// =========================================================================

test('E2E SELL: full Candle1->Candle2 flow mirrors BUY correctly', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [1, 2, 3], resistance: [65000, 64990, 64700] });
  await model.onHydrate(flat(20, 64000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 64950, high: 65000, low: 64940, close: 64960, volume: null }; // touches resistance 65000
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'SELL');
  assert.equal(ctx.commands.length, 0);
});

test('E2E SELL: complete pattern through to a real SELL confirmation, with correct SL/riskLength/lot', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [1, 2, 3], resistance: [65000, 64990, 64700] });
  await model.onHydrate(flat(20, 64000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 64950, high: 65000, low: 64940, close: 64960, volume: null }; // touches resistance 65000, bodyLow=64950
  const c2 = { timestamp: BASE + 21 * MIN, open: 64950, high: 64951.5, low: 64948, close: 64948.5, volume: null }; // touches bodyLow(64950), bearish
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');
  assert.deepEqual(model.patternCandidate.boundaries, { upper: 64951.5, lower: 64948 });

  const wait1 = { timestamp: BASE + 22 * MIN, open: 64949, high: 64950.5, low: 64948.5, close: 64949.5, volume: null }; // stays inside
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: wait1.timestamp, data: wait1 }, null);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');
  assert.equal(ctx.commands.length, 0);

  const breakdown = { timestamp: BASE + 23 * MIN, open: 64949, high: 64949.5, low: 64946, close: 64946, volume: null }; // closes strictly below 64948
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: breakdown.timestamp, data: breakdown }, null);

  assert.equal(ctx.commands.length, 1);
  const cmd = ctx.commands[0];
  assert.equal(cmd.action, 'SHORT');
  assert.equal(cmd.stopLoss, 65005); // Candle1.high(65000) + 5
  assert.equal(cmd.metadata.riskLength, 59); // 65005 - 64946
  assert.equal(cmd.metadata.lot, 10); // 0 <= 59 < 90
  assert.equal(model.patternCandidate, null);
});

test('E2E SELL: close strictly above the upper boundary -> INVALID, no trade, candidate cleared', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [1, 2, 3], resistance: [65000, 64990, 64700] });
  await model.onHydrate(flat(20, 64000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 64950, high: 65000, low: 64940, close: 64960, volume: null };
  const c2 = { timestamp: BASE + 21 * MIN, open: 64950, high: 64951.5, low: 64948, close: 64948.5, volume: null };
  const invalidate = { timestamp: BASE + 22 * MIN, open: 64950, high: 64953, low: 64949, close: 64952, volume: null }; // closes strictly above 64951.5
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: invalidate.timestamp, data: invalidate }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate, null);
  assert.equal(lastDecision(ctx).payload.reason, 'invalidated_close_above_upper_boundary');
});

test('E2E SELL: a newer Resistance touch while awaiting Candle 2 replaces Candle 1 (last-touch-wins)', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [1, 2, 3], resistance: [65000, 64990, 64000] });
  await model.onHydrate(flat(20, 64000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 64950, high: 65000, low: 64940, close: 64960, volume: null };
  const newTouch = { timestamp: BASE + 21 * MIN, open: 64010, high: 64020, low: 63995, close: 64000, volume: null }; // touches resistance 64000
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: newTouch.timestamp, data: newTouch }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate.candle1.high, 64020);
  assert.equal(model.patternCandidate.matchedLevel.price, 64000);
});

// =========================================================================
// Opposite-side patterns are now IMPLEMENTED (this task's purpose):
// BULLISH+RESISTANCE=SELL, BEARISH+SUPPORT=BUY, with one-time R1/S1
// calibration. See the OPPOSITE-SIDE / CALIBRATION test block further down
// for full coverage. These two tests confirm a level-1 (R1/S1) touch now
// correctly starts a real (calibration-eligible) pattern instead of
// staying IDLE — the premise these tests originally checked (opposite-side
// never starts anything) has been superseded by client-confirmed rules.
// =========================================================================

test('BULLISH + RESISTANCE (R1) touch now starts a real, calibration-eligible pattern candidate', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [1, 2, 3], resistance: [999000, 998000, 997000] });
  await model.onHydrate(flat(19, 61000, BASE));
  const touch = { timestamp: BASE + 19 * MIN, open: 998990, high: 999005, low: 998980, close: 998995, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, null);

  assert.equal(ctx.commands.length, 0, 'still no trade at Candle 1 — same as every other pattern start');
  assert.ok(model.patternCandidate);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'SELL');
  assert.equal(model.patternCandidate.isCalibrationPattern, true, 'R1 is uncalibrated at bot start');
});

test('BEARISH + SUPPORT (S1) touch now starts a real, calibration-eligible pattern candidate', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 50, 25], resistance: [999000, 998000, 997000] });
  await model.onHydrate(flat(19, 61000, BASE));
  const touch = { timestamp: BASE + 19 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, null);

  assert.equal(ctx.commands.length, 0);
  assert.ok(model.patternCandidate);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'BUY');
  assert.equal(model.patternCandidate.isCalibrationPattern, true, 'S1 is uncalibrated at bot start');
});

// =========================================================================
// No fake trades / no accidental trades — general safety
// =========================================================================

test('submitTradeCommand is only ever called from the single confirmed-trade path (_confirmAndSubmit) — no other code path can fabricate a trade', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  const matches = content.match(/this\.submitTradeCommand\(/g) || [];
  assert.equal(matches.length, 1, 'submitTradeCommand must be called from exactly one place');
});

test('restart resets pattern candidate search (in-memory only) without crashing', async () => {
  const { model } = await startedModel();
  await model.onHydrate(flat(20, 61000, BASE));
  const c1 = { timestamp: BASE + 20 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  assert.ok(model.patternCandidate);
  await model.onStop();
  assert.equal(model.patternCandidate, null);
});

// =========================================================================
// Chart overlay — fixed Candle2 boundary lines (Section 32)
// =========================================================================

test('bot-detail-chart.js exposes a MODEL_002 pattern-boundary overlay using the existing setPriceLine/removePriceLine dedup mechanism', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bot-detail-chart.js'), 'utf8');
  assert.match(content, /window\.NovaChartPatternOverlay/);
  assert.match(content, /setPriceLine\('patternUpperBoundary'/);
  assert.match(content, /setPriceLine\('patternLowerBoundary'/);
  assert.match(content, /removePriceLine\('patternUpperBoundary'\)/);
});

test('bot-detail-ws.js wires the real decision boundaries (not invented) into the chart overlay, only for MODEL_002', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bot-detail-ws.js'), 'utf8');
  assert.match(content, /modelId === 'MODEL_002' && window\.NovaChartPatternOverlay/);
  assert.match(content, /data\.checks && data\.checks\.boundaries/);
  assert.match(content, /window\.NovaChartPatternOverlay\.setBoundaries\(boundaries\.upper, boundaries\.lower\)/);
  assert.match(content, /window\.NovaChartPatternOverlay\.clearBoundaries\(\)/);
});

// =========================================================================
// Dedicated classification regression test — reported runtime issue
// (screenshot showed BEARISH+RESISTANCE incorrectly reaching the
// opposite-side WAIT path; verified by direct execution against the real
// Model002 class, not just static inspection — see the final report).
// =========================================================================

test('CLASSIFICATION: BEARISH + RESISTANCE touch is SAME-SIDE — creates Candle 1, state becomes WAITING_FOR_CANDLE2, reason is the same-side waiting reason, NEVER the opposite-side reason', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [64000, 63000, 62000], resistance: [64950, 65000, 65100] });
  await model.onHydrate(flat(20, 64900, BASE));

  const touch = { timestamp: BASE + 20 * MIN, open: 64900, high: 64960, low: 64890, close: 64940, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, null);

  const decision = lastDecision(ctx);
  assert.equal(decision.payload.checks.resistance.status, 'TOUCHED');
  assert.equal(decision.payload.checks.resistance.level, 64950);
  assert.equal(decision.payload.checks.patternState, 'WAITING_FOR_CANDLE2', 'must NOT be IDLE');
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'SELL');
  assert.equal(decision.payload.reason, 'candle1_resistance_touch_awaiting_candle2', 'must be the SAME-SIDE Candle 1 waiting reason');
  assert.notEqual(decision.payload.reason, 'direct_entry_pending_client_confirmation', 'must NEVER be the opposite-side pending reason');
  assert.equal(ctx.commands.length, 0);
});

test('CLASSIFICATION: BULLISH + SUPPORT touch is SAME-SIDE — same guarantees as above (regression sibling)', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [65000, 66000, 67000] });
  await model.onHydrate(flat(20, 61000, BASE));

  const touch = { timestamp: BASE + 20 * MIN, open: 60050, high: 60060, low: 60000, close: 60040, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, null);

  const decision = lastDecision(ctx);
  assert.equal(decision.payload.checks.support.status, 'TOUCHED');
  assert.equal(decision.payload.checks.patternState, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'BUY');
  assert.equal(decision.payload.reason, 'candle1_support_touch_awaiting_candle2');
  assert.notEqual(decision.payload.reason, 'direct_entry_pending_client_confirmation');
});

test('CLASSIFICATION: BULLISH + RESISTANCE (R1) is now a real, calibration-eligible SELL pattern (opposite-side patterns implemented)', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [65000, 66000, 67000] });
  await model.onHydrate(flat(19, 61000, BASE));

  const touch = { timestamp: BASE + 19 * MIN, open: 64990, high: 65010, low: 64980, close: 65000, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, null);

  const decision = lastDecision(ctx);
  assert.ok(model.patternCandidate);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'SELL');
  assert.equal(model.patternCandidate.isCalibrationPattern, true);
  assert.equal(decision.payload.reason, 'candle1_resistance_touch_awaiting_candle2');
  assert.equal(ctx.commands.length, 0);
});

test('CLASSIFICATION: BEARISH + SUPPORT (S1) is now a real, calibration-eligible BUY pattern (opposite-side patterns implemented)', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [64000, 63000, 62000], resistance: [64950, 65000, 65100] });
  await model.onHydrate(flat(19, 64500, BASE));

  const touch = { timestamp: BASE + 19 * MIN, open: 64010, high: 64020, low: 63995, close: 64000, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, null);

  const decision = lastDecision(ctx);
  assert.ok(model.patternCandidate);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'BUY');
  assert.equal(model.patternCandidate.isCalibrationPattern, true);
  assert.equal(decision.payload.reason, 'candle1_support_touch_awaiting_candle2');
  assert.equal(ctx.commands.length, 0);
});

// =========================================================================
// Historical last-touch recovery during hydration (client-confirmed rule:
// "use last touch"). onHydrate must reconstruct Candle 1 from the LAST
// valid same-side touch in already-closed history, without ever trading
// or emitting a DECISION during hydration — Candle 2 and everything after
// it still only ever comes from live candles.
// =========================================================================

function candleAt(idx, o, h, l, cl, startTs) {
  return { timestamp: startTs + idx * MIN, open: o, high: h, low: l, close: cl, volume: null };
}

test('HYDRATION RECOVERY: BULLISH + historical Support touch recovers Candle 1', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [999000, 998000, 997000] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) {
    candles.push(i === 12
      ? candleAt(i, 60050, 60060, 60000, 60040, BASE) // touches support 60000
      : candleAt(i, 61000, 61010, 60990, 61005, BASE));
  }
  await model.onHydrate(candles);

  assert.ok(model.patternCandidate, 'Candle 1 must be recovered');
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'BUY');
  assert.equal(model.patternCandidate.candle1.timestamp, BASE + 12 * MIN);
  assert.equal(model.patternCandidate.matchedLevel.price, 60000);
});

test('HYDRATION RECOVERY: BEARISH + historical Resistance touch recovers Candle 1', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) {
    candles.push(i === 15
      ? candleAt(i, 64900, 64960, 64890, 64920, BASE) // touches resistance 64950
      : candleAt(i, 64800, 64830, 64770, 64800, BASE));
  }
  await model.onHydrate(candles);

  assert.ok(model.patternCandidate, 'Candle 1 must be recovered');
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'SELL');
  assert.equal(model.patternCandidate.candle1.timestamp, BASE + 15 * MIN);
  assert.equal(model.patternCandidate.matchedLevel.price, 64950);
});

test('HYDRATION RECOVERY: multiple historical touches — the NEWEST (latest) touch wins, never the older one', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) {
    if (i === 10) candles.push(candleAt(i, 64900, 64960, 64890, 64920, BASE)); // older touch
    else if (i === 15) candles.push(candleAt(i, 64905, 64965, 64895, 64925, BASE)); // newer touch
    else candles.push(candleAt(i, 64800, 64830, 64770, 64800, BASE));
  }
  await model.onHydrate(candles);

  assert.equal(model.patternCandidate.candle1.timestamp, BASE + 15 * MIN, 'the newer (idx 15) touch must win, not the older (idx 10) one');
});

test('HYDRATION RECOVERY: no historical touch -> patternCandidate remains null, state remains IDLE', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  await model.onHydrate(flat(20, 64800, BASE)); // nowhere near any configured level
  assert.equal(model.patternCandidate, null);
});

test('HYDRATION RECOVERY: a historical Resistance (R1) touch under BULLISH trend IS now recovered as a calibration-eligible SELL Candle 1', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [65000, 65100, 65200] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) {
    candles.push(i === 12
      ? candleAt(i, 64990, 65010, 64980, 65000, BASE) // touches resistance 65000 (R1)
      : candleAt(i, 61000, 61010, 60990, 61005, BASE));
  }
  await model.onHydrate(candles);
  assert.ok(model.patternCandidate, 'opposite-side patterns are now implemented — this touch must be recovered');
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'SELL');
  assert.equal(model.patternCandidate.isCalibrationPattern, true);
});

test('HYDRATION RECOVERY: hydration NEVER submits a TradeCommand, even when a real historical touch is recovered', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) {
    candles.push(i === 15
      ? candleAt(i, 64900, 64960, 64890, 64920, BASE)
      : candleAt(i, 64800, 64830, 64770, 64800, BASE));
  }
  await model.onHydrate(candles);
  assert.equal(ctx.commands.length, 0, 'hydration must never submit a TradeCommand');
});

test('HYDRATION RECOVERY: hydration NEVER emits a DECISION event, even when a real historical touch is recovered', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) {
    candles.push(i === 15
      ? candleAt(i, 64900, 64960, 64890, 64920, BASE)
      : candleAt(i, 64800, 64830, 64770, 64800, BASE));
  }
  await model.onHydrate(candles);
  assert.ok(!ctx.events.some((e) => e.eventType === 'DECISION'), 'hydration must never emit a DECISION event');
});

test('HYDRATION RECOVERY: after recovery, a future LIVE Candle 2 continues the existing pattern normally (full restart scenario through to boundary tracking)', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  const candles = [];
  for (let i = 0; i < 19; i += 1) {
    candles.push(i === 15
      ? candleAt(i, 64900, 64960, 64890, 64920, BASE) // Candle 1 (recovered), bodyLow = min(64900,64920) = 64900
      : candleAt(i, 64800, 64830, 64770, 64800, BASE));
  }
  await model.onHydrate(candles);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(ctx.commands.length, 0);

  // A real live Candle 2: bearish, touches Candle 1's body-low (64900).
  const liveCandle2 = { timestamp: BASE + 19 * MIN, open: 64900, high: 64901.5, low: 64898, close: 64898.5, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: liveCandle2.timestamp, data: liveCandle2 }, null);

  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK', 'the existing state machine must continue normally after recovery');
  assert.deepEqual(model.patternCandidate.boundaries, { upper: 64901.5, lower: 64898 });
  assert.equal(ctx.commands.length, 0);
});

test('HYDRATION RECOVERY: full restart scenario end-to-end through to a real SELL confirmation, using the existing unchanged boundary logic', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  const candles = [];
  for (let i = 0; i < 19; i += 1) {
    candles.push(i === 15
      ? candleAt(i, 64900, 64960, 64890, 64920, BASE)
      : candleAt(i, 64800, 64830, 64770, 64800, BASE));
  }
  await model.onHydrate(candles);

  const liveCandle2 = { timestamp: BASE + 19 * MIN, open: 64900, high: 64901.5, low: 64898, close: 64898.5, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: liveCandle2.timestamp, data: liveCandle2 }, null);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');

  const breakdown = { timestamp: BASE + 20 * MIN, open: 64899, high: 64899.5, low: 64896, close: 64896, volume: null }; // closes strictly below 64898
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: breakdown.timestamp, data: breakdown }, null);

  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].action, 'SHORT');
  assert.equal(ctx.commands[0].stopLoss, 64965); // Candle1.high(64960) + 5
});

// =========================================================================
// FULL unfinished-pattern restart recovery — not just Candle 1. A restart
// while WAITING_FOR_BOUNDARY_BREAK must not lose the already-validated
// Candle 2 / fixed boundaries and fall back to WAITING_FOR_CANDLE2.
// =========================================================================

/** Builds a 20-candle BEARISH+RESISTANCE history: Candle 1 (idx 15, touches
 * resistance 64950), Candle 2 (idx 16, bearish, touches Candle1 body-low),
 * then 3 candles that stay strictly inside the resulting boundaries
 * [upper:64901.5, lower:64898]. */
function buildBearishBoundaryHistory() {
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 64800, 64830, 64770, 64800, BASE));
  candles[15] = candleAt(15, 64900, 64960, 64890, 64920, BASE); // Candle 1
  candles[16] = candleAt(16, 64900, 64901.5, 64898, 64898.5, BASE); // Candle 2
  candles[17] = candleAt(17, 64899, 64900, 64898.5, 64899.5, BASE); // inside boundaries
  candles[18] = candleAt(18, 64899, 64900, 64898.5, 64899.5, BASE);
  candles[19] = candleAt(19, 64899, 64900, 64898.5, 64899.5, BASE);
  return candles;
}

/** BULLISH+SUPPORT mirror. */
function buildBullishBoundaryHistory() {
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 61000, 61010, 60990, 61005, BASE));
  candles[15] = candleAt(15, 60050, 60060, 60000, 60040, BASE); // Candle 1, touches support 60000
  candles[16] = candleAt(16, 60049, 60054, 60048.5, 60051, BASE); // Candle 2, bullish, touches bodyHigh(60050)
  candles[17] = candleAt(17, 60051, 60053, 60049, 60052, BASE); // inside boundaries [60054, 60048.5]
  candles[18] = candleAt(18, 60051, 60053, 60049, 60052, BASE);
  candles[19] = candleAt(19, 60051, 60053, 60049, 60052, BASE);
  return candles;
}

test('FULL RESTART RECOVERY 1: BULLISH + SUPPORT — Candle 1 recovered from history', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [999000, 998000, 997000] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 61000, 61010, 60990, 61005, BASE));
  candles[15] = candleAt(15, 60050, 60060, 60000, 60040, BASE);
  await model.onHydrate(candles);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'BUY');
});

test('FULL RESTART RECOVERY 2: BEARISH + RESISTANCE — Candle 1 recovered from history', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 64800, 64830, 64770, 64800, BASE));
  candles[15] = candleAt(15, 64900, 64960, 64890, 64920, BASE);
  await model.onHydrate(candles);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.direction, 'SELL');
});

test('FULL RESTART RECOVERY 3: restart while (historically) only Candle 1 exists -> remains WAITING_FOR_CANDLE2', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 64800, 64830, 64770, 64800, BASE));
  candles[18] = candleAt(18, 64900, 64960, 64890, 64920, BASE); // touch near the end, no Candle 2 follows in history
  await model.onHydrate(candles);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
});

test('FULL RESTART RECOVERY 4: restart AFTER Candle 2 validation -> remains WAITING_FOR_BOUNDARY_BREAK (the critical fix — was previously incorrectly reset to WAITING_FOR_CANDLE2)', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] }, { capitalAllocation: 10000 });
  await model.onHydrate(buildBearishBoundaryHistory());
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');
  assert.equal(ctx.commands.length, 0);
  assert.ok(!ctx.events.some((e) => e.eventType === 'DECISION'));
});

test('FULL RESTART RECOVERY 5: Candle2.high (upper boundary) is exactly preserved after restart', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  await model.onHydrate(buildBearishBoundaryHistory());
  assert.equal(model.patternCandidate.boundaries.upper, 64901.5);
});

test('FULL RESTART RECOVERY 6: Candle2.low (lower boundary) is exactly preserved after restart', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  await model.onHydrate(buildBearishBoundaryHistory());
  assert.equal(model.patternCandidate.boundaries.lower, 64898);
});

test('FULL RESTART RECOVERY 7: UpperP/LowerP/Body/BodyP remain consistent (recomputed identically) after restart', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  await model.onHydrate(buildBearishBoundaryHistory());
  // Candle 2: open 64900, high 64901.5, low 64898, close 64898.5 (bearish)
  // body=abs(64898.5-64900)=1.5, upperP=high-open=1.5, lowerP=close-low=0.5, bodyP=1.5*2.5=3.75
  assert.deepEqual(model.patternCandidate.points, { upperP: 1.5, lowerP: 0.5, body: 1.5, bodyP: 3.75 });
});

test('FULL RESTART RECOVERY 8: the next LIVE candle continues the recovered pattern normally (stays WAITING_FOR_BOUNDARY_BREAK if still inside)', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  await model.onHydrate(buildBearishBoundaryHistory());
  const stillInside = { timestamp: BASE + 20 * MIN, open: 64899, high: 64900, low: 64898.5, close: 64899.5, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: stillInside.timestamp, data: stillInside }, null);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');
  assert.deepEqual(model.patternCandidate.boundaries, { upper: 64901.5, lower: 64898 });
  assert.equal(ctx.commands.length, 0);
});

test('FULL RESTART RECOVERY 9 (CRITICAL TEST): recovered WAITING_FOR_BOUNDARY_BREAK + a real live boundary-breaking candle -> EXACTLY ONE SELL TradeCommand', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] }, { capitalAllocation: 10000 });
  await model.onHydrate(buildBearishBoundaryHistory());
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');

  const breakdown = { timestamp: BASE + 20 * MIN, open: 64899, high: 64899.5, low: 64896, close: 64896, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: breakdown.timestamp, data: breakdown }, null);

  assert.equal(ctx.commands.length, 1, 'exactly one TradeCommand, never zero, never more than one');
  assert.equal(ctx.commands[0].action, 'SHORT');
  assert.equal(model.patternCandidate, null, 'candidate cleared after confirmation');
});

test('FULL RESTART RECOVERY 9b: BULLISH mirror — recovered WAITING_FOR_BOUNDARY_BREAK + boundary break -> exactly ONE BUY TradeCommand', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [999000, 998000, 997000] }, { capitalAllocation: 10000 });
  await model.onHydrate(buildBullishBoundaryHistory());
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');

  const breakout = { timestamp: BASE + 20 * MIN, open: 60052, high: 60060, low: 60051, close: 60056, volume: null }; // closes above upper(60054)
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: breakout.timestamp, data: breakout }, null);

  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].action, 'LONG');
});

test('FULL RESTART RECOVERY 10: a pattern that ALREADY completed (BUY/SELL) in history does NOT get recreated — replay resets and searches forward, never reusing the completed Candle 1', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  const candles = buildBearishBoundaryHistory();
  // Replace the "stay inside" tail with a candle that actually CLOSES BELOW
  // the lower boundary (64898) -- i.e. the pattern already resolved to
  // SELL historically, followed by flat candles with no new touch.
  candles[17] = candleAt(17, 64897, 64897.5, 64894, 64894, BASE); // closes strictly below 64898 -> historical SELL resolution
  candles[18] = candleAt(18, 64800, 64830, 64770, 64800, BASE);
  candles[19] = candleAt(19, 64800, 64830, 64770, 64800, BASE);
  await model.onHydrate(candles);

  assert.equal(model.patternCandidate, null, 'the already-completed pattern must not remain active or be reused');
  assert.equal(ctx.commands.length, 0, 'hydration must never submit a trade for a historically-completed pattern');
});

test('FULL RESTART RECOVERY 11: restart does not duplicate an existing Trade — the position_already_open guard independently blocks any new evaluation regardless of recovered pattern state', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  await model.onHydrate(buildBearishBoundaryHistory());
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');

  // Simulate: the real position from this exact pattern is already open
  // (e.g. it was actually opened live moments before the restart).
  const positionContext = { side: 'SHORT', entryPrice: 64896, stopLoss: 64965 };
  const anyCandle = { timestamp: BASE + 20 * MIN, open: 64899, high: 64899.5, low: 64896, close: 64896, volume: null };
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: anyCandle.timestamp, data: anyCandle }, positionContext);

  assert.equal(ctx.commands.length, 0, 'no duplicate command may be submitted while a real position is already open');
});

test('FULL RESTART RECOVERY 12: a full historical R1 pattern under BULLISH trend now correctly triggers calibration during replay (mutates resistance[0], never trades)', async () => {
  // BULLISH trend: a historical RESISTANCE(R1) touch + Candle 2 + boundary
  // resolution is now a real, calibration-eligible pattern. It resolves
  // historically to a calibration (never a trade), mutating resistance[0]
  // to Candle 1's high — verified directly rather than assumed.
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 64800, 64830, 64770, 64800, BASE));
  candles[15] = candleAt(15, 64900, 64960, 64890, 64920, BASE); // Candle 1, touches R1=64950
  candles[16] = candleAt(16, 64900, 64901.5, 64898, 64898.5, BASE); // Candle 2, valid
  // candles[17] closes at 64800, strictly below the boundary lower(64898) -> resolves SELL historically -> calibration (not a trade)
  await model.onHydrate(candles);
  assert.equal(model.r1Calibrated, true, 'calibration must have been reconstructed from the full historical sequence');
  assert.equal(model.params.resistance[0], 64960, 'resistance[0] must be mutated to Pattern 1 Candle 1 high (64960)');
  assert.equal(model.params.resistance[1], 65000, 'R2 must remain unchanged');
  assert.equal(ctx.commands.length, 0, 'calibration must never submit a trade, even during replay');
});

test('FULL RESTART RECOVERY 13: hydration itself never trades, even across a full multi-stage historical replay', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] }, { capitalAllocation: 10000 });
  await model.onHydrate(buildBearishBoundaryHistory());
  assert.equal(ctx.commands.length, 0);
  assert.ok(!ctx.events.some((e) => e.eventType === 'DECISION'));
});

// =========================================================================
// Temporary hydration diagnostics have been removed (their investigation
// is complete). This preserves the real behavioral coverage that test used
// to also check alongside the now-removed log assertions, and adds a
// guard against reintroducing debug logging into Model002.js.
// =========================================================================

test('hydration recovery through a full boundary sequence still works correctly with the temporary diagnostic logging removed', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  await model.onHydrate(buildBearishBoundaryHistory());

  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');
  assert.equal(ctx.commands.length, 0);
  assert.ok(!ctx.events.some((e) => e.eventType === 'DECISION'));
});

test('Model002.js contains no console.log calls — the temporary hydration/replay diagnostics have been fully removed', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  assert.equal(/console\.log\(/.test(content), false, 'no debug logging should remain in Model002.js');
});

// =========================================================================
// Historical replay must never lose the latest valid touch just because a
// later candle failed as Candle 2, or a pattern resolved, on that same
// candle. A candle that fails Candle 2 (or resolves a boundary) is not
// thereby disqualified from ALSO being a fresh same-side touch of its own.
// =========================================================================

test('REPLAY GAP FIX 1: one historical Resistance touch -> WAITING_FOR_CANDLE2', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [63500, 63000, 62500], resistance: [64000, 63500, 63000] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 63900, 63920, 63880, 63900, BASE));
  candles[15] = candleAt(15, 63990, 64002.5, 63984, 63984, BASE);
  await model.onHydrate(candles);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.candle1.timestamp, BASE + 15 * MIN);
});

test('REPLAY GAP FIX 2: multiple historical touches -> the newest touch becomes Candle 1', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [63500, 63000, 62500], resistance: [64000, 63500, 63000] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 63900, 63920, 63880, 63900, BASE));
  for (let i = 12; i <= 16; i += 1) candles[i] = candleAt(i, 63990, 64002.5, 63984, 63984, BASE); // 5 consecutive touches, mirrors the real reported case
  await model.onHydrate(candles);
  assert.equal(model.patternCandidate.candle1.timestamp, BASE + 16 * MIN, 'must use the LAST of the consecutive touches, not an earlier one');
});

test('REPLAY GAP FIX 3 (CRITICAL — the exact reported real-world case): multiple touches with NO valid Candle 2 after the newest touch -> WAITING_FOR_CANDLE2, NEVER null', async () => {
  // Reproduces the real runtime data: 5 consecutive Resistance touches
  // (BEARISH, R1=64000) followed by candles that neither re-touch a level
  // nor touch the final Candle 1's body-low. Before the fix, this
  // incorrectly produced patternCandidate: null.
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [63500, 63000, 62500], resistance: [64000, 63500, 63000] });
  const touchOffsets = [15, 16, 17, 18, 19]; // mirrors the 5 consecutive real timestamps
  const candles = [];
  for (let i = 0; i < 15; i += 1) candles.push(candleAt(i, 63900, 63920, 63880, 63900, BASE));
  for (const off of touchOffsets) candles.push(candleAt(off, 63990, 64002.5, 63984, 63984, BASE));
  for (let i = 1; i <= 5; i += 1) candles.push(candleAt(19 + i, 63950, 63970, 63930, 63940, BASE)); // drifts away afterward, no further touch

  await model.onHydrate(candles);

  assert.notEqual(model.patternCandidate, null, 'must NEVER be null when a valid final touch exists with no later Candle 2');
  assert.equal(model.patternCandidate.direction, 'SELL');
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.candle1.timestamp, BASE + 19 * MIN, 'must be the LAST of the 5 touches');
  assert.equal(model.patternCandidate.matchedLevel.price, 64000);
  assert.equal(ctx.commands.length, 0);
});

test('REPLAY GAP FIX 4: a candle that FAILS Candle 2 for the old candidate but ALSO independently touches a fresh level becomes the NEW Candle 1 (the exact closed gap) — SELL', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [63500, 63000, 62500], resistance: [64000, 63500, 63000] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 63900, 63920, 63880, 63900, BASE));
  candles[15] = candleAt(15, 63990, 64002.5, 63984, 63984, BASE); // Candle 1, bodyLow = 63984
  // idx 16: touches Candle1's bodyLow (63984) but is BULLISH (open<close) ->
  // fails Candle 2 (must be bearish) -- AND independently touches R1=64000 again.
  candles[16] = candleAt(16, 63985, 64001, 63983, 63999, BASE);
  for (let i = 17; i < 20; i += 1) candles[i] = candleAt(i, 63950, 63970, 63930, 63940, BASE);

  await model.onHydrate(candles);

  assert.notEqual(model.patternCandidate, null, 'the candle that failed Candle 2 must still be recognized as its own fresh touch');
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.candle1.timestamp, BASE + 16 * MIN, 'the failing-Candle2 candle itself must become the new Candle 1');
  assert.equal(ctx.commands.length, 0);
});

test('REPLAY GAP FIX 5: newest touch followed by a genuinely valid Candle 2 -> WAITING_FOR_BOUNDARY_BREAK (unchanged, still correct)', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [63500, 63000, 62500], resistance: [64000, 63500, 63000] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 63982, 63983, 63981.5, 63982.5, BASE)); // filler kept INSIDE the boundaries Candle 2 below will establish
  candles[15] = candleAt(15, 63990, 64002.5, 63984, 63984, BASE); // Candle 1, bodyLow=63984
  candles[16] = candleAt(16, 63984, 63984.5, 63981, 63982, BASE); // touches bodyLow, bearish, valid Candle 2 -> boundaries [63981, 63984.5]
  await model.onHydrate(candles);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');
  assert.ok(model.patternCandidate.boundaries);
});

test('REPLAY GAP FIX 6: BULLISH + SUPPORT mirror — a candle that fails Candle 2 but independently touches a fresh Support level becomes the new Candle 1', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59500, 59000], resistance: [999000, 998000, 997000] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 61000, 61010, 60990, 61005, BASE));
  candles[15] = candleAt(15, 60010, 60016, 60000, 60016, BASE); // Candle 1 touches support 60000, bodyHigh = max(60010,60016) = 60016
  // idx 16: touches Candle1 bodyHigh (60016) but is BEARISH (open>close) -> fails Candle2 (must be bullish for BUY) -- AND independently touches support 60000 again.
  candles[16] = candleAt(16, 60017, 60018, 60000, 60001, BASE);
  for (let i = 17; i < 20; i += 1) candles[i] = candleAt(i, 61000, 61010, 60990, 61005, BASE);

  await model.onHydrate(candles);

  assert.notEqual(model.patternCandidate, null);
  assert.equal(model.patternCandidate.direction, 'BUY');
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
  assert.equal(model.patternCandidate.candle1.timestamp, BASE + 16 * MIN);
});

test('REPLAY GAP FIX 7: hydration still emits zero trades and zero DECISION events, even across this more complex replay', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [63500, 63000, 62500], resistance: [64000, 63500, 63000] });
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 63900, 63920, 63880, 63900, BASE));
  candles[15] = candleAt(15, 63990, 64002.5, 63984, 63984, BASE);
  candles[16] = candleAt(16, 63985, 64001, 63983, 63999, BASE);
  await model.onHydrate(candles);
  assert.equal(ctx.commands.length, 0);
  assert.ok(!ctx.events.some((e) => e.eventType === 'DECISION'));
});

// =========================================================================
// OPPOSITE-SIDE PATTERNS + ONE-TIME R1/S1 CALIBRATION (client-confirmed)
//   BULLISH + RESISTANCE -> SELL (R1 special: first pattern calibrates only)
//   BEARISH + SUPPORT    -> BUY  (S1 special: first pattern calibrates only)
//   R2/R3/S2/S3 -> normal, unchanged same-side-engine behavior
// =========================================================================

test('CALIBRATION: BULLISH + R1 Pattern 1 confirms with NO TradeCommand, mutates resistance[0] to Candle1.high, sets r1Calibrated', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] }, { capitalAllocation: 10000 });
  await model.onHydrate(flat(20, 64800, BASE));

  const c1 = candleAt(20, 64900, 64960, 64890, 64920, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  assert.equal(model.patternCandidate.isCalibrationPattern, true);

  const c2 = candleAt(21, 64900, 64901.5, 64898, 64898.5, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');

  const c3 = candleAt(22, 64898, 64898.2, 64895, 64895, BASE); // closes below lower(64898) -> would-be SELL -> calibration
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);

  assert.equal(ctx.commands.length, 0, 'Pattern 1 must NEVER submit a TradeCommand');
  assert.equal(model.patternCandidate, null, 'candidate cleared after calibration');
  assert.equal(model.r1Calibrated, true);
  assert.equal(model.params.resistance[0], 64960, 'resistance[0] must become Pattern 1 Candle1.high (64960)');
  assert.equal(model.params.resistance[1], 65000, 'R2 must be untouched');
  assert.equal(model.params.resistance[2], 65100, 'R3 must be untouched');
});

test('CALIBRATION: BULLISH + R1 Pattern 1 confirmation reason is a client-safe message, not a raw code, via the shared reason map', async () => {
  const { formatModel002Reason } = require('../public/js/renderers/model002-reason-map.js');
  const text = formatModel002Reason('r1_calibration_confirmed_no_trade');
  assert.equal(text, 'Pattern confirmed — R1 updated, waiting for next R1 pattern');
  assert.equal(/_/.test(text), false, 'must be human-readable, no raw snake_case leaking through');
});

test('CALIBRATION Q1: the confirming candle (Candle 3) itself is NOT reused as a fresh Candle 1, even though it happens to sit near the new R1 — strictly the next candle only', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] }, { capitalAllocation: 10000 });
  await model.onHydrate(flat(20, 64800, BASE));
  const c1 = candleAt(20, 64900, 64960, 64890, 64920, BASE); // new R1 will become 64960
  const c2 = candleAt(21, 64900, 64901.5, 64898, 64898.5, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);
  // Candle 3 ALSO touches the about-to-become-new R1 (64960) in its own range, in addition to resolving the boundary.
  const c3 = candleAt(22, 64958, 64965, 64896, 64896, BASE); // wicks up through 64960 AND closes below lower(64898)
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);

  assert.equal(model.r1Calibrated, true);
  assert.equal(model.patternCandidate, null, 'Candle 3 must NOT become a fresh Candle 1 despite touching the new R1 in the same candle');
  assert.equal(ctx.commands.length, 0);
});

test('CALIBRATION -> SECOND PATTERN: after calibration, a fresh R1 (new value) pattern produces a real SELL TradeCommand with SL = second pattern Candle1.high + 5', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] }, { capitalAllocation: 10000 });
  await model.onHydrate(flat(20, 64800, BASE));

  // Pattern 1 (calibration)
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: candleAt(20, 64900, 64960, 64890, 64920, BASE).timestamp, data: candleAt(20, 64900, 64960, 64890, 64920, BASE) }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: candleAt(21, 64900, 64901.5, 64898, 64898.5, BASE).timestamp, data: candleAt(21, 64900, 64901.5, 64898, 64898.5, BASE) }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: candleAt(22, 64898, 64898.2, 64895, 64895, BASE).timestamp, data: candleAt(22, 64898, 64898.2, 64895, 64895, BASE) }, null);
  assert.equal(model.r1Calibrated, true);
  assert.equal(ctx.commands.length, 0);

  // Pattern 2 (real trade), starting from candle idx 23 (the very next candle after Pattern 1's Candle 3 at idx 22)
  const p2c1 = candleAt(23, 64955, 64965, 64950, 64960, BASE); // touches new R1=64960
  const p2c2 = candleAt(24, 64955, 64956.5, 64953, 64953.5, BASE); // valid Candle 2
  const p2c3 = candleAt(25, 64953, 64953.2, 64950, 64950, BASE); // closes below lower(64953) -> real SELL
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: p2c1.timestamp, data: p2c1 }, null);
  assert.equal(model.patternCandidate.isCalibrationPattern, false, 'Pattern 2 must NOT be calibration-eligible — R1 is already calibrated');
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: p2c2.timestamp, data: p2c2 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: p2c3.timestamp, data: p2c3 }, null);

  assert.equal(ctx.commands.length, 1, 'Pattern 2 must submit exactly one real TradeCommand');
  assert.equal(ctx.commands[0].action, 'SHORT');
  assert.equal(ctx.commands[0].stopLoss, 64970, 'SL must be Pattern 2 Candle1.high(64965) + 5, never derived from Pattern 1');
});

test('CALIBRATION: R2 (BULLISH+RESISTANCE, index 2) behaves as a completely normal trade — never calibration-eligible', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [70000, 64950, 65100] }, { capitalAllocation: 10000 });
  await model.onHydrate(flat(20, 64800, BASE));
  const c1 = candleAt(20, 64900, 64960, 64890, 64920, BASE); // touches R2=64950 (index 2)
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  assert.equal(model.patternCandidate.matchedLevel.index, 2);
  assert.equal(model.patternCandidate.isCalibrationPattern, false, 'R2 must never be calibration-eligible, only R1');
});

test('CALIBRATION: BEARISH + S1 Pattern 1 confirms with NO TradeCommand, mutates support[0] to Candle1.low, sets s1Calibrated', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60040, 59000, 58000], resistance: [999000, 998000, 997000] }, { capitalAllocation: 10000 });
  await model.onHydrate(flat(20, 60200, BASE));

  const c1 = candleAt(20, 60100, 60110, 60040, 60060, BASE); // touches S1=60040
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  assert.equal(model.patternCandidate.isCalibrationPattern, true);

  // Candle2: touches Candle1 bodyHigh=max(60100,60060)=60100, bullish, valid
  const c2 = candleAt(21, 60099, 60102, 60098.5, 60101, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');

  const c3 = candleAt(22, 60102, 60105, 60101.8, 60105, BASE); // closes above upper(60102) -> would-be BUY -> calibration
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate, null);
  assert.equal(model.s1Calibrated, true);
  assert.equal(model.params.support[0], 60040, 'support[0] must become Pattern 1 Candle1.low (60040)');
  assert.equal(model.params.support[1], 59000, 'S2 must be untouched');
});

test('CALIBRATION: S3 (BEARISH+SUPPORT, index 3) behaves as a completely normal trade — never calibration-eligible', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [40000, 59000, 60040], resistance: [999000, 998000, 997000] }, { capitalAllocation: 10000 });
  await model.onHydrate(flat(20, 60200, BASE));
  const c1 = candleAt(20, 60100, 60110, 60040, 60060, BASE); // touches S3=60040 (index 3)
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  assert.equal(model.patternCandidate.matchedLevel.index, 3);
  assert.equal(model.patternCandidate.isCalibrationPattern, false);
});

test('CALIBRATION: zero Positions/Orders/Trades result from Pattern 1 — only submitTradeCommand is the pipeline entry point, and it is never called', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] }, { capitalAllocation: 10000 });
  await model.onHydrate(flat(20, 64800, BASE));
  const candles = [
    candleAt(20, 64900, 64960, 64890, 64920, BASE),
    candleAt(21, 64900, 64901.5, 64898, 64898.5, BASE),
    candleAt(22, 64898, 64898.2, 64895, 64895, BASE),
  ];
  for (const c of candles) {
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c.timestamp, data: c }, null);
  }
  assert.equal(ctx.commands.length, 0, 'no TradeCommand means no downstream Position/Order/Trade can ever be created for Pattern 1');
});

// --- Restart/replay reconstructs calibration -----------------------------

test('RESTART REPLAY: calibration that completed entirely within the hydrated window is correctly reconstructed (r1Calibrated=true, resistance[0] mutated)', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] }, { capitalAllocation: 10000 });
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(candleAt(i, 64800, 64830, 64770, 64800, BASE));
  candles[15] = candleAt(15, 64900, 64960, 64890, 64920, BASE);
  candles[16] = candleAt(16, 64900, 64901.5, 64898, 64898.5, BASE);
  candles[17] = candleAt(17, 64898, 64898.2, 64895, 64895, BASE); // resolves calibration within the window
  await model.onHydrate(candles);

  assert.equal(model.r1Calibrated, true);
  assert.equal(model.params.resistance[0], 64960);
  assert.equal(model.patternCandidate, null, 'Q1: the resolving candle itself must not become a fresh Candle 1 during replay either');
  assert.equal(ctx.commands.length, 0);
});

test('RESTART REPLAY: an unfinished SECOND pattern (post-calibration) reconstructs correctly as WAITING_FOR_BOUNDARY_BREAK, not calibration-eligible', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] }, { capitalAllocation: 10000 });
  const candles = [];
  for (let i = 0; i < 14; i += 1) candles.push(candleAt(i, 64800, 64830, 64770, 64800, BASE));
  candles[14] = candleAt(14, 64900, 64960, 64890, 64920, BASE); // Pattern 1 Candle 1
  candles[15] = candleAt(15, 64900, 64901.5, 64898, 64898.5, BASE); // Pattern 1 Candle 2
  candles[16] = candleAt(16, 64898, 64898.2, 64895, 64895, BASE); // Pattern 1 resolves -> calibration
  candles[17] = candleAt(17, 64955, 64965, 64950, 64960, BASE); // Pattern 2 Candle 1 (touches new R1=64960)
  candles[18] = candleAt(18, 64955, 64956.5, 64953, 64953.5, BASE); // Pattern 2 Candle 2 -> WAITING_FOR_BOUNDARY_BREAK
  candles[19] = candleAt(19, 64954, 64955, 64953.5, 64954, BASE); // stays inside boundaries
  await model.onHydrate(candles);

  assert.equal(model.r1Calibrated, true);
  assert.ok(model.patternCandidate);
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_BOUNDARY_BREAK');
  assert.equal(model.patternCandidate.isCalibrationPattern, false, 'Pattern 2 reconstructed after calibration must not be calibration-eligible');
  assert.equal(ctx.commands.length, 0);
});

// --- Known, documented limitation: no MongoDB persistence yet ------------

test('CALIBRATION HISTORY OUTSIDE HYDRATION WINDOW: when Pattern 1\'s calibration evidence predates the hydrated window, replay honestly defaults to uncalibrated (documented limitation, not a silent guess)', async () => {
  // Simulates a restart whose hydration window only contains what would,
  // in reality, be the SECOND (post-calibration) pattern's data — Pattern
  // 1's own Candle 1/2/3 happened earlier and has aged out of the window.
  // Without MongoDB persistence, replay has no way to know calibration
  // already occurred, so it deterministically (and honestly) starts from
  // r1Calibrated=false and treats this R1 touch as calibration-eligible
  // again. This is the CURRENT, documented, tested behavior — not a bug
  // being silently papered over.
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [64960, 65000, 65100] }, { capitalAllocation: 10000 });
  // Window contains ONLY what would be "Pattern 2" in a real continuous
  // run — Pattern 1's own candles are not present at all.
  const candles = [];
  for (let i = 0; i < 17; i += 1) candles.push(candleAt(i, 64800, 64830, 64770, 64800, BASE));
  candles[17] = candleAt(17, 64955, 64965, 64950, 64960, BASE); // touches resistance[0]=64960 -- looks like a fresh R1 touch
  await model.onHydrate(candles);

  assert.ok(model.patternCandidate);
  assert.equal(
    model.patternCandidate.isCalibrationPattern, true,
    'documented limitation: with no persisted calibration flag, a restart whose window misses the original calibration evidence will treat the next R1 touch as calibration-eligible again'
  );
  assert.equal(model.r1Calibrated, false, 'r1Calibrated honestly reflects only what THIS window\'s replay actually witnessed — never guessed true');
});

// =========================================================================
// READINESS DECOUPLING: startup readiness is a fixed 3-candle threshold,
// independent of historySize (which continues to govern the pattern
// engine's rolling buffer window and hydration fetch cap, unchanged).
// =========================================================================

test('READINESS: bot is NOT ready with 0, 1, or 2 candles, and becomes ready at exactly 3 — not 20 (historySize)', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  assert.equal(model.getReadiness().required, 3, 'readiness threshold must be 3, decoupled from historySize=20');

  await model.onHydrate([]);
  assert.equal(model.getReadiness().ready, false);
  assert.equal(model.getReadiness().have, 0);

  const flatCandle = (i) => candleAt(i, 64800, 64830, 64770, 64800, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: flatCandle(0).timestamp, data: flatCandle(0) }, null);
  assert.equal(model.getReadiness().have, 1);
  assert.equal(model.getReadiness().ready, false);

  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: flatCandle(1).timestamp, data: flatCandle(1) }, null);
  assert.equal(model.getReadiness().have, 2);
  assert.equal(model.getReadiness().ready, false);

  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: flatCandle(2).timestamp, data: flatCandle(2) }, null);
  assert.equal(model.getReadiness().have, 3);
  assert.equal(model.getReadiness().ready, true, 'must become ready at exactly the 3rd new closed candle');
});

test('READINESS: the model still correctly evaluates real patterns once ready — decoupling readiness from historySize does not affect pattern detection', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  await model.onHydrate([]);
  for (let i = 0; i < 3; i += 1) {
    const flat = candleAt(i, 64800, 64830, 64770, 64800, BASE);
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: flat.timestamp, data: flat }, null);
  }
  assert.equal(model.getReadiness().ready, true);

  const touch = candleAt(3, 64900, 64960, 64890, 64920, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, null);
  assert.ok(model.patternCandidate, 'a real Resistance touch must still correctly start a pattern once ready');
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
});
