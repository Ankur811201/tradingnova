'use strict';

/**
 * MODEL_002 — maximum-capital x leverage cap REMOVAL tests.
 *
 * Confirmed requirement: MODEL_002's calculated quantity (the risk-based
 * lot from computeLotFromRiskLength — see sameSidePatternEngine.js) must
 * reach the submitted TradeCommand UNCHANGED. It must never be reduced,
 * and the trade must never be rejected, because
 * `positionValue > capitalAllocation * leverage`.
 *
 * These tests drive Model002 through a REAL BUY confirmation (same
 * boundary-break scenario already covered by
 * tests/model002.sameSidePattern.test.js "FULL RESTART RECOVERY 9b") but
 * with a deliberately tiny capitalAllocation/leverage, so that the OLD
 * removed cap (capitalAllocation * leverage) would have been far smaller
 * than the real position value — proving nothing in the active path still
 * reduces or rejects on that basis.
 *
 * The separate riskLength > 360 WAIT rule is NOT the capital x leverage
 * cap and must still work exactly as before (test 3 below).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Model002 = require('../bot-models/model-002/Model002');
const sp = require('../bot-models/model-002/sameSidePatternEngine');
const PositionManager = require('../services/PositionManager');

const MIN = 60000;
const BASE = 1_700_000_000_000;

function candleAt(idx, o, h, l, cl, startTs) {
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

function flat(count, price, startTs) {
  const arr = [];
  for (let i = 0; i < count; i += 1) arr.push(candleAt(i, price, price + 0.01, price - 0.01, price, startTs));
  return arr;
}

/**
 * BULLISH+SUPPORT NEW-engine A/B/C fixture — A close to the support level
 * (so a real trade keeps riskLength <= 360), B validates instantly against
 * A, C triggers BUY.
 */
function buyABC() {
  const a = candleAt(19, 60010, 60010.01, 60009.99, 60010, BASE); // A: bodyHigh 60010
  const b = candleAt(20, 60005, 60060, 59995, 60050, BASE); // B: touches support(60000), bodyHigh 60050>60010, BodyP dominant, bullish. Boundaries: upper 60065, lower 59990.
  return { a, b };
}

// =========================================================================
// TEST 1 / 6 — MODEL_002: quantity NOT reduced when positionValue would
// have vastly exceeded the old capitalAllocation * leverage cap.
// =========================================================================

test('CAP REMOVAL: BUY quantity equals the risk-based lot as-is, even when positionValue >> old capitalAllocation*leverage', async () => {
  // capitalAllocation=100, leverage=1 -> old cap would have been 100.
  const { ctx, model } = await startedModel(
    { trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [999000, 998000, 997000] },
    { capitalAllocation: 100, leverage: 1 },
  );
  const { a, b } = buyABC();
  await model.onHydrate(flat(19, 60010, BASE).concat([a]));
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
  assert.equal(model.patternCandidate.stage, 'AWAITING_CANDLE3');

  const c3 = candleAt(21, 60050, 60070, 60045, 60060, BASE); // triggers BUY (high>=60065)
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);

  assert.equal(ctx.commands.length, 1, 'exactly one TradeCommand — not rejected by the old cap');
  const cmd = ctx.commands[0];
  assert.equal(cmd.action, 'LONG');
  assert.equal(cmd.quantity, 10, 'quantity must equal the plain risk-based lot');
  assert.notEqual(cmd.quantity, 100 / 60065, 'quantity must NOT be capped to (old capital*leverage)/entryPrice');

  const positionValue = cmd.quantity * 60065;
  assert.ok(positionValue > 100 * 1, 'sanity: positionValue genuinely exceeds the old capital*leverage cap');
});

test('CAP REMOVAL: SELL mirror — quantity NOT reduced when positionValue >> old capitalAllocation*leverage', async () => {
  const { ctx, model } = await startedModel(
    { trend: 'BEARISH', support: [1000, 900, 800], resistance: [65000, 70000, 75000] },
    { capitalAllocation: 50, leverage: 2 }, // old cap would have been 100
  );
  const a = candleAt(19, 64990, 64990.01, 64989.99, 64990, BASE); // A: bodyLow 64990
  const b = candleAt(20, 64995, 65010, 64945, 64950, BASE); // B: touches resistance(65000), bodyLow 64950<64990, bearish. Boundaries: upper 65015, lower 64940.
  await model.onHydrate(flat(19, 64990, BASE).concat([a]));
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
  assert.equal(model.patternCandidate.stage, 'AWAITING_CANDLE3');

  const c3 = candleAt(21, 64950, 64955, 64935, 64945, BASE); // triggers SELL (low<=64940)
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);

  assert.equal(ctx.commands.length, 1);
  const cmd = ctx.commands[0];
  assert.equal(cmd.action, 'SHORT');
  assert.equal(cmd.quantity, 10);
  assert.ok(cmd.quantity * 64940 > 50 * 2, 'sanity: positionValue exceeds old cap');
});

