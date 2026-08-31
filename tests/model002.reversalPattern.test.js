'use strict';

/**
 * MODEL_002 — NEW reversal pattern spec tests (A/B/C wick-trigger).
 *
 * Covers the requirement's own test list (its section "TESTS", items 1-37)
 * for the same-side combinations this spec targets:
 *   BULLISH + SUPPORT    -> BUY
 *   BEARISH + RESISTANCE -> SELL
 *
 * Both the pure engine (reversalPatternEngine.js) and full Model002
 * integration are exercised. Opposite-side combinations (BULLISH+RESISTANCE,
 * BEARISH+SUPPORT, R1/S1 calibration) are unaffected by this spec — see
 * tests/model002.sameSidePattern.test.js for their continued coverage.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Model002 = require('../bot-models/model-002/Model002');
const re = require('../bot-models/model-002/reversalPatternEngine');

const MIN = 60000;
const BASE = 1_700_000_000_000;

function candleAt(idx, o, h, l, cl, startTs = BASE) {
  return { timestamp: startTs + idx * MIN, open: o, high: h, low: l, close: cl, volume: null };
}

function flat(count, price, startTs = BASE) {
  const arr = [];
  for (let i = 0; i < count; i += 1) arr.push(candleAt(i, price, price + 0.01, price - 0.01, price, startTs));
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
    parameters: Object.assign({
      timeframe: '1m', trend: 'BULLISH',
      support: [60000, 55000, 50000], resistance: [999000, 998000, 997000],
    }, parameters),
    capitalAllocation: 10000, leverage: 10, riskSettings: {},
  }, instanceOverrides));
  return { ctx, model };
}

function lastDecision(ctx) {
  return ctx.events.filter((e) => e.eventType === 'DECISION').pop();
}

// =========================================================================
// Pure engine unit tests (reversalPatternEngine.js)
// =========================================================================

test('touchesSupport: wick touch valid (low<=level even if high<level too — gap-through counts)', () => {
  assert.equal(re.touchesSupport({ low: 59990, high: 59995 }, 60000), true);
});
test('touchesSupport: body touch valid', () => {
  assert.equal(re.touchesSupport({ low: 59990, high: 60010, open: 59995, close: 60005 }, 60000), true);
});
test('touchesSupport: no touch when low > level', () => {
  assert.equal(re.touchesSupport({ low: 60001, high: 60010 }, 60000), false);
});
test('touchesResistance mirror', () => {
  assert.equal(re.touchesResistance({ low: 64995, high: 65010 }, 65000), true);
  assert.equal(re.touchesResistance({ low: 64995, high: 64999 }, 65000), false);
});

test('validateAB (BUY): B_bodyHigh > A_bodyHigh -> valid (worked example)', () => {
  const A = { open: 100, close: 104 }; // bodyHigh 104
  const B = { open: 102, close: 105 }; // bodyHigh 105
  const result = re.validateAB(A, B, 'BUY');
  assert.equal(result.valid, true);
});
test('validateAB (BUY): B_bodyHigh <= A_bodyHigh -> invalid', () => {
  const A = { open: 100, close: 104 };
  const B = { open: 101, close: 104 }; // bodyHigh 104, not > 104
  assert.equal(re.validateAB(A, B, 'BUY').valid, false);
});
test('validateAB (SELL): B_bodyLow < A_bodyLow -> valid (mirror)', () => {
  const A = { open: 104, close: 100 }; // bodyLow 100
  const B = { open: 103, close: 97 };  // bodyLow 97
  assert.equal(re.validateAB(A, B, 'SELL').valid, true);
});
test('validateAB (SELL): B_bodyLow >= A_bodyLow -> invalid', () => {
  const A = { open: 104, close: 100 };
  const B = { open: 103, close: 100 };
  assert.equal(re.validateAB(A, B, 'SELL').valid, false);
});

test('computeBoundaries: upper = B.high+5, lower = B.low-5 (worked example)', () => {
  const b = re.computeBoundaries({ high: 100, low: 90 });
  assert.equal(b.upper, 105);
  assert.equal(b.lower, 85);
});

test('evaluateCandle3 (BUY): C.high >= upper -> BUY, even mid-range (wick touch, no close needed)', () => {
  const result = re.evaluateCandle3({ high: 105, low: 95, close: 96 }, { upper: 105, lower: 85 }, 'BUY', null);
  assert.equal(result.outcome, 'BUY');
});
test('evaluateCandle3 (BUY): C.high crosses upper -> BUY', () => {
  const result = re.evaluateCandle3({ high: 106, low: 95, close: 96 }, { upper: 105, lower: 85 }, 'BUY', null);
  assert.equal(result.outcome, 'BUY');
});
test('evaluateCandle3 (BUY): C.low <= lower -> INVALID, never SELL', () => {
  const result = re.evaluateCandle3({ high: 90, low: 85, close: 87 }, { upper: 105, lower: 85 }, 'BUY', null);
  assert.equal(result.outcome, 'INVALID');
});
test('evaluateCandle3 (BUY): neither boundary touched -> WAIT, never INVALID ("no trigger" is not "invalid")', () => {
  const result = re.evaluateCandle3({ high: 95, low: 90, close: 92 }, { upper: 105, lower: 85 }, 'BUY', null);
  assert.equal(result.outcome, 'WAIT');
});
test('evaluateCandle3 (SELL): C.low <= lower -> SELL', () => {
  const result = re.evaluateCandle3({ high: 96, low: 85, close: 90 }, { upper: 105, lower: 85 }, 'SELL', null);
  assert.equal(result.outcome, 'SELL');
});
test('evaluateCandle3 (SELL): C.high >= upper -> INVALID, never BUY', () => {
  const result = re.evaluateCandle3({ high: 105, low: 96, close: 100 }, { upper: 105, lower: 85 }, 'SELL', null);
  assert.equal(result.outcome, 'INVALID');
});

test('evaluateCandle3: both boundaries touched, tieBreakSide=upper -> BUY for a BUY setup', () => {
  const result = re.evaluateCandle3({ high: 106, low: 84, close: 95 }, { upper: 105, lower: 85 }, 'BUY', 'upper');
  assert.equal(result.outcome, 'BUY');
  assert.equal(result.bothTouched, true);
  assert.equal(result.tieBreakUsed, true);
});
test('evaluateCandle3: both boundaries touched, tieBreakSide=lower -> INVALID for a BUY setup', () => {
  const result = re.evaluateCandle3({ high: 106, low: 84, close: 95 }, { upper: 105, lower: 85 }, 'BUY', 'lower');
  assert.equal(result.outcome, 'INVALID');
  assert.equal(result.tieBreakUsed, true);
});
test('evaluateCandle3: both boundaries touched, NO tick evidence -> conservative INVALID, not a silent guess', () => {
  const result = re.evaluateCandle3({ high: 106, low: 84, close: 95 }, { upper: 105, lower: 85 }, 'BUY', null);
  assert.equal(result.outcome, 'INVALID');
  assert.equal(result.bothTouched, true);
  assert.equal(result.tieBreakUsed, false);
});
test('evaluateCandle3: both boundaries touched, tieBreakSide=lower -> SELL for a SELL setup (mirror)', () => {
  const result = re.evaluateCandle3({ high: 106, low: 84, close: 95 }, { upper: 105, lower: 85 }, 'SELL', 'lower');
  assert.equal(result.outcome, 'SELL');
});

test('computeBuyStopLoss: lowest wick LOW across B and C, minus 10 (worked example)', () => {
  assert.equal(re.computeBuyStopLoss({ low: 99 }, { low: 97 }), 87);
});
test('computeSellStopLoss: highest wick HIGH across B and C, plus 10 (worked example)', () => {
  assert.equal(re.computeSellStopLoss({ high: 105 }, { high: 108 }), 118);
});
test('computeBuyStopLoss: uses whichever of B/C actually has the lower low', () => {
  assert.equal(re.computeBuyStopLoss({ low: 50 }, { low: 60 }), 40); // B lower
  assert.equal(re.computeBuyStopLoss({ low: 60 }, { low: 50 }), 40); // C lower
});

// =========================================================================
// Full Model002 integration — BULLISH + SUPPORT -> BUY
// Fixture: support=60000, A flat at 60010 (close to the level, so a real
// trade keeps riskLength <= 360 — see reasoning in the task notes).
// =========================================================================

const BUY_SUPPORT = [60000, 55000, 50000];
const BUY_RESISTANCE = [999000, 998000, 997000];

function buyFixture(overrides) {
  return startedModel(Object.assign({ trend: 'BULLISH', support: BUY_SUPPORT, resistance: BUY_RESISTANCE }, overrides));
}

/** A: flat at 60010 (bodyHigh=60010). */
function buyA() { return flat(20, 60010, BASE); }

