'use strict';

/**
 * MODEL_002 — pattern engine formula tests plus all-four-route integration
 * coverage. Covers touch detection, Candle 2 shape validation
 * (UpperP/LowerP/BodyP + candle nature), stop loss, risk length, lot mapping,
 * and the running-candle boundary trigger used by all four MODEL_002 patterns.
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

function candleAt(idx, o, h, l, cl, startTs = BASE) {
  return { timestamp: startTs + idx * MIN, open: o, high: h, low: l, close: cl, volume: null };
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

test('evaluateBoundaryBreak (BUY): running wick reaches upper -> BUY without candle close', () => {
  const b = { upper: 60100, lower: 60000 };
  assert.equal(sp.evaluateBoundaryBreak({ high: 60100, low: 60050, close: 60080 }, b, 'BUY').outcome, 'BUY');
});

test('evaluateBoundaryBreak (BUY): running wick is above upper while close remains inside -> BUY', () => {
  const b = { upper: 60100, lower: 60000 };
  assert.equal(sp.evaluateBoundaryBreak({ high: 60101, low: 60050, close: 60090 }, b, 'BUY').outcome, 'BUY');
});

test('evaluateBoundaryBreak (BUY): high below upper and close inside -> WAIT', () => {
  const b = { upper: 60100, lower: 60000 };
  assert.equal(sp.evaluateBoundaryBreak({ high: 60099.99, low: 60050, close: 60080 }, b, 'BUY').outcome, 'WAIT');
});

test('evaluateBoundaryBreak (BUY): close exactly at upper but high below upper -> WAIT', () => {
  const b = { upper: 60100, lower: 60000 };
  assert.equal(sp.evaluateBoundaryBreak({ high: 60099.99, low: 60050, close: 60100 }, b, 'BUY').outcome, 'WAIT');
});

test('evaluateBoundaryBreak (BUY): close below lower -> INVALID', () => {
  const b = { upper: 60100, lower: 60000 };
  assert.equal(sp.evaluateBoundaryBreak({ high: 60050, low: 59990, close: 59999.99 }, b, 'BUY').outcome, 'INVALID');
});

test('evaluateBoundaryBreak (SELL): running wick reaches lower -> SELL without candle close', () => {
  const b = { upper: 65100, lower: 65000 };
  assert.equal(sp.evaluateBoundaryBreak({ high: 65050, low: 65000, close: 65030 }, b, 'SELL').outcome, 'SELL');
});

test('evaluateBoundaryBreak (SELL): running wick is below lower while close remains inside -> SELL', () => {
  const b = { upper: 65100, lower: 65000 };
  assert.equal(sp.evaluateBoundaryBreak({ high: 65050, low: 64999, close: 65020 }, b, 'SELL').outcome, 'SELL');
});

test('evaluateBoundaryBreak (SELL): low above lower and close inside -> WAIT', () => {
  const b = { upper: 65100, lower: 65000 };
  assert.equal(sp.evaluateBoundaryBreak({ high: 65050, low: 65000.01, close: 65020 }, b, 'SELL').outcome, 'WAIT');
});

test('evaluateBoundaryBreak (SELL): close exactly at lower but low above lower -> WAIT', () => {
  const b = { upper: 65100, lower: 65000 };
  assert.equal(sp.evaluateBoundaryBreak({ high: 65050, low: 65000.01, close: 65000 }, b, 'SELL').outcome, 'WAIT');
});

test('evaluateBoundaryBreak (SELL): close above upper -> INVALID', () => {
  const b = { upper: 65100, lower: 65000 };
  assert.equal(sp.evaluateBoundaryBreak({ high: 65110, low: 65050, close: 65100.01 }, b, 'SELL').outcome, 'INVALID');
});

test('BULLISH + RESISTANCE SELL: running wick touching lower triggers immediately without candle close', async () => {
  const { ctx, model } = await startedModel({
    trend: 'BULLISH',
    support: [60000, 59000, 58000],
    resistance: [65000, 66000, 67000],
  }, { capitalAllocation: 10000 });
  await model.onHydrate(flat(20, 64000, BASE));

  const a = candleAt(20, 65020, 65030, 65010, 65015, BASE);
  const b = candleAt(21, 65010, 65015, 64995, 65000, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a.timestamp, data: a }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);

  assert.equal(model.patternCandidate.engine, 'NEW');
  assert.equal(model.patternCandidate.direction, 'SELL');
  assert.equal(model.patternCandidate.stage, 'AWAITING_CANDLE3');
  assert.equal(model.patternCandidate.boundaries.lower, 64990);

  // Running price touches lower; no candle close is required.
  await model.onMarketData({
    type: 'price', symbol: 'BTCUSD', timestamp: b.timestamp + 10000, data: { price: 64990 },
  }, null);

  assert.equal(ctx.commands.length, 0, 'R1 first setup is calibration-only');
  assert.equal(model.r1Calibrated, true);
});

test('BEARISH + SUPPORT BUY: same NEW running-wick pattern as BULLISH + SUPPORT', async () => {
  const { ctx, model } = await startedModel({
    trend: 'BEARISH',
    support: [58000, 59900, 59800],
    resistance: [70000, 69000, 68000],
  }, { capitalAllocation: 10000 });
  await model.onHydrate(flat(20, 60000, BASE));

  // B is the support-touch candle, exactly like BULLISH+SUPPORT. It is S2,
  // so it is not subject to the one-time S1 calibration.
  const b = candleAt(20, 60050, 60205, 59900, 60200, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);

  assert.equal(model.patternCandidate.stage, 'AWAITING_CANDLE3');
  assert.equal(model.patternCandidate.direction, 'BUY');
  assert.equal(model.patternCandidate.engine, 'NEW');
  assert.deepEqual(model.patternCandidate.boundaries, { upper: 60210, lower: 59895 });

  // Running price touches the upper boundary while the forming candle close
  // remains below it. BUY must trigger immediately.
  await model.onMarketData({
    type: 'price', symbol: 'BTCUSD', timestamp: b.timestamp + 10_000, data: { price: 60210 },
  }, null);

  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].action, 'LONG');
});

// =========================================================================
// NOTE: the old "E2E BUY/SELL: Model002 3-candle state machine" section
// (touch->search-for-Candle2->boundary trigger, for the SAME-SIDE
// combinations BULLISH+SUPPORT/BEARISH+RESISTANCE) has been REMOVED from
// this file. That exact behavior was superseded by the NEW A/B/C
// wick-trigger spec — see reversalPatternEngine.js and
// tests/model002.reversalPattern.test.js for full coverage of same-side
// patterns now. sameSidePatternEngine.js itself is UNCHANGED and its unit
// tests above still pass — it is still used for opposite-side combinations
// (R1/S1 calibration) below, which are unaffected by this revision.
// =========================================================================

// =========================================================================
// ALL FOUR ACTIVE MODEL_002 COMBINATIONS USE THE SAME NEW A/B/C ENGINE
//   BULLISH + SUPPORT    -> BUY
//   BEARISH + SUPPORT    -> BUY (first S1 calibration-only)
//   BULLISH + RESISTANCE -> SELL (mirror; first R1 calibration-only)
//   BEARISH + RESISTANCE -> SELL
// =========================================================================

function bearishSellA(idx) {
  return candleAt(idx, 65020, 65030, 65010, 65015, BASE);
}

function bearishSellB(idx, level = 65000) {
  return candleAt(idx, 65010, 65015, level - 5, 65000, BASE);
}

test('BULLISH + RESISTANCE (R1) uses NEW SELL A/B/C flow and first R1 is calibration-only', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [65000, 66000, 67000] });
  await model.onHydrate(flat(20, 64000, BASE));

  const a = bearishSellA(20);
  const b = bearishSellB(21);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a.timestamp, data: a }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);

  assert.ok(model.patternCandidate);
  assert.equal(model.patternCandidate.engine, 'NEW');
  assert.equal(model.patternCandidate.direction, 'SELL');
  assert.equal(model.patternCandidate.stage, 'AWAITING_CANDLE3');
  assert.equal(model.patternCandidate.isCalibrationPattern, true);

  const c3 = candleAt(22, 65000, 65005, 64990, 65002, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);

  assert.equal(ctx.commands.length, 0);
  assert.equal(model.r1Calibrated, true);
  assert.equal(model.params.resistance[0], a.high);
});

test('BULLISH + RESISTANCE: after R1 calibration, R1 uses the same normal NEW SELL pattern and running trigger', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [65000, 66000, 67000] }, { capitalAllocation: 10000 });
  await model.onHydrate(flat(20, 64000, BASE));

  // First R1 calibration pattern.
  const a1 = bearishSellA(20);
  const b1 = bearishSellB(21);
  const c1 = candleAt(22, 65000, 65005, 64990, 65002, BASE);
  for (const c of [a1, b1, c1]) {
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c.timestamp, data: c }, null);
  }
  assert.equal(model.r1Calibrated, true);
  assert.equal(model.params.resistance[0], 65030);
  assert.equal(ctx.commands.length, 0);

  // Second R1 setup is normal NEW SELL, exactly mirroring post-calibration S1 BUY.
  const a2 = candleAt(23, 65035, 65040, 65025, 65030, BASE);
  const b2 = candleAt(24, 65030, 65035, 65015, 65020, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a2.timestamp, data: a2 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b2.timestamp, data: b2 }, null);
  assert.equal(model.patternCandidate.engine, 'NEW');
  assert.equal(model.patternCandidate.direction, 'SELL');
  assert.equal(model.patternCandidate.isCalibrationPattern, false);

  // Running low touches lower; close remains above it.
  const c2 = candleAt(25, 65020, 65025, 65010, 65018, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c2.timestamp, data: c2 }, null);
  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].action, 'SHORT');
});

test('BULLISH + RESISTANCE: R2 and R3 are normal NEW SELL patterns, never calibration', async () => {
  for (const [index, level] of [[2, 66000], [3, 67000]]) {
    const resistance = index === 2 ? [70000, 66000, 71000] : [70000, 71000, 67000];
    const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [50000, 51000, 52000], resistance });
    await model.onHydrate(flat(20, 64000, BASE));
    const a = candleAt(20, level + 20, level + 30, level + 10, level + 15, BASE);
    const b = candleAt(21, level + 10, level + 15, level - 5, level, BASE);
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a.timestamp, data: a }, null);
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
    assert.ok(model.patternCandidate);
    assert.equal(model.patternCandidate.engine, 'NEW');
    assert.equal(model.patternCandidate.direction, 'SELL');
    assert.equal(model.patternCandidate.matchedLevel.index, index);
    assert.equal(model.patternCandidate.isCalibrationPattern, false);
    assert.equal(ctx.commands.length, 0);
  }
});

test('BULLISH + RESISTANCE: first R1 running-candle SELL is consumed as calibration, not traded', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [65000, 66000, 67000] });
  await model.onHydrate(flat(20, 64000, BASE));
  const a = bearishSellA(20);
  const b = bearishSellB(21);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a.timestamp, data: a }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', timestamp: b.timestamp + 10000, data: { price: 64990 } }, null);
  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate, null);
  assert.equal(model.r1Calibrated, true);
});

// S1/S2/S3 BUY behavior remains the exact mirror on the opposite trend side.
test('BEARISH + SUPPORT: S1/S2/S3 all use the same NEW BUY pattern after the one-time S1 calibration', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60040, 59000, 58000], resistance: [70000, 69000, 68000] });
  await model.onHydrate(flat(20, 60200, BASE));

  const a1 = candleAt(20, 60100, 60200, 60100, 60150, BASE);
  const b1 = candleAt(21, 60100, 60310, 60040, 60300, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a1.timestamp, data: a1 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b1.timestamp, data: b1 }, null);
  assert.equal(model.patternCandidate.engine, 'NEW');
  assert.equal(model.patternCandidate.isCalibrationPattern, true);

  const c1 = candleAt(22, 60300, 60315, 60250, 60310, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c1.timestamp, data: c1 }, null);
  assert.equal(model.s1Calibrated, true);
  assert.equal(ctx.commands.length, 0);

  // S1 after calibration: ordinary NEW BUY.
  const a2 = candleAt(23, 60300, 60400, 60250, 60350, BASE);
  const b2 = candleAt(24, 60120, 60410, 60100, 60400, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a2.timestamp, data: a2 }, null);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b2.timestamp, data: b2 }, null);
  assert.equal(model.patternCandidate.isCalibrationPattern, false);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', timestamp: b2.timestamp + 10000, data: { price: 60415 } }, null);
  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].action, 'LONG');

  // Rerun S2/S3 in isolated bots: same NEW BUY algorithm and never calibration.
  for (const [index, level, support] of [[2, 59000, [50000, 59000, 58000]], [3, 58000, [50000, 51000, 58000]]]) {
    const { model: m } = await startedModel({ trend: 'BEARISH', support, resistance: [70000, 69000, 68000] });
    await m.onHydrate(flat(20, 60000, BASE));
    const a = candleAt(20, level + 100, level + 120, level + 80, level + 110, BASE);
    const b = candleAt(21, level + 105, level + 310, level - 5, level + 300, BASE);
    await m.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: a.timestamp, data: a }, null);
    await m.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
    assert.equal(m.patternCandidate.engine, 'NEW');
    assert.equal(m.patternCandidate.direction, 'BUY');
    assert.equal(m.patternCandidate.matchedLevel.index, index);
    assert.equal(m.patternCandidate.isCalibrationPattern, false);
  }
});

// =========================================================================
// READINESS: pattern finding starts after the first eligible candle.
// A second candle is still required when a level touch needs A/B validation;
// readiness itself must never wait for three candles.
// =========================================================================

test('READINESS: bot becomes ready with the first eligible candle', async () => {
  const { model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  assert.equal(model.getReadiness().required, 1, 'readiness threshold must be 1');

  await model.onHydrate([]);
  assert.equal(model.getReadiness().ready, false);
  assert.equal(model.getReadiness().have, 0);

  const first = candleAt(0, 64800, 64830, 64770, 64800, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: first.timestamp, data: first }, null);
  assert.equal(model.getReadiness().have, 1);
  assert.equal(model.getReadiness().ready, true, 'must become ready after the first eligible closed candle');
});

test('READINESS: pattern finding is attempted immediately after first candle, not blocked until 3 candles', async () => {
  const { ctx, model } = await startedModel({ trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [999000, 998000, 997000] });
  const first = candleAt(0, 60020, 60030, 60010, 60020, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: first.timestamp, data: first }, null);
  assert.equal(model.getReadiness().ready, true);
  const decision = lastDecision(ctx);
  assert.equal(decision.payload.decision, 'WAIT');
  assert.equal(decision.payload.reason, 'no_level_touch');
});

test('READINESS: the model still correctly evaluates real patterns once ready — decoupling readiness from historySize does not affect pattern detection', async () => {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: [60000, 59000, 58000], resistance: [64950, 65000, 65100] });
  await model.onHydrate([]);
  const first = candleAt(0, 64800, 64830, 64770, 64800, BASE); // A: bodyLow = 64800
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: first.timestamp, data: first }, null);
  assert.equal(model.getReadiness().ready, true);

  // B: touches resistance (high>=64950), bearish, bodyLow(64750) < A's bodyLow(64800), BodyP dominant.
  const touch = candleAt(3, 64900, 64960, 64740, 64750, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, null);
  assert.ok(model.patternCandidate, 'a real Resistance touch must still correctly start a pattern once ready');
  assert.equal(model.patternCandidate.stage, 'AWAITING_CANDLE3');
  assert.equal(model.patternCandidate.engine, 'NEW');
});