// =========================================================================
// TEST 3 / 5 — riskLength > 360 WAIT rule is UNTOUCHED (not the cap that was removed).
// =========================================================================

test('CAP REMOVAL DID NOT TOUCH: riskLength > 360 still produces WAIT / no TradeCommand', async () => {
  const { ctx, model } = await startedModel(
    { trend: 'BULLISH', support: [60000, 59000, 58000], resistance: [999000, 998000, 997000] },
    { capitalAllocation: 100000, leverage: 50 }, // huge capital*leverage — proves rejection is NOT capital-based
  );
  const a = candleAt(19, 60010, 60010.01, 60009.99, 60010, BASE);
  // B: wide range so a triggering C can push riskLength past 360 — see tests/model002.reversalPattern.test.js item 34 for the full derivation.
  const b = candleAt(20, 60005, 60360, 59995, 60350, BASE); // boundaries: upper 60365, lower 59990
  await model.onHydrate(flat(19, 60010, BASE).concat([a]));
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: b.timestamp, data: b }, null);
  assert.equal(model.patternCandidate.stage, 'AWAITING_CANDLE3');

  // Triggers BUY (high>=60365) without invalidating (low=59991, just above lower boundary 59990). riskLength = 384 > 360.
  const c3 = candleAt(21, 60300, 60370, 59991, 60350, BASE);
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '1m', timestamp: c3.timestamp, data: c3 }, null);

  assert.equal(ctx.commands.length, 0, 'no TradeCommand — riskLength > 360 still blocks the trade');
  const decision = ctx.events.filter((e) => e.eventType === 'DECISION').pop();
  assert.equal(decision.payload.decision, 'WAIT');
  assert.equal(decision.payload.reason, 'risk_length_exceeds_maximum');
});

// =========================================================================
// Source-level confirmation: the old reason string/keys cannot be produced
// by the active MODEL_002 path, and the UI reason map no longer carries
// the now-unreachable entry.
// =========================================================================

test('active Model002.js source no longer emits the old maximum_capital_leverage_limit reason', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  assert.equal(/maximum_capital_leverage_limit/.test(src), false);
  assert.equal(/exceeds maximum capital x leverage limit/i.test(src), false);
});

test('the obsolete maximum_capital_leverage_limit entry is gone from the UI reason map (unmapped codes still fall back to raw code)', () => {
  const { formatModel002Reason, REASON_TEXT } = require('../public/js/renderers/model002-reason-map.js');
  assert.equal(Object.prototype.hasOwnProperty.call(REASON_TEXT, 'maximum_capital_leverage_limit'), false);
  assert.equal(formatModel002Reason('maximum_capital_leverage_limit'), 'maximum_capital_leverage_limit');
});

// =========================================================================
// PositionManager.calculatePositionSize — confirmed DEAD CODE, not part of
// the active MODEL_002 -> TradeCommand -> RiskEngine -> Execution path.
// Left in place per instruction not to touch unrelated dead code; this
// test just documents/locks in that it is never called from the active
// path, and that (if ever called directly) it still contains the old cap
// logic, so nobody should wire it back in unmodified.
// =========================================================================

test('DOCUMENTED DEAD CODE: PositionManager.calculatePositionSize is never invoked anywhere in the active codebase', () => {
  const projectRoot = path.join(__dirname, '..');
  const searchDirs = ['controllers', 'services', 'sockets', 'bot-models', 'routes', 'utils'];
  let callSites = 0;
  for (const dir of searchDirs) {
    const full = path.join(projectRoot, dir);
    if (!fs.existsSync(full)) continue;
    const stack = [full];
    while (stack.length) {
      const cur = stack.pop();
      for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
        const p = path.join(cur, entry.name);
        if (entry.isDirectory()) { stack.push(p); continue; }
        if (!entry.name.endsWith('.js')) continue;
        if (p === path.join(projectRoot, 'services', 'PositionManager.js')) continue; // its own definition
        const content = fs.readFileSync(p, 'utf8');
        if (/calculatePositionSize\s*\(/.test(content)) callSites += 1;
      }
    }
  }
  assert.equal(callSites, 0, 'calculatePositionSize must remain uncalled from the active path — it still contains the old cap and is NOT wired into TradeCommand execution');
  assert.equal(typeof PositionManager.calculatePositionSize, 'function', 'sanity: the function itself still exists (untouched dead code, per instruction not to edit unrelated dead code)');
});