/** Valid B: touches support (low<=60000), bodyHigh(60050)>A's bodyHigh(60010), BodyP dominant, bullish. */
const VALID_B_BUY = candleAt(20, 60005, 60060, 59995, 60050);
// boundaries: upper = 60065, lower = 59990

test('1/2. Support touch valid via wick OR body (both accepted the same way)', async () => {
  const { model: m1 } = await buyFixture();
  await m1.onHydrate(buyA());
  await m1.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  assert.equal(m1.patternCandidate.engine, 'NEW');

  const { model: m2 } = await buyFixture();
  await m2.onHydrate(buyA());
  const bodyTouch = candleAt(20, 60005, 60060, 60000, 60050); // low exactly at level (body/wick boundary touch)
  await m2.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: bodyTouch.timestamp, data: bodyTouch }, null);
  assert.equal(m2.patternCandidate.engine, 'NEW');
});

test('3. B_bodyHigh > A_bodyHigh -> A becomes Candle 1, B becomes Candle 2', async () => {
  const { model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  assert.equal(model.patternCandidate.candle1.close, 60010); // A
  assert.equal(model.patternCandidate.candle2.timestamp, VALID_B_BUY.timestamp); // B
});

test('4. B_bodyHigh <= A_bodyHigh -> A/B NOT accepted, no candidate, no boundaries', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  const badB = candleAt(20, 60005, 60060, 59995, 60009); // bodyHigh = 60009, not > A's 60010
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: badB.timestamp, data: badB }, null);
  assert.equal(model.patternCandidate, null);
  assert.equal(lastDecision(ctx).payload.reason, 'ab_body_high_not_greater');
  assert.equal(ctx.commands.length, 0);
});

