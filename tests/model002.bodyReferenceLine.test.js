'use strict';

/**
 * PREVIOUS CANDLE BODY REFERENCE LINE (visual only) + regression guards.
 *
 * Feature 1: a horizontal helper line at candle A's BODY high (BULLISH +
 * Support) or BODY low (BEARISH + Resistance) — the exact value the
 * EXISTING A/B validation compares against — so the user can see whether
 * B's body crossed it.
 *
 * These tests drive the REAL Model002 and the REAL frontend files (loaded
 * into a VM sandbox, same approach as tests/part8.clientDecisionEngine.test.js
 * and tests/nextCandleCountdown.test.js). Nothing about detection,
 * validation, SL, sizing or execution is mocked or reimplemented.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Model002 = require('../bot-models/model-002/Model002');
const reversalEngine = require('../bot-models/model-002/reversalPatternEngine');

const MIN = 60000;
const BASE = 1_700_000_000_000;
const SUPPORT = [60000, 59000, 58000];
const RESISTANCE = [65000, 66000, 67000];

function makeCtx() {
  const ctx = { events: [], commands: [] };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => { ctx.commands.push(cmd); return { approved: true, reason: 'Approved', metadata: {} }; };
  return ctx;
}

const neutral = (i) => ({ timestamp: BASE + i * MIN, open: 62500, high: 62510, low: 62490, close: 62505, volume: null });

// BULLISH + SUPPORT: A body high = max(60040, 60030) = 60040; A wick high = 60050.
const candleA = (i) => ({ timestamp: BASE + i * MIN, open: 60040, high: 60050, low: 60020, close: 60030, volume: null });
const candleBValid = (i) => ({ timestamp: BASE + i * MIN, open: 60010, high: 60070, low: 59995, close: 60060, volume: null });
const candleCBuy = (i) => ({ timestamp: BASE + i * MIN, open: 60060, high: 60080, low: 60055, close: 60070, volume: null });
const candleCInvalid = (i) => ({ timestamp: BASE + i * MIN, open: 60060, high: 60065, low: 59980, close: 60000, volume: null });

// A second, different valid A/B pair (higher prices) to prove line replacement.
const candleA2 = (i) => ({ timestamp: BASE + i * MIN, open: 60140, high: 60150, low: 60120, close: 60130, volume: null });
const candleB2 = (i) => ({ timestamp: BASE + i * MIN, open: 60110, high: 60170, low: 59995, close: 60160, volume: null });

// BEARISH + RESISTANCE: A body low = min(64960, 64970) = 64960; A wick low = 64950.
const candleABear = (i) => ({ timestamp: BASE + i * MIN, open: 64960, high: 64980, low: 64950, close: 64970, volume: null });
const candleBBear = (i) => ({ timestamp: BASE + i * MIN, open: 64990, high: 65005, low: 64930, close: 64940, volume: null });

async function feed(model, candle) {
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '3m', timestamp: candle.timestamp, data: candle }, null);
}

async function startBot({ trend = 'BULLISH' } = {}) {
  const ctx = makeCtx();
  const model = new Model002(ctx);
  await model.onStart({
    instanceId: 'inst_' + Math.random().toString(36).slice(2, 8),
    symbol: 'BTCUSD', environment: 'PAPER',
    parameters: { timeframe: '3m', trend, support: SUPPORT, resistance: RESISTANCE, historySize: 20 },
    capitalAllocation: 10000, leverage: 10, riskSettings: {},
  });
  for (let i = 0; i < 4; i += 1) await feed(model, neutral(i));
  return { ctx, model };
}

const decisions = (ctx) => ctx.events.filter((e) => e.eventType === 'DECISION');
const lastDecision = (ctx) => decisions(ctx)[decisions(ctx).length - 1].payload;

// =========================================================================
// 11-15. The formulas
// =========================================================================

test('11. bullish reference is candle A body HIGH = max(A.open, A.close)', async () => {
  const { ctx, model } = await startBot();
  const a = candleA(10);
  await feed(model, a);
  await feed(model, candleBValid(11));

  const ref = lastDecision(ctx).checks.bodyReference;
  assert.equal(ref.side, 'BODY_HIGH');
  assert.equal(ref.price, Math.max(a.open, a.close));
  assert.equal(ref.price, 60040);
  assert.equal(ref.direction, 'BUY');
});

test('12. bearish reference is candle A body LOW = min(A.open, A.close)', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  const a = candleABear(10);
  await feed(model, a);
  await feed(model, candleBBear(11));

  const ref = lastDecision(ctx).checks.bodyReference;
  assert.equal(ref.side, 'BODY_LOW');
  assert.equal(ref.price, Math.min(a.open, a.close));
  assert.equal(ref.price, 64960);
  assert.equal(ref.direction, 'SELL');
});

test('13. the bullish reference is NOT candle A wick high', async () => {
  const { ctx, model } = await startBot();
  const a = candleA(10);
  await feed(model, a);
  await feed(model, candleBValid(11));

  const ref = lastDecision(ctx).checks.bodyReference;
  assert.notEqual(ref.price, a.high);
  assert.equal(ref.price, reversalEngine.bodyHigh(a), 'same value the real A/B validation uses');
  assert.equal(reversalEngine.validateAB(a, candleBValid(11), 'BUY').aBodyHigh, ref.price);
});

test('14. the bearish reference is NOT candle A wick low', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  const a = candleABear(10);
  await feed(model, a);
  await feed(model, candleBBear(11));

  const ref = lastDecision(ctx).checks.bodyReference;
  assert.notEqual(ref.price, a.low);
  assert.equal(ref.price, reversalEngine.bodyLow(a));
  assert.equal(reversalEngine.validateAB(a, candleBBear(11), 'SELL').aBodyLow, ref.price);
});

test('15. the reference carries candle A\'s own timestamp (and B\'s as the span end)', async () => {
  const { ctx, model } = await startBot();
  const a = candleA(10);
  const b = candleBValid(11);
  await feed(model, a);
  await feed(model, b);

  const ref = lastDecision(ctx).checks.bodyReference;
  assert.equal(ref.candleTimestamp, a.timestamp);
  assert.equal(ref.fromTimestamp, a.timestamp);
  assert.equal(ref.toTimestamp, b.timestamp);
  assert.notEqual(ref.candleTimestamp, b.timestamp);
});

// =========================================================================
// 16-19. Lifecycle
// =========================================================================

test('16. the reference is present exactly while a valid A/B pattern is active', async () => {
  const { ctx, model } = await startBot();
  await feed(model, neutral(9));
  assert.equal(lastDecision(ctx).checks.bodyReference, null, 'no pattern -> no line');

  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  assert.notEqual(lastDecision(ctx).checks.bodyReference, null);
  assert.equal(lastDecision(ctx).checks.patternState, 'AWAITING_CANDLE3');
});

test('17. the reference disappears when the pattern is invalidated', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  await feed(model, candleCInvalid(12));

  assert.equal(lastDecision(ctx).checks.bodyReference, null);
  assert.match(lastDecision(ctx).reason, /invalidated/);
});

test('17b. a rejected A/B touch never produces a reference line', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  // Touches Support but fails A/B (body high 60035 <= 60040).
  await feed(model, { timestamp: BASE + 11 * MIN, open: 60005, high: 60045, low: 59990, close: 60035, volume: null });

  assert.equal(lastDecision(ctx).reason, 'ab_body_high_not_greater');
  assert.equal(lastDecision(ctx).checks.bodyReference, null);
});

test('18. a new A/B pattern reports the new A body high, replacing the old value', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  const first = lastDecision(ctx).checks.bodyReference.price;

  await feed(model, candleCInvalid(12));
  await feed(model, candleA2(13));
  await feed(model, candleB2(14));
  const second = lastDecision(ctx).checks.bodyReference.price;

  assert.equal(first, 60040);
  assert.equal(second, 60140);
  assert.notEqual(first, second);
});

test('19. no duplicate helper lines: the overlay uses one fixed price-line key', () => {
  const overlaySrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'overlay-manager.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(overlaySrc, sandbox, { filename: 'overlay-manager.js' });

  const created = [];
  const removed = [];
  const series = {
    createPriceLine(opts) { const line = { opts }; created.push(opts); return line; },
    removePriceLine(line) { removed.push(line.opts.title); },
  };
  const chart = { addLineSeries: () => ({ setData() {}, update() {} }) };
  const om = new sandbox.window.OverlayManager(chart, series);

  om.setPriceLine('patternBodyReference', 60040, '#a78bfa', 'A BODY HIGH', 1);
  om.setPriceLine('patternBodyReference', 60140, '#a78bfa', 'A BODY HIGH', 1);
  assert.equal(Object.keys(om.priceLines).filter((k) => k === 'patternBodyReference').length, 1);
  assert.equal(created.length, 2);
  assert.equal(removed.length, 1, 'the previous line is removed before the new one is drawn');
  assert.equal(om.priceLines.patternBodyReference.opts.price, 60140);

  om.removePriceLine('patternBodyReference');
  assert.equal(om.priceLines.patternBodyReference, undefined);
});

// =========================================================================
// 20-21. Existing chart elements untouched
// =========================================================================

test('20-21. the helper line reuses the existing chart/overlay/marker infrastructure only', () => {
  const chartSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bot-detail-chart.js'), 'utf8');

  // Existing Support/Resistance configuration lines: unchanged keys.
  assert.match(chartSrc, /'cfgSupport' \+ idx/);
  assert.match(chartSrc, /'cfgResistance' \+ idx/);
  // Existing Candle 1/2/3 markers: unchanged.
  assert.match(chartSrc, /'model002-pattern:' \+ visual\.patternId \+ ':' \+ label\.role/);
  assert.match(chartSrc, /setPatternMarkers/);
  // New line: one dedicated key on the SAME OverlayManager.
  assert.equal((chartSrc.match(/setPriceLine\(\s*'patternBodyReference'/g) || []).length, 1, 'exactly one draw call site');
  assert.equal((chartSrc.match(/removePriceLine\('patternBodyReference'\)/g) || []).length, 1, 'exactly one remove call site');

  // No second chart, socket, poller or candle stream was introduced.
  assert.equal((chartSrc.match(/new window\.ChartManager\(/g) || []).length, 1);
  assert.equal((chartSrc.match(/socket\.on\('bot:candle'/g) || []).length, 1);
  assert.doesNotMatch(chartSrc, /new WebSocket\(/);
  assert.doesNotMatch(chartSrc, /setInterval\(/);
});

// =========================================================================
// Frontend wiring — real files, VM sandbox
// =========================================================================

function makeElement(id) {
  return {
    id, _innerHTML: '', _textContent: '', _className: '', children: [],
    get textContent() { return this._textContent; }, set textContent(v) { this._textContent = v; },
    get className() { return this._className; }, set className(v) { this._className = v; },
    get innerHTML() { return this._innerHTML; }, set innerHTML(v) { this._innerHTML = v; this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    get firstChild() { return this.children[0] || null; },
    querySelector() { return null; },
  };
}

function loadClient({ initialDecision = null, levelTouch = null } = {}) {
  const elements = {};
  const doc = {
    addEventListener(evt, cb) { if (evt === 'DOMContentLoaded') cb(); },
    getElementById(id) { if (!elements[id]) elements[id] = makeElement(id); return elements[id]; },
    createElement() { return makeElement(null); },
  };
  const socket = { _h: {}, on(e, cb) { (this._h[e] = this._h[e] || []).push(cb); }, __fire(e, d) { (this._h[e] || []).forEach((cb) => cb(d)); } };

  const overlayCalls = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 0, clearInterval: () => {},
    document: doc,
    window: {
      BOT_CONFIG: { instanceId: 'inst_1', modelId: 'MODEL_002', pair: 'BTCUSD', levelTouch },
      BOT_INITIAL_DECISION: initialDecision,
      NovaBotSocket: socket,
      NovaChartPatternOverlay: {
        setBoundaries() {}, clearBoundaries() {},
        setBodyReference(ref) { overlayCalls.push(['set', ref.price, ref.side]); },
        clearBodyReference() { overlayCalls.push(['clear']); },
      },
      NovaChartPatternMarkers: { setFromChecks() {}, clear() {} },
    },
  };
  sandbox.window.document = doc;
  // In a browser `self === window`; the sandbox must mirror that so the UMD
  // module attaches where bot-detail-ws.js looks for it.
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);

  ['public/js/renderers/model-thinking-registry.js', 'public/js/renderers/model002-level-state.js', 'public/js/bot-detail-ws.js']
    .forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));

  return { doc, socket, sandbox, overlayCalls };
}

function decisionPayload(checks) {
  return { instanceId: 'inst_1', decision: 'WAIT', reason: 'no_level_touch', checks };
}

test('client: an active pattern draws the line; the next pattern-less decision removes it', () => {
  const { socket, overlayCalls } = loadClient();

  socket.__fire('bot:decision', decisionPayload({
    trend: { status: 'BULLISH' }, support: { status: 'TOUCHED', level: 60000 }, resistance: { status: 'NOT_TOUCHED', level: null },
    patternState: 'AWAITING_CANDLE3', bodyReference: { side: 'BODY_HIGH', price: 60040, direction: 'BUY', candleTimestamp: BASE },
  }));
  socket.__fire('bot:decision', decisionPayload({
    trend: { status: 'BULLISH' }, support: { status: 'TOUCHED', level: 60000 }, resistance: { status: 'NOT_TOUCHED', level: null },
    patternState: 'IDLE', bodyReference: null,
  }));

  assert.deepEqual(overlayCalls, [['set', 60040, 'BODY_HIGH'], ['clear']]);
});

test('client: the Decision Engine keeps showing Support: TOUCHED while the pattern reads IDLE', () => {
  const { doc, socket } = loadClient();
  socket.__fire('bot:decision', decisionPayload({
    trend: { status: 'BULLISH' },
    support: { status: 'TOUCHED', level: 60000 }, resistance: { status: 'NOT_TOUCHED', level: null },
    patternState: 'IDLE', bodyReference: null, activeLevel: null,
  }));

  const html = doc.getElementById('thinking-checks').innerHTML;
  assert.match(html, /Support/);
  assert.match(html, /TOUCHED/);
  assert.doesNotMatch(html, /NOT_TOUCHED \(60000/);
  assert.match(html, /IDLE/);
});

test('client: persisted parameters raise a pre-feature decision to TOUCHED, never the reverse', () => {
  const levelTouch = { supportTouched: true, supportTouchedLevel: 60000, supportTouchedIndex: 1, supportTouchedAt: BASE, resistanceTouched: false };
  const { doc, socket } = loadClient({ levelTouch });

  // An old stored decision whose checks still carry the activeLevel-derived value.
  socket.__fire('bot:decision', decisionPayload({
    trend: { status: 'BULLISH' },
    support: { status: 'NOT_TOUCHED', level: null }, resistance: { status: 'NOT_TOUCHED', level: null },
    patternState: 'IDLE',
  }));

  const html = doc.getElementById('thinking-checks').innerHTML;
  assert.match(html, />TOUCHED \(60000\.00\)</);

  const levelState = require('../public/js/renderers/model002-level-state.js');
  const raised = levelState.applyPersistedFloor(
    { support: { status: 'TOUCHED', level: 59000 }, resistance: { status: 'NOT_TOUCHED', level: null } },
    { supportTouched: false }
  );
  assert.equal(raised.support.status, 'TOUCHED', 'a live TOUCHED is never downgraded by the persisted floor');
  assert.equal(raised.support.level, 59000);
});

test('client: normalizeBodyReference rejects a missing/invalid price instead of inventing a line', () => {
  const levelState = require('../public/js/renderers/model002-level-state.js');
  assert.equal(levelState.normalizeBodyReference(null), null);
  assert.equal(levelState.normalizeBodyReference({}), null);
  assert.equal(levelState.normalizeBodyReference({ bodyReference: { price: 'abc' } }), null);
  assert.equal(levelState.normalizeBodyReference({ bodyReference: { price: 0 } }), null);
  const ok = levelState.normalizeBodyReference({ bodyReference: { price: 60040, side: 'BODY_HIGH', direction: 'BUY', candleTimestamp: BASE } });
  assert.equal(ok.price, 60040);
});

// =========================================================================
// 22-29. Regression — trading behaviour must be byte-for-byte unchanged
// =========================================================================

test('22/23/24/25/26. BUY still triggers with the same entry, SL, riskLength, lot and quantity', async () => {
  const { ctx, model } = await startBot();
  const b = candleBValid(11);
  const c = candleCBuy(12);
  await feed(model, candleA(10));
  await feed(model, b);
  await feed(model, c);

  const buy = decisions(ctx).find((d) => d.payload.decision === 'BUY');
  assert.ok(buy, 'BUY still fires on a wick touch of the upper boundary, no close required');
  const p = buy.payload;
  assert.equal(p.upperBoundary, b.high + 5);
  assert.equal(p.lowerBoundary, b.low - 5);
  assert.equal(p.entryPrice, b.high + 5);                       // 60075
  assert.equal(p.stopLoss, Math.min(b.low, c.low) - 10);        // 59985
  assert.equal(p.riskLength, 90);
  assert.equal(p.lot, 9);
  assert.equal(p.finalQuantity, 9, 'no capital x leverage cap reduces the quantity');

  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].action, 'LONG');
  assert.equal(ctx.commands[0].quantity, 9);
  assert.equal(ctx.commands[0].stopLoss, 59985);
});

test('23. SELL still triggers with the mirrored stop loss', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  const b = candleBBear(11);
  const c = { timestamp: BASE + 12 * MIN, open: 64940, high: 64945, low: 64920, close: 64930, volume: null }; // low <= 64925
  await feed(model, candleABear(10));
  await feed(model, b);
  await feed(model, c);

  const sell = decisions(ctx).find((d) => d.payload.decision === 'SELL');
  assert.ok(sell);
  assert.equal(sell.payload.entryPrice, b.low - 5);
  assert.equal(sell.payload.stopLoss, Math.max(b.high, c.high) + 10);
  assert.equal(ctx.commands[0].action, 'SHORT');
});

test('27. one-time opposite-market timeframe switch still fires on the touch', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  // BEARISH + SUPPORT touch = the opposite-market combination.
  await feed(model, { timestamp: BASE + 10 * MIN, open: 60010, high: 60020, low: 59990, close: 60005, volume: null });

  const switches = ctx.events.filter((e) => e.eventType === 'ACTIVE_TIMEFRAME_SWITCHED');
  assert.equal(switches.length, 1);
  assert.equal(model.activeTimeframe, '1m');
  assert.equal(model.params.timeframe, '3m', 'configured timeframe untouched');
  // The same touch also latches the level.
  assert.equal(model.levelTouch.support.touched, true);
});

test('28. the maximum-capital x leverage cap remains removed', () => {
  const risk = fs.readFileSync(path.join(__dirname, '..', 'services', 'riskEngine', 'RiskEngine.js'), 'utf8');
  assert.doesNotMatch(risk, /Capital allocation exceeded/);
  const model = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  assert.equal((model.match(/const finalQuantity = lot;/g) || []).length, 2);
});

test('29. the execution pipeline and the strategy engines were not re-implemented anywhere new', () => {
  const model = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  // Level touches are recognised only through the existing engines.
  assert.equal((model.match(/reversalEngine\.findTouchedLevel\(/g) || []).length, 1);
  assert.equal((model.match(/findTouchedLevel\(levels, candle\)/g) || []).length, 2, 'unchanged OLD-engine call sites');
  // The new code is read-only with respect to pattern/trade state.
  assert.doesNotMatch(model, /_bodyReferenceFor\(candidate\)[^;]*patternCandidate =/);

  const frontend = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'renderers', 'model002-level-state.js'), 'utf8');
  assert.doesNotMatch(frontend, /\.low\b|\.high\b/, 'the browser never inspects OHLC to decide a touch');
});
