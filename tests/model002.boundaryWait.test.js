'use strict';

/**
 * MODEL_002 — "NO TRIGGER" IS NOT "INVALID"
 * =========================================
 *
 * Corrected boundary flow for the A/B/C engine: after Candle 2 fixes the
 * boundaries (C2.high + 5 / C2.low - 5), EVERY following candle is checked
 * against those same, never-recomputed boundaries.
 *
 *   correct boundary touched/crossed -> trade immediately
 *   wrong   boundary touched/crossed -> invalidate immediately
 *   neither boundary touched         -> WAIT, pattern stays active
 *
 * Driven through the REAL Model002 and the REAL reversalPatternEngine —
 * no stubbed strategy anywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Model002 = require('../bot-models/model-002/Model002');
const re = require('../bot-models/model-002/reversalPatternEngine');

const MIN = 60000;
const BASE = 1_700_000_000_000;

const candleAt = (idx, o, h, l, c) => ({ timestamp: BASE + idx * MIN, open: o, high: h, low: l, close: c, volume: null });

function flat(count, price) {
  const arr = [];
  for (let i = 0; i < count; i += 1) arr.push(candleAt(i, price, price + 0.01, price - 0.01, price));
  return arr;
}

function makeCtx() {
  const ctx = { events: [], commands: [] };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => { ctx.commands.push(cmd); return { approved: true, reason: 'Approved' }; };
  return ctx;
}

async function startedModel(parameters) {
  const ctx = makeCtx();
  const model = new Model002(ctx);
  await model.onStart({
    instanceId: 'inst1', symbol: 'BTCUSD', environment: 'PAPER',
    parameters: Object.assign({
      timeframe: '1m', trend: 'BULLISH',
      support: [60000, 55000, 50000], resistance: [999000, 998000, 997000],
    }, parameters),
    capitalAllocation: 10000, leverage: 10, riskSettings: {},
  });
  return { ctx, model };
}

const feed = (model, candle) =>
  model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: candle.timestamp, data: candle }, null);

const lastDecision = (ctx) => ctx.events.filter((e) => e.eventType === 'DECISION').pop().payload;

// --- BUY setup: support 60000, A flat at 60010 ----------------------------
// B: touches support, bodyHigh 60050 > A bodyHigh 60010, BodyP dominant, bullish.
// Boundaries: upper = 60065, lower = 59990.

const buyA = () => flat(20, 60010);
const VALID_B_BUY = candleAt(20, 60005, 60060, 59995, 60050);

async function buySetup() {
  const { ctx, model } = await startedModel({});
  await model.onHydrate(buyA());
  await feed(model, VALID_B_BUY);
  assert.equal(model.patternCandidate.engine, 'NEW');
  assert.deepEqual(model.patternCandidate.boundaries, { upper: 60065, lower: 59990 });
  return { ctx, model };
}

// --- SELL setup (mirror): resistance 60000, A flat at 59990 ---------------

const SELL_SUPPORT = [1000, 900, 800];
const SELL_RESISTANCE = [60000, 65000, 70000];
const sellA = () => flat(20, 59990);
const VALID_B_SELL = candleAt(20, 59995, 60005, 59940, 59950);

async function sellSetup() {
  const { ctx, model } = await startedModel({ trend: 'BEARISH', support: SELL_SUPPORT, resistance: SELL_RESISTANCE });
  await model.onHydrate(sellA());
  await feed(model, VALID_B_SELL);
  assert.equal(model.patternCandidate.engine, 'NEW');
  assert.deepEqual(model.patternCandidate.boundaries, { upper: 60010, lower: 59935 });
  return { ctx, model };
}

// =========================================================================
// The pure engine
// =========================================================================

test('engine: a candle strictly inside the boundaries resolves to WAIT for both directions', () => {
  const b = { upper: 105, lower: 85 };
  assert.equal(re.evaluateCandle3({ high: 102, low: 92 }, b, 'BUY', null).outcome, 'WAIT');
  assert.equal(re.evaluateCandle3({ high: 102, low: 88 }, b, 'SELL', null).outcome, 'WAIT');
  // The worked examples from the correction, verbatim.
  assert.equal(re.evaluateCandle3({ high: 103, low: 91 }, b, 'BUY', null).outcome, 'WAIT');
  assert.equal(re.evaluateCandle3({ high: 105.2, low: 91 }, b, 'BUY', null).outcome, 'BUY');
  assert.equal(re.evaluateCandle3({ high: 101, low: 84.8 }, b, 'BUY', null).outcome, 'INVALID');
  assert.equal(re.evaluateCandle3({ high: 101, low: 84.9 }, b, 'SELL', null).outcome, 'SELL');
  assert.equal(re.evaluateCandle3({ high: 105.1, low: 90 }, b, 'SELL', null).outcome, 'INVALID');
});

// =========================================================================
// 1-6. BUY
// =========================================================================

test('1. BUY: C3 touches Upper -> BUY', async () => {
  const { ctx, model } = await buySetup();
  await feed(model, candleAt(21, 60050, 60065, 60040, 60060)); // high == upper (touch, no close needed)
  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].action, 'LONG');
  assert.equal(lastDecision(ctx).decision, 'BUY');
});

test('2. BUY: C3 touches Lower -> INVALID (wrong boundary)', async () => {
  const { ctx, model } = await buySetup();
  await feed(model, candleAt(21, 60000, 60005, 59990, 60000));
  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate, null);
  assert.equal(lastDecision(ctx).reason, 'invalidated_wrong_boundary_touched');
});

test('3/4/5/6/13/14. BUY: C3 and C4 touch neither boundary -> WAIT; C5 touches Upper -> BUY on the SAME C2 boundaries', async () => {
  const { ctx, model } = await buySetup();
  const boundariesAtC2 = Object.assign({}, model.patternCandidate.boundaries);
  const candle2Ts = model.patternCandidate.candle2.timestamp;
  const candle1Ts = model.patternCandidate.candle1.timestamp;

  const c3 = candleAt(21, 60020, 60030, 60010, 60025); // inside
  await feed(model, c3);
  assert.equal(lastDecision(ctx).reason, 'awaiting_boundary_touch');
  assert.equal(lastDecision(ctx).decision, 'WAIT');
  assert.equal(lastDecision(ctx).evaluationIndex, 3);
  assert.ok(model.patternCandidate, '3. the pattern is still active after C3');
  assert.equal(ctx.commands.length, 0);

  const c4 = candleAt(22, 60025, 60040, 60015, 60030); // inside
  await feed(model, c4);
  assert.equal(lastDecision(ctx).reason, 'awaiting_boundary_touch');
  assert.equal(lastDecision(ctx).evaluationIndex, 4);
  assert.ok(model.patternCandidate, '4. still active after C4');

  // 6/13/14: no new Candle 1 / Candle 2, and the boundaries never moved.
  assert.deepEqual(model.patternCandidate.boundaries, boundariesAtC2);
  assert.equal(model.patternCandidate.candle1.timestamp, candle1Ts);
  assert.equal(model.patternCandidate.candle2.timestamp, candle2Ts);
  assert.equal(model.patternCandidate.stage, 'AWAITING_CANDLE3');

  const c5 = candleAt(23, 60050, 60070, 60040, 60055); // high 60070 >= upper 60065
  await feed(model, c5);
  assert.equal(ctx.commands.length, 1, '5. C5 triggers the BUY');
  assert.equal(ctx.commands[0].action, 'LONG');
  assert.equal(lastDecision(ctx).upperBoundary, boundariesAtC2.upper, '6. triggered against Candle 2\'s own boundaries');
});

test('BUY: the stop loss still spans Candle 2 through the trigger candle, waiting candles included', async () => {
  const { ctx, model } = await buySetup(); // B.low = 59995
  await feed(model, candleAt(21, 60020, 60030, 59993, 60025)); // WAIT, but the lowest low so far
  await feed(model, candleAt(22, 60025, 60040, 60020, 60030)); // WAIT
  await feed(model, candleAt(23, 60050, 60070, 60040, 60055)); // BUY
  assert.equal(ctx.commands.length, 1);
  // Unchanged rule: lowest wick low from Candle 2 through the trigger, -10.
  assert.equal(ctx.commands[0].stopLoss, 59993 - 10);
});

test('BUY: with no waiting candles the stop loss is byte-identical to the previous behaviour', async () => {
  const { ctx, model } = await buySetup(); // B.low = 59995
  await feed(model, candleAt(21, 60050, 60070, 59993, 60060)); // triggers immediately, own low is lowest
  assert.equal(ctx.commands[0].stopLoss, 59993 - 10);
});

// =========================================================================
// 7-12. SELL (mirror)
// =========================================================================

test('7. SELL: C3 touches Lower -> SELL', async () => {
  const { ctx, model } = await sellSetup();
  await feed(model, candleAt(21, 59950, 59960, 59935, 59945)); // low == lower 59935
  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].action, 'SHORT');
});

test('8. SELL: C3 touches Upper -> INVALID (wrong boundary)', async () => {
  const { ctx, model } = await sellSetup();
  await feed(model, candleAt(21, 59990, 60010, 59980, 60000)); // high == upper 60010
  assert.equal(ctx.commands.length, 0);
  assert.equal(model.patternCandidate, null);
  assert.equal(lastDecision(ctx).reason, 'invalidated_wrong_boundary_touched');
});

test('9/10/11/12. SELL: C3 and C4 WAIT; C5 touches Lower -> SELL on the SAME C2 boundaries', async () => {
  const { ctx, model } = await sellSetup();
  const boundariesAtC2 = Object.assign({}, model.patternCandidate.boundaries);

  await feed(model, candleAt(21, 59960, 59970, 59950, 59965)); // inside
  assert.equal(lastDecision(ctx).reason, 'awaiting_boundary_touch');
  assert.ok(model.patternCandidate);

  await feed(model, candleAt(22, 59965, 59980, 59945, 59955)); // inside
  assert.equal(lastDecision(ctx).reason, 'awaiting_boundary_touch');
  assert.ok(model.patternCandidate);
  assert.deepEqual(model.patternCandidate.boundaries, boundariesAtC2, '12. boundaries unchanged');

  await feed(model, candleAt(23, 59950, 59955, 59930, 59940)); // low 59930 <= lower 59935
  assert.equal(ctx.commands.length, 1, '11. C5 triggers the SELL');
  assert.equal(ctx.commands[0].action, 'SHORT');
  assert.equal(lastDecision(ctx).lowerBoundary, boundariesAtC2.lower);
});

// =========================================================================
// 15-20. Visualization and state must survive the change
// =========================================================================

test('15/18. the active pattern stays visible while waiting, and invalidation removes it', async () => {
  const { ctx, model } = await buySetup();
  await feed(model, candleAt(21, 60020, 60030, 60010, 60025)); // WAIT

  const waiting = lastDecision(ctx).checks;
  assert.ok(waiting.patternVisual, '18. C1/C2/C3 group still present while waiting');
  const roles = waiting.patternVisual.labels.map((l) => l.role);
  assert.deepEqual(roles, ['CANDLE_1', 'CANDLE_2', 'CANDLE_3']);
  assert.equal(waiting.patternVisual.labels[2].timestamp, BASE + 21 * MIN, 'C3 follows the candle being evaluated');
  assert.ok(waiting.bodyReference, 'body-reference line still drawn while waiting');

  const firstPatternId = waiting.patternVisual.patternId;
  await feed(model, candleAt(22, 60025, 60040, 60015, 60030)); // WAIT again
  const stillWaiting = lastDecision(ctx).checks;
  assert.equal(stillWaiting.patternVisual.patternId, firstPatternId, 'no second C1/C2 group is created');
  assert.equal(stillWaiting.patternVisual.labels[2].timestamp, BASE + 22 * MIN, 'C3 advances to the new evaluation candle');

  await feed(model, candleAt(23, 60000, 60005, 59985, 60000)); // wrong boundary -> INVALID
  const invalid = lastDecision(ctx).checks;
  assert.equal(invalid.patternVisual, null, '15. all labels removed');
  assert.equal(invalid.bodyReference, null, '15. body-reference line removed');
});

test('16. a successful trade finalizes the pattern', async () => {
  const { ctx, model } = await buySetup();
  await feed(model, candleAt(21, 60020, 60030, 60010, 60025)); // WAIT
  await feed(model, candleAt(22, 60050, 60070, 60040, 60055)); // BUY
  assert.equal(model.patternCandidate, null);
  assert.equal(lastDecision(ctx).checks.patternVisual.status, 'TRIGGERED');
  assert.equal(lastDecision(ctx).checks.patternVisual.labels[2].trigger, 'BUY');
});

test('17. Support stays TOUCHED across the whole waiting sequence', async () => {
  const { ctx, model } = await buySetup();
  assert.equal(lastDecision(ctx).checks.support.status, 'TOUCHED');
  await feed(model, candleAt(21, 60020, 60030, 60010, 60025)); // WAIT
  assert.equal(lastDecision(ctx).checks.support.status, 'TOUCHED');
  await feed(model, candleAt(22, 60000, 60005, 59985, 60000)); // INVALID
  assert.equal(lastDecision(ctx).checks.support.status, 'TOUCHED');
});

test('no fresh Support detection runs while the boundary pattern is waiting', async () => {
  const { ctx, model } = await buySetup();
  const candle2Ts = model.patternCandidate.candle2.timestamp;
  // This candle stays inside the boundaries but its low (60000) also sits
  // exactly on Support — it must be treated purely as an evaluation candle.
  await feed(model, candleAt(21, 60020, 60030, 60000, 60025));
  assert.equal(lastDecision(ctx).reason, 'awaiting_boundary_touch');
  assert.equal(model.patternCandidate.candle2.timestamp, candle2Ts, 'no new Candle 2 was created');
});

test('19. boundary labels remain direction-aware while waiting', async () => {
  const levelState = require('../public/js/renderers/model002-level-state.js');
  const { ctx, model } = await buySetup();
  await feed(model, candleAt(21, 60020, 60030, 60010, 60025)); // WAIT
  const dir = lastDecision(ctx).checks.patternVisual.direction;
  assert.equal(dir, 'BUY');
  assert.deepEqual(levelState.getBoundaryLabels(dir), { upper: 'UPPER (BUY>)', lower: 'LOWER (INVALID<)' });
});

test('20. two bots waiting at once keep entirely separate pattern state', async () => {
  const a = await buySetup();
  const b = await startedModel({});
  await b.model.onHydrate(buyA());

  await feed(a.model, candleAt(21, 60020, 60030, 60010, 60025)); // A waits
  await feed(b.model, candleAt(21, 60020, 60030, 60010, 60025)); // B never had a pattern

  assert.ok(a.model.patternCandidate);
  assert.equal(b.model.patternCandidate, null);
  assert.notEqual(a.model.patternCandidate, b.model.patternCandidate);
});

// =========================================================================
// Hydration replay must follow the same corrected flow
// =========================================================================

test('restart: replaying a waiting sequence lands back in the SAME active pattern, not IDLE', async () => {
  const { model } = await startedModel({});
  await model.onHydrate(
    buyA().concat([
      VALID_B_BUY,
      candleAt(21, 60020, 60030, 60010, 60025), // inside -> WAIT
      candleAt(22, 60025, 60040, 60015, 60030), // inside -> WAIT
    ])
  );
  assert.ok(model.patternCandidate, 'the pattern survived the restart');
  assert.equal(model.patternCandidate.stage, 'AWAITING_CANDLE3');
  assert.deepEqual(model.patternCandidate.boundaries, { upper: 60065, lower: 59990 });
  assert.equal(model.patternCandidate.candle2.timestamp, VALID_B_BUY.timestamp);
});

test('the retired "did not trigger correctly" wording is gone from the model', () => {
  const model = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  assert.doesNotMatch(model, /invalidated_candle3_wrong_or_no_boundary_touch/);
  const map = require('../public/js/renderers/model002-reason-map.js');
  assert.equal(map.formatModel002Reason('invalidated_wrong_boundary_touched'), 'Pattern invalidated — wrong boundary touched');
  assert.match(map.formatModel002Reason('awaiting_boundary_touch'), /did not touch either boundary/);
  // The retired code still renders as text for historical Decision History rows.
  assert.doesNotMatch(map.formatModel002Reason('invalidated_candle3_wrong_or_no_boundary_touch'), /did not trigger correctly/);
});