test('5/6. Candle2 boundaries = B.high+5 / B.low-5 (wick, not body)', async () => {
  const { model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  assert.equal(model.patternCandidate.boundaries.upper, 60065);
  assert.equal(model.patternCandidate.boundaries.lower, 59990);
});

test('7/8/14. Candle3 touches or crosses upper -> IMMEDIATE BUY, no close required', async () => {
  for (const c3 of [
    candleAt(21, 60050, 60065, 60045, 60055), // touches exactly
    candleAt(21, 60050, 60070, 60045, 60055), // crosses
  ]) {
    const { ctx, model } = await buyFixture();
    await model.onHydrate(buyA());
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
    assert.equal(ctx.commands.length, 1, 'a close ABOVE upper is not required — the wick touch alone triggers');
    assert.equal(ctx.commands[0].action, 'LONG');
  }
});

test('9/10. Candle3 only touches lower -> INVALID, never SELL', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  const c3 = candleAt(21, 60000, 60005, 59985, 60000); // touches lower(59990), not upper
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate, null);
  const decision = lastDecision(ctx);
  assert.notEqual(decision.payload.decision, 'SELL');
  assert.equal(decision.payload.reason, 'invalidated_wrong_boundary_touched');
});

test('11/12. After invalidation, pattern restarts and does NOT reuse old Candle1/Candle2', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  const c3invalid = candleAt(21, 60000, 60005, 59985, 60000); // invalidates
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3invalid.timestamp, data: c3invalid }, null);
  assert.equal(model.patternCandidate, null);

  // D touches support again with a bodyHigh that WOULD have validated
  // against the old Candle2 (VALID_B_BUY, bodyHigh=60050) as its "A", but
  // must NOT be compared against it — only against the true immediately-
  // preceding candle, which is now c3invalid (bodyHigh=60000).
  const d = candleAt(22, 60010, 60070, 59995, 60040); // bodyHigh=60040: < old B's 60050 (would fail if old B were reused) but > c3invalid's 60000 (valid against the REAL previous candle)
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: d.timestamp, data: d }, null);
  assert.ok(model.patternCandidate, 'must validate against the true previous candle (c3invalid), not the old Candle2');
  assert.equal(model.patternCandidate.candle1.timestamp, c3invalid.timestamp);
  assert.equal(model.patternCandidate.candle2.timestamp, d.timestamp);
});

test('13. No re-check of Support during active A/B/C — Candle3 is processed strictly as C, even if it also touches Support again', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  // This C touches the lower boundary (59990), which is itself <= support (60000) — i.e. it ALSO independently touches Support.
  const c3 = candleAt(21, 60000, 60005, 59980, 60000);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  // Must be treated as the C/invalidation event, never as a fresh B/Candle2 replacing the active setup mid-flight.
  assert.equal(lastDecision(ctx).payload.reason, 'invalidated_wrong_boundary_touched');
  assert.equal(ctx.commands.length, 0);
});

test('15. BUY SL = lowest LOW from B through trigger, minus 10', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null); // B.low = 59995
  // C triggers BUY (high>=60065) but its OWN low (59993) is lower than B's low (59995) and above the lower boundary (59990) — must be used.
  const c3 = candleAt(21, 60050, 60070, 59993, 60060);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].stopLoss, 59993 - 10);
});

// =========================================================================
// Full Model002 integration — BEARISH + RESISTANCE -> SELL (mirror)
// =========================================================================

const SELL_SUPPORT = [1000, 900, 800];
const SELL_RESISTANCE = [65000, 70000, 75000];

function sellFixture(overrides) {
  return startedModel(Object.assign({ trend: 'BEARISH', support: SELL_SUPPORT, resistance: SELL_RESISTANCE }, overrides));
}
function sellA() { return flat(20, 64990, BASE); } // A: bodyLow = 64990
const VALID_B_SELL = candleAt(20, 64995, 65010, 64945, 64950); // touches resistance(65000), bodyLow=64950<64990, bearish
// boundaries: upper = 65015, lower = 64940

test('16/17. Resistance touch valid via wick OR body', async () => {
  const { model: m1 } = await sellFixture();
  await m1.onHydrate(sellA());
  await m1.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_SELL.timestamp, data: VALID_B_SELL }, null);
  assert.equal(m1.patternCandidate.engine, 'NEW');
});

test('18/19. B_bodyLow < A_bodyLow -> Candle1/Candle2; otherwise rejected', async () => {
  const { model } = await sellFixture();
  await model.onHydrate(sellA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_SELL.timestamp, data: VALID_B_SELL }, null);
  assert.equal(model.patternCandidate.candle1.close, 64990);
  assert.equal(model.patternCandidate.candle2.timestamp, VALID_B_SELL.timestamp);

  const { ctx: ctx2, model: model2 } = await sellFixture();
  await model2.onHydrate(sellA());
  const badB = candleAt(20, 64995, 65010, 64945, 64991); // bodyLow=64991, not < 64990
  await model2.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: badB.timestamp, data: badB }, null);
  assert.equal(model2.patternCandidate, null);
  assert.equal(lastDecision(ctx2).payload.reason, 'ab_body_low_not_less');
});

test('20. Boundaries are B.high+5 and B.low-5', async () => {
  const { model } = await sellFixture();
  await model.onHydrate(sellA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_SELL.timestamp, data: VALID_B_SELL }, null);
  assert.equal(model.patternCandidate.boundaries.upper, 65015);
  assert.equal(model.patternCandidate.boundaries.lower, 64940);
});

test('21/22/26. Candle3 touches or crosses lower -> IMMEDIATE SELL, no close required', async () => {
  for (const c3 of [
    candleAt(21, 64950, 64955, 64940, 64945), // touches exactly
    candleAt(21, 64950, 64955, 64935, 64945), // crosses
  ]) {
    const { ctx, model } = await sellFixture();
    await model.onHydrate(sellA());
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_SELL.timestamp, data: VALID_B_SELL }, null);
    await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
    assert.equal(ctx.commands.length, 1);
    assert.equal(ctx.commands[0].action, 'SHORT');
  }
});

test('23/24. Candle3 touches upper -> INVALID, never BUY', async () => {
  const { ctx, model } = await sellFixture();
  await model.onHydrate(sellA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_SELL.timestamp, data: VALID_B_SELL }, null);
  const c3 = candleAt(21, 65000, 65020, 64995, 65000); // touches upper(65015)
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  assert.equal(ctx.commands.length, 0);
  const decision = lastDecision(ctx);
  assert.notEqual(decision.payload.decision, 'BUY');
});

test('25. Complete pattern restarts after invalidation (SELL mirror)', async () => {
  const { model } = await sellFixture();
  await model.onHydrate(sellA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_SELL.timestamp, data: VALID_B_SELL }, null);
  const c3invalid = candleAt(21, 65000, 65020, 64995, 65000);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3invalid.timestamp, data: c3invalid }, null);
  assert.equal(model.patternCandidate, null);
});

test('27. SELL SL = highest HIGH from B through trigger, plus 10', async () => {
  const { ctx, model } = await sellFixture();
  await model.onHydrate(sellA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_SELL.timestamp, data: VALID_B_SELL }, null); // B.high = 65010
  const c3 = candleAt(21, 64950, 65012, 64935, 64945); // triggers SELL (low<=64940); own high (65012) > B.high (65010)
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].stopLoss, 65012 + 10);
});

// =========================================================================
// Both-boundary case (BUY setup) — live tick tie-break via existing
// type:'price' stream, reused (no new connection/listener).
// =========================================================================

test('28/29/31. Candle3 touches BOTH boundaries: live tick reaching upper FIRST -> BUY, never both', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  // Live tick touches the upper boundary (60065) BEFORE Candle 3 closes.
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 60065 }, timestamp: VALID_B_BUY.timestamp + 30000 }, null);
  const c3 = candleAt(21, 60020, 60070, 59980, 60020); // touches BOTH boundaries
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  assert.equal(ctx.commands.length, 1, 'exactly one outcome, never both');
  assert.equal(ctx.commands[0].action, 'LONG');
});

test('28/29/31. Candle3 touches BOTH boundaries: live tick reaching lower FIRST -> INVALID, never SELL from a BUY setup', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 59990 }, timestamp: VALID_B_BUY.timestamp + 30000 }, null);
  const c3 = candleAt(21, 60020, 60070, 59980, 60020);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  assert.equal(ctx.commands.length, 0);
  const decision = lastDecision(ctx);
  assert.notEqual(decision.payload.decision, 'SELL');
  assert.equal(decision.payload.reason, 'invalidated_both_boundaries_tick_order');
});

test('30. Both boundaries touched, no live tick evidence reached this instance -> honest conservative INVALID (documented limitation, not a guess)', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  const c3 = candleAt(21, 60020, 60070, 59980, 60020); // both boundaries, but NO price tick was ever sent
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  assert.equal(ctx.commands.length, 0);
  assert.equal(lastDecision(ctx).payload.reason, 'invalidated_both_boundaries_no_tick_evidence');
});

test('price ticks are ignored once a first boundary touch is already recorded for the active candidate', async () => {
  const { model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 60065 }, timestamp: VALID_B_BUY.timestamp + 10000 }, null);
  await model.onMarketData({ type: 'price', symbol: 'BTCUSD', data: { price: 59990 }, timestamp: VALID_B_BUY.timestamp + 20000 }, null); // must NOT overwrite
  assert.equal(model.patternCandidate.firstLiveBoundaryTouch, 'upper');
});

test('price ticks for a different symbol are ignored', async () => {
  const { model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  await model.onMarketData({ type: 'price', symbol: 'ETHUSD', data: { price: 60065 }, timestamp: VALID_B_BUY.timestamp + 10000 }, null);
  assert.equal(model.patternCandidate.firstLiveBoundaryTouch, null);
});

// =========================================================================
// Regression tests (32-37)
// =========================================================================

test('32. Existing Candle-2 validation (BodyP-maximum) remains active on B', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  // Touches support, bodyHigh > A's, but BodyP is NOT the maximum (huge lower wick dominates).
  const badBodyP = candleAt(20, 60005, 60015, 55000, 60050); // body=45,bodyP=112.5; lowerP=open-low=60005-55000=5005 >> bodyP
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: badBodyP.timestamp, data: badBodyP }, null);
  assert.equal(model.patternCandidate, null);
  assert.equal(lastDecision(ctx).payload.reason, 'bodyP_not_maximum');
});

test('32b. Existing Candle-2 validation (correct nature) remains active on B', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  // Touches support (low=60000), bodyHigh=60011 > A's 60010, BodyP(15) dominant over upperP(7)/lowerP(11), but BEARISH (wrong nature for a BUY setup).
  const wrongNature = candleAt(20, 60011, 60012, 60000, 60005);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: wrongNature.timestamp, data: wrongNature }, null);
  assert.equal(model.patternCandidate, null);
  assert.equal(lastDecision(ctx).payload.reason, 'candle2_not_bullish');
});

test('33. Existing lot-size mapping remains unchanged (riskLength 80 -> lot 10)', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  const c3 = candleAt(21, 60050, 60070, 60045, 60060); // entry=60065, SL=59985, riskLength=80
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  assert.equal(ctx.commands.length, 1);
  // PHASE 1 FIX: lot 10 -> 0.01 BTC (1 lot = 0.001 BTC).
  assert.equal(ctx.commands[0].quantity, 0.01);
});

test('34. Existing risk-length > 360 restriction remains unchanged under the new engine', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA()); // A bodyHigh 60010
  // B: touches support (low=59995<=60000), bodyHigh=60350>A's 60010, BodyP(862.5) dominant over upperP(10)/lowerP(10), bullish. Wide range (365 pts) so a triggering C can push riskLength past 360.
  const b = candleAt(20, 60005, 60360, 59995, 60350);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
  assert.ok(model.patternCandidate, 'setup must validate first');
  assert.deepEqual(model.patternCandidate.boundaries, { upper: 60365, lower: 59990 });
  // C triggers BUY (high>=60365) without invalidating (low=59991, just above the lower boundary 59990).
  // entry=60365, SL=min(59995,59991)-10=59981, riskLength=384 > 360.
  const c3 = candleAt(21, 60300, 60370, 59991, 60350);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  assert.equal(ctx.commands.length, 0, 'must WAIT — riskLength exceeds 360');
  assert.equal(lastDecision(ctx).payload.reason, 'risk_length_exceeds_maximum');
});

test('35. Existing timeframe-switch logic remains unchanged — fires on opposite-market touches, never on same-side (NEW engine) touches', async () => {
  // Opposite-market touch (BULLISH + Resistance) — routed to the OLD engine, switch must still fire exactly as before.
  const { ctx: ctxOpp, model: modelOpp } = await startedModel({ trend: 'BULLISH', support: [1, 2, 3], resistance: [61000, 998000, 997000], timeframe: '3m' });
  await modelOpp.onHydrate(flat(20, 60900, BASE));
  const oppTouch = candleAt(20, 60950, 61010, 60940, 60960); // touches resistance 61000
  await modelOpp.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '3m', timestamp: oppTouch.timestamp, data: oppTouch }, null);
  assert.equal(modelOpp.patternCandidate.engine, 'OLD');
  assert.ok(ctxOpp.events.some((e) => e.eventType === 'ACTIVE_TIMEFRAME_SWITCHED'));

  // Same-side touch (BULLISH + Support, NEW engine) is NOT an opposite-market signal — must NOT switch.
  const { ctx: ctxSame, model: modelSame } = await buyFixture();
  await modelSame.onHydrate(buyA());
  await modelSame.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  assert.equal(modelSame.patternCandidate.engine, 'NEW');
  assert.ok(!ctxSame.events.some((e) => e.eventType === 'ACTIVE_TIMEFRAME_SWITCHED'));
});

test('36. Existing execution pipeline unchanged — TradeCommand still flows through submitTradeCommand exactly once per confirmed trade', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  const c3 = candleAt(21, 60050, 60070, 60045, 60060);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].symbol, 'BTCUSD');
  assert.equal(ctx.commands[0].environment, 'PAPER');
});

test('37. Maximum capital x leverage cap remains removed under the new engine too', async () => {
  const { ctx, model } = await buyFixture({}, { capitalAllocation: 1, leverage: 1 }); // old cap would have been 1
  await model.onHydrate(buyA());
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: VALID_B_BUY.timestamp, data: VALID_B_BUY }, null);
  const c3 = candleAt(21, 60050, 60070, 60045, 60060);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);
  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].quantity, 0.01, 'quantity must be the plain risk-based lot converted to BTC (10 lots = 0.01 BTC), not capped by capitalAllocation*leverage');
});

// =========================================================================
// Opposite-side combinations remain entirely on the OLD engine, unaffected.
// =========================================================================

test('BULLISH + RESISTANCE (opposite-side) still uses the OLD engine untouched', async () => {
  const { model } = await startedModel({ trend: 'BULLISH', support: [1, 2, 3], resistance: [999000, 998000, 997000] });
  await model.onHydrate(flat(19, 61000, BASE));
  const touch = candleAt(19, 998990, 999005, 998980, 998995);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: touch.timestamp, data: touch }, null);
  assert.equal(model.patternCandidate.engine, 'OLD');
  assert.equal(model.patternCandidate.stage, 'WAITING_FOR_CANDLE2');
});

// =========================================================================
// Hydration replay of the NEW engine
// =========================================================================

test('HYDRATION: an unfinished NEW-engine pattern (B validated, awaiting C) is recovered after restart', async () => {
  const { model } = await buyFixture();
  const history = buyA().concat([VALID_B_BUY]);
  await model.onHydrate(history);
  assert.ok(model.patternCandidate);
  assert.equal(model.patternCandidate.engine, 'NEW');
  assert.equal(model.patternCandidate.stage, 'AWAITING_CANDLE3');
  assert.deepEqual(model.patternCandidate.boundaries, { upper: 60065, lower: 59990 });
});

test('HYDRATION: a NEW-engine pattern that already resolved historically (B then C, both in hydrated history) is NOT recreated — replay resumes fresh', async () => {
  const c3 = candleAt(21, 60050, 60070, 60045, 60060); // historically triggered BUY
  const history = buyA().concat([VALID_B_BUY, c3]);
  const { ctx, model } = await buyFixture();
  await model.onHydrate(history);
  assert.equal(model.patternCandidate, null, 'the completed pattern must not remain active or be reused');
  assert.equal(ctx.commands.length, 0, 'hydration itself never trades');
});

test('HYDRATION: never emits a DECISION event or trade, even when a NEW-engine pattern is recovered mid-flight', async () => {
  const { ctx, model } = await buyFixture();
  await model.onHydrate(buyA().concat([VALID_B_BUY]));
  assert.equal(ctx.commands.length, 0);
  assert.ok(!ctx.events.some((e) => e.eventType === 'DECISION'));
});
