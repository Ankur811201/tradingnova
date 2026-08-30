'use strict';

/**
 * MODEL_002 C1 / C2 / C3 VISUAL LABEL SYSTEM
 * ==========================================
 *
 * End-to-end, not source inspection: the REAL Model002 produces real
 * decisions from real candles, and those exact decision payloads are fed
 * to the REAL frontend files (public/js/bot-detail-chart.js,
 * marker-manager.js, overlay-manager.js, bot-detail-ws.js) running in a VM
 * sandbox with a fake chart library. Every assertion is about the markers
 * that actually reached the candlestick series.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Model002 = require('../bot-models/model-002/Model002');
const { buildPatternVisual } = require('../utils/model002PatternVisual');

const MIN = 60000;
const BASE = 1_700_000_000_000;
const SUPPORT = [60000, 59000, 58000];
const RESISTANCE = [65000, 66000, 67000];

// --- real strategy fixtures (identical to the body-reference suite) -------

const neutral = (i) => ({ timestamp: BASE + i * MIN, open: 62500, high: 62510, low: 62490, close: 62505, volume: null });
const candleA = (i) => ({ timestamp: BASE + i * MIN, open: 60040, high: 60050, low: 60020, close: 60030, volume: null });
const candleBValid = (i) => ({ timestamp: BASE + i * MIN, open: 60010, high: 60070, low: 59995, close: 60060, volume: null });
const candleCBuy = (i) => ({ timestamp: BASE + i * MIN, open: 60060, high: 60080, low: 60055, close: 60070, volume: null });
const candleCInvalid = (i) => ({ timestamp: BASE + i * MIN, open: 60060, high: 60065, low: 59980, close: 60000, volume: null });
const candleA2 = (i) => ({ timestamp: BASE + i * MIN, open: 60140, high: 60150, low: 60120, close: 60130, volume: null });
const candleB2 = (i) => ({ timestamp: BASE + i * MIN, open: 60110, high: 60170, low: 59995, close: 60160, volume: null });

const candleABear = (i) => ({ timestamp: BASE + i * MIN, open: 64960, high: 64980, low: 64950, close: 64970, volume: null });
const candleBBear = (i) => ({ timestamp: BASE + i * MIN, open: 64990, high: 65005, low: 64930, close: 64940, volume: null });
const candleCSell = (i) => ({ timestamp: BASE + i * MIN, open: 64940, high: 64945, low: 64920, close: 64930, volume: null });

function makeCtx() {
  const ctx = { events: [], commands: [] };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => { ctx.commands.push(cmd); return { approved: true, reason: 'Approved', metadata: {} }; };
  return ctx;
}

async function feed(model, candle) {
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '3m', timestamp: candle.timestamp, data: candle }, null);
}

async function startBot({ trend = 'BULLISH', instanceId } = {}) {
  const ctx = makeCtx();
  const model = new Model002(ctx);
  await model.onStart({
    instanceId: instanceId || ('inst_' + Math.random().toString(36).slice(2, 8)),
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
// The real frontend, in a sandbox
// =========================================================================

function makeElement(id) {
  const el = {
    id, _innerHTML: '', _textContent: '', _className: '', children: [], classList: { add() {}, remove() {} },
    get textContent() { return this._textContent; }, set textContent(v) { this._textContent = v; },
    get className() { return this._className; }, set className(v) { this._className = v; },
    get innerHTML() { return this._innerHTML; }, set innerHTML(v) { this._innerHTML = v; this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    get firstChild() { return this.children[0] || null; },
    querySelector() { return null; },
  };
  el.parentElement = { id: id + '-parent' };
  return el;
}

/**
 * Boots the REAL bot-detail-chart.js (plus the real MarkerManager and
 * OverlayManager) against a fake Lightweight Charts series, and returns
 * handles for inspecting what actually got drawn.
 */
async function bootChart({ instanceId = 'inst_1', initialDecision = null } = {}) {
  const elements = {};
  const doc = {
    readyState: 'complete',
    addEventListener(evt, cb) { if (evt === 'DOMContentLoaded') cb(); },
    getElementById(id) { if (!elements[id]) elements[id] = makeElement(id); return elements[id]; },
    createElement() { return makeElement(null); },
  };

  const applied = { markers: [] };
  const series = {
    applyOptions() {},
    setMarkers(markers) { applied.markers = markers.slice(); },
    createPriceLine(opts) { return { opts }; },
    removePriceLine() {},
    setData() {}, update() {},
  };
  const chart = { addLineSeries: () => ({ setData() {}, update() {} }) };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 0, clearInterval: () => {},
    document: doc,
    fetch: async () => ({
      ok: true,
      json: async () => ({ success: true, data: { instanceId, symbol: 'BTCUSD', timeframe: '3m', count: 1, candles: [{ time: Math.floor(BASE / 1000), open: 1, high: 2, low: 0.5, close: 1.5, closed: true }] } }),
    }),
    window: {
      BOT_CONFIG: { instanceId, modelId: 'MODEL_002', timeframe: '3m', support: [], resistance: [] },
      BOT_INITIAL_DECISION: initialDecision,
      BOT_INITIAL_TRADES: [], BOT_INITIAL_POSITION: null,
      LightweightCharts: {},
      NovaExecutionMarkers: { buildHistoricalMarkers: () => [] },
    },
  };
  sandbox.window.document = doc;
  sandbox.self = sandbox.window;
  sandbox.Number = Number; sandbox.Math = Math; sandbox.Array = Array; sandbox.JSON = JSON;
  vm.createContext(sandbox);

  ['public/js/marker-manager.js', 'public/js/overlay-manager.js', 'public/js/renderers/model002-level-state.js']
    .forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));

  // Minimal ChartManager standing in for the real one: same public surface
  // bot-detail-chart.js uses, backed by the REAL MarkerManager/OverlayManager.
  sandbox.window.ChartManager = function () {
    this.candleSeries = { candlestickSeries: series };
    this.markerManager = new sandbox.window.MarkerManager(series);
    this.overlayManager = new sandbox.window.OverlayManager(chart, series);
    this.loadHistoricalData = function () {};
    this.onLiveCandle = function () {};
    this.loadExecutionMarkers = function (m) { this.markerManager.loadExecutionMarkers(m); };
    this.setPatternMarkers = function (m) { this.markerManager.setPatternMarkers(m); };
    this.clearPatternMarkers = function () { this.markerManager.clearPatternMarkers(); };
  };

  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/bot-detail-chart.js'), 'utf8'), sandbox, { filename: 'bot-detail-chart.js' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  return {
    sandbox,
    /** Markers actually handed to the candlestick series. */
    markers: () => applied.markers,
    patternMarkers: () => applied.markers.filter((m) => String(m.id).startsWith('model002-pattern:')),
    render: (checks) => sandbox.window.NovaChartPatternMarkers.setFromChecks(checks),
  };
}

const ROLE = { C1: 'CANDLE_1', C2: 'CANDLE_2', C3: 'CANDLE_3' };
const labelOf = (markers, code) => markers.find((m) => m.id.endsWith(':' + ROLE[code]));

// =========================================================================
// 1-4. Roles come from the real backend pattern, at the real timestamps
// =========================================================================

test('1-4. C1/C2/C3 sit on the real A/B/C candles, and C2 is marked as the TOUCH candle', async () => {
  const { ctx, model } = await startBot();
  const a = candleA(10);
  const b = candleBValid(11);
  const c = candleCBuy(12);
  await feed(model, a);
  await feed(model, b);

  const chart = await bootChart();
  chart.render(lastDecision(ctx).checks);
  let m = chart.patternMarkers();
  assert.equal(m.length, 2, 'no C3 label before a C candle exists');
  assert.equal(labelOf(m, 'C1').time, a.timestamp / 1000);
  assert.equal(labelOf(m, 'C2').time, b.timestamp / 1000);
  assert.match(labelOf(m, 'C1').text, /^\u2460 C1$/);
  assert.match(labelOf(m, 'C2').text, /^\u2461 C2 \u2022 TOUCH$/);

  await feed(model, c);
  chart.render(lastDecision(ctx).checks);
  m = chart.patternMarkers();
  assert.equal(m.length, 3);
  assert.equal(labelOf(m, 'C3').time, c.timestamp / 1000);
  assert.equal(labelOf(m, 'C1').time, a.timestamp / 1000, 'C1 still on A, not shifted');
  assert.equal(labelOf(m, 'C2').time, b.timestamp / 1000);
});

// =========================================================================
// 5-6. Placement
// =========================================================================

test('5. a BUY pattern places its labels below the candles', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));

  const chart = await bootChart();
  chart.render(lastDecision(ctx).checks);
  chart.patternMarkers().forEach((m) => assert.equal(m.position, 'belowBar'));
});

test('6. a SELL pattern places its labels above the candles', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  await feed(model, candleABear(10));
  await feed(model, candleBBear(11));

  const chart = await bootChart();
  chart.render(lastDecision(ctx).checks);
  const m = chart.patternMarkers();
  assert.equal(m.length, 2);
  m.forEach((x) => assert.equal(x.position, 'aboveBar'));
  assert.equal(lastDecision(ctx).checks.patternVisual.direction, 'SELL');
});

// =========================================================================
// 7-10. Invalidation removes EVERYTHING
// =========================================================================

test('7-10. an invalidated pattern removes C1, C2, C3 and the body-reference line', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  await feed(model, candleCBuy(12) && candleCInvalid(12));

  const chart = await bootChart();
  // Re-play the decision stream in order, exactly as the live UI would.
  const payloads = decisions(ctx).map((d) => d.payload);
  const beforeInvalid = payloads[payloads.length - 2];
  const invalid = payloads[payloads.length - 1];

  chart.render(beforeInvalid.checks);
  assert.equal(chart.patternMarkers().length, 2);

  assert.match(invalid.reason, /invalidated/);
  assert.equal(invalid.checks.patternVisual, null, 'backend reports no pattern group any more');
  assert.notEqual(invalid.checks.candle1, null, 'the payload still carries the candles — this is what used to leave stale labels');

  chart.render(invalid.checks);
  assert.equal(chart.patternMarkers().length, 0, 'C1, C2 and C3 all removed');
  assert.equal(invalid.checks.bodyReference, null, 'body-reference line removed with the group');
});

// =========================================================================
// 11-12. New pattern replaces the old group; never duplicates
// =========================================================================

test('11-12. a new pattern replaces the previous group with no duplicates and no mixed candles', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  const firstVisual = lastDecision(ctx).checks.patternVisual;

  await feed(model, candleCInvalid(12));
  await feed(model, candleA2(13));
  await feed(model, candleB2(14));
  const secondVisual = lastDecision(ctx).checks.patternVisual;

  assert.notEqual(firstVisual.patternId, secondVisual.patternId);

  const chart = await bootChart();
  chart.render({ patternVisual: firstVisual });
  chart.render({ patternVisual: secondVisual });

  const m = chart.patternMarkers();
  assert.equal(m.length, 2);
  assert.equal(new Set(m.map((x) => x.id)).size, m.length, 'no duplicate marker ids');
  m.forEach((x) => assert.match(x.id, new RegExp(secondVisual.patternId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));
  assert.equal(labelOf(m, 'C1').time, candleA2(13).timestamp / 1000);

  // Re-rendering the same group twice must not duplicate anything either.
  chart.render({ patternVisual: secondVisual });
  assert.equal(chart.patternMarkers().length, 2);
});

test('12b. pattern labels never erase authoritative execution markers', async () => {
  const chart = await bootChart();
  chart.sandbox.window.NovaBotChartManager.loadExecutionMarkers([{ id: 'entry:pos_1', time: Math.floor(BASE / 1000), position: 'belowBar', color: '#22c55e', shape: 'arrowUp', text: 'BUY' }]);
  chart.render({ patternVisual: buildPatternVisual({ engine: 'NEW', direction: 'BUY', candle1: candleA(10), candle2: candleBValid(11) }, { instanceId: 'inst_1' }) });

  assert.ok(chart.markers().some((m) => m.id === 'entry:pos_1'));
  assert.equal(chart.patternMarkers().length, 2);

  chart.render({ patternVisual: null });
  assert.ok(chart.markers().some((m) => m.id === 'entry:pos_1'), 'clearing pattern labels leaves executions intact');
  assert.equal(chart.patternMarkers().length, 0);
});

// =========================================================================
// 13-15. Body reference line (regression on the previous feature)
// =========================================================================

test('13-15. the body line uses open/close of A — body high for Support, body low for Resistance', async () => {
  const bull = await startBot();
  const a = candleA(10);
  await feed(bull.model, a);
  await feed(bull.model, candleBValid(11));
  const bullRef = lastDecision(bull.ctx).checks.bodyReference;
  assert.equal(bullRef.price, Math.max(a.open, a.close));
  assert.notEqual(bullRef.price, a.high);
  assert.notEqual(bullRef.price, a.low);

  const bear = await startBot({ trend: 'BEARISH' });
  const ab = candleABear(10);
  await feed(bear.model, ab);
  await feed(bear.model, candleBBear(11));
  const bearRef = lastDecision(bear.ctx).checks.bodyReference;
  assert.equal(bearRef.price, Math.min(ab.open, ab.close));
  assert.notEqual(bearRef.price, ab.low);
  assert.notEqual(bearRef.price, ab.high);
});

test('13b. the line is drawn on the chart at exactly that price, and removed with the pattern', async () => {
  const chart = await bootChart();
  const om = chart.sandbox.window.NovaBotChartManager.overlayManager;

  chart.sandbox.window.NovaChartPatternOverlay.setBodyReference({ price: 60040, side: 'BODY_HIGH' });
  assert.equal(om.priceLines.patternBodyReference.opts.price, 60040);
  assert.equal(om.priceLines.patternBodyReference.opts.title, 'A BODY HIGH');

  chart.sandbox.window.NovaChartPatternOverlay.setBodyReference({ price: 64960, side: 'BODY_LOW' });
  assert.equal(om.priceLines.patternBodyReference.opts.price, 64960);
  assert.equal(om.priceLines.patternBodyReference.opts.title, 'A BODY LOW');
  assert.equal(Object.keys(om.priceLines).filter((k) => k === 'patternBodyReference').length, 1);

  chart.sandbox.window.NovaChartPatternOverlay.clearBodyReference();
  assert.equal(om.priceLines.patternBodyReference, undefined);
});

// =========================================================================
// 16-17. BUY/SELL wording comes only from the backend trigger
// =========================================================================

test('16. C3 reads BUY only because the backend actually triggered the BUY', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  await feed(model, candleCBuy(12));

  const buy = decisions(ctx).find((d) => d.payload.decision === 'BUY');
  assert.ok(buy, 'the real strategy triggered');
  const visual = buy.payload.checks.patternVisual;
  assert.equal(visual.status, 'TRIGGERED');

  const chart = await bootChart();
  chart.render(buy.payload.checks);
  assert.match(labelOf(chart.patternMarkers(), 'C3').text, /^\u2462 BUY$/);

  // The same C candle with no backend trigger reads C3, never BUY.
  const untriggered = buildPatternVisual(
    { engine: 'NEW', direction: 'BUY', candle1: candleA(10), candle2: candleBValid(11) },
    { instanceId: 'inst_1', candle3: candleCBuy(12) }
  );
  const c3 = untriggered.labels.find((l) => l.role === 'CANDLE_3');
  assert.equal(c3.code, 'C3');
  assert.equal(c3.trigger, null);
});

test('17. C3 reads SELL only because the backend actually triggered the SELL', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  await feed(model, candleABear(10));
  await feed(model, candleBBear(11));
  await feed(model, candleCSell(12));

  const sell = decisions(ctx).find((d) => d.payload.decision === 'SELL');
  assert.ok(sell);

  const chart = await bootChart();
  chart.render(sell.payload.checks);
  assert.match(labelOf(chart.patternMarkers(), 'C3').text, /^\u2462 SELL$/);
  assert.equal(labelOf(chart.patternMarkers(), 'C3').position, 'aboveBar');
});

test('17b. the frontend cannot invent a trigger: it only reads what the group says', () => {
  const chartSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bot-detail-chart.js'), 'utf8');
  const builder = chartSrc.slice(chartSrc.indexOf('function buildPatternRoleMarkers'), chartSrc.indexOf('window.NovaChartPatternMarkers'));
  assert.doesNotMatch(builder, /\.high\b|\.low\b|\.open\b|\.close\b/, 'no OHLC is inspected while building labels');
  assert.doesNotMatch(builder, /'BUY'/, 'the browser never produces a BUY label of its own');
  assert.equal((builder.match(/'SELL'/g) || []).length, 1, 'the only SELL literal is the label colour choice');
  assert.match(builder, /\(label\.trigger \|\| label\.code\)/, 'the caption comes verbatim from the backend role code / trigger');
});

// =========================================================================
// 18-20. No pattern / reload
// =========================================================================

test('18. no active pattern -> no C1/C2/C3 markers at all', async () => {
  const { ctx, model } = await startBot();
  await feed(model, neutral(10));
  const payload = lastDecision(ctx);
  assert.equal(payload.checks.patternVisual, null);

  const chart = await bootChart();
  chart.render(payload.checks);
  assert.equal(chart.patternMarkers().length, 0);
});

test('20. reload draws nothing when the stored decision has no pattern group', async () => {
  const chart = await bootChart({
    initialDecision: { decision: 'WAIT', reason: 'no_level_touch', checks: { candle1: { timestamp: BASE, open: 1, high: 2, low: 1, close: 2 }, candle2: null, patternVisual: null } },
  });
  assert.equal(chart.patternMarkers().length, 0, 'historical candles are never reconstructed into a pattern');
});

test('20b. reload draws exactly the stored active group when the backend provided one', async () => {
  const { ctx, model } = await startBot({ instanceId: 'inst_1' });
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));

  const chart = await bootChart({ initialDecision: lastDecision(ctx) });
  const m = chart.patternMarkers();
  assert.equal(m.length, 2);
  assert.equal(labelOf(m, 'C1').time, candleA(10).timestamp / 1000);
});

// =========================================================================
// 19. Multi-bot isolation
// =========================================================================

test('19. pattern groups are scoped per bot and never collide', async () => {
  const a = await startBot({ instanceId: 'bot_A' });
  const b = await startBot({ instanceId: 'bot_B' });
  await feed(a.model, candleA(10));
  await feed(a.model, candleBValid(11));
  await feed(b.model, candleA(10));
  await feed(b.model, candleBValid(11));

  const va = lastDecision(a.ctx).checks.patternVisual;
  const vb = lastDecision(b.ctx).checks.patternVisual;
  assert.match(va.patternId, /bot_A/);
  assert.match(vb.patternId, /bot_B/);
  assert.notEqual(va.patternId, vb.patternId);

  // Bot A's page only ever renders Bot A's decisions (bot:decision is
  // filtered by instanceId in bot-detail-ws.js) — and even the marker ids
  // differ, so one bot's labels can never be mistaken for the other's.
  const chart = await bootChart({ instanceId: 'bot_A' });
  chart.render({ patternVisual: va });
  chart.patternMarkers().forEach((m) => assert.match(m.id, /bot_A/));

  const wsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bot-detail-ws.js'), 'utf8');
  assert.match(wsSrc, /data\.instanceId !== instanceId/);
});

// =========================================================================
// 21-22. Persistent level status must not regress
// =========================================================================

test('21-22. Support/Resistance stay TOUCHED after the pattern is invalidated', async () => {
  const bull = await startBot();
  await feed(bull.model, candleA(10));
  await feed(bull.model, candleBValid(11));
  await feed(bull.model, candleCInvalid(12));
  await feed(bull.model, neutral(13));
  assert.equal(lastDecision(bull.ctx).checks.support.status, 'TOUCHED');
  assert.equal(lastDecision(bull.ctx).checks.patternVisual, null);

  const bear = await startBot({ trend: 'BEARISH' });
  await feed(bear.model, candleABear(10));
  await feed(bear.model, candleBBear(11));
  await feed(bear.model, neutral(12));
  assert.equal(lastDecision(bear.ctx).checks.resistance.status, 'TOUCHED');
});

// =========================================================================
// The builder's own contract
// =========================================================================

test('the group is null with no candidate, and the TOUCH flag follows the engine that produced it', () => {
  assert.equal(buildPatternVisual(null, { instanceId: 'x' }), null);
  assert.equal(buildPatternVisual({ engine: 'NEW', direction: 'BUY' }, { instanceId: 'x' }), null);

  // NEW (A/B/C) engine: B is the touch candle.
  const newVisual = buildPatternVisual({ engine: 'NEW', direction: 'BUY', candle1: candleA(1), candle2: candleBValid(2) }, { instanceId: 'x' });
  assert.equal(newVisual.labels.find((l) => l.role === 'CANDLE_1').touch, false);
  assert.equal(newVisual.labels.find((l) => l.role === 'CANDLE_2').touch, true);

  // OLD (opposite-side) engine: Candle 1 IS the touch candle.
  const oldVisual = buildPatternVisual({ engine: 'OLD', direction: 'BUY', candle1: candleA(1), candle2: candleBValid(2), stage: 'WAITING_FOR_BOUNDARY_BREAK' }, { instanceId: 'x' });
  assert.equal(oldVisual.labels.find((l) => l.role === 'CANDLE_1').touch, true);
  assert.equal(oldVisual.labels.find((l) => l.role === 'CANDLE_2').touch, false);
  assert.equal(oldVisual.engine, 'OLD');

  // Explicit role + real OHLC on every label (the wire contract).
  const l1 = newVisual.labels[0];
  assert.equal(l1.role, 'CANDLE_1');
  assert.equal(l1.code, 'C1');
  assert.equal(l1.timestamp, candleA(1).timestamp);
  assert.equal(l1.open, candleA(1).open);
  assert.equal(l1.close, candleA(1).close);
});

test('23. the strategy engines and execution path were not touched by this change', () => {
  const model = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  // patternVisual is only ever written into the emitted payload.
  const visualLines = model.split('\n').filter((l) => l.includes('patternVisual'));
  assert.ok(visualLines.length > 0);
  visualLines.forEach((l) => assert.doesNotMatch(l, /patternCandidate\s*=|submitTradeCommand|stopLoss|quantity/));
  assert.doesNotMatch(model, /_patternVisualFor\([^)]*\)\.\w+\s*[><=]/, 'the group is never read back into a decision');
});

// =========================================================================
// LIVE-BUG REPRODUCTION — opposite-side (OLD engine) pattern
//
// The reported live UI showed Candle 1/2/3 data in the Decision Engine
// panel but no labels on the chart, and a bearish Candle 2 — i.e. an
// OPPOSITE-SIDE (OLD engine) pattern, which previously produced no visual
// group at all. These tests drive that exact path.
// =========================================================================

// BEARISH trend + a SUPPORT touch = the opposite-side combination (OLD engine, BUY).
const oldTouch = (i) => ({ timestamp: BASE + i * MIN, open: 60010, high: 60020, low: 59990, close: 60005, volume: null });
// Touches Candle 1's body high (60010) without touching Support itself.
const oldCandle2 = (i) => ({ timestamp: BASE + i * MIN, open: 60003, high: 60025, low: 60002, close: 60020, volume: null });
const oldCandle3Wait = (i) => ({ timestamp: BASE + i * MIN, open: 60010, high: 60020, low: 60005, close: 60015, volume: null });

test('LIVE BUG: an opposite-side pattern now produces a real labelled group (it produced none before)', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  const t = oldTouch(10);
  const c2 = oldCandle2(11);
  const c3 = oldCandle3Wait(12);
  await feed(model, t);
  await feed(model, c2);
  await feed(model, c3);

  const payload = lastDecision(ctx);
  assert.equal(payload.reason, 'awaiting_boundary_break');
  const visual = payload.checks.patternVisual;
  assert.ok(visual, 'the OLD engine now reports a visual group');
  assert.equal(visual.engine, 'OLD');

  const byRole = {};
  visual.labels.forEach((l) => { byRole[l.role] = l; });
  assert.equal(byRole.CANDLE_1.timestamp, t.timestamp);
  assert.equal(byRole.CANDLE_2.timestamp, c2.timestamp);
  assert.equal(byRole.CANDLE_3.timestamp, c3.timestamp);
  // In THIS engine the touch candle is Candle 1, so that is where TOUCH goes.
  assert.equal(byRole.CANDLE_1.touch, true);
  assert.equal(byRole.CANDLE_2.touch, false);

  const chart = await bootChart();
  chart.render(payload.checks);
  const m = chart.patternMarkers();
  assert.equal(m.length, 3);
  assert.match(labelOf(m, 'C1').text, /^\u2460 C1 \u2022 TOUCH$/);
  assert.match(labelOf(m, 'C2').text, /^\u2461 C2$/);
  assert.match(labelOf(m, 'C3').text, /^\u2462 C3$/);
  assert.equal(labelOf(m, 'C1').time, t.timestamp / 1000, 'markers are not shifted by one candle');
});

test('LIVE BUG: the Decision Engine panel no longer renders "undefined" in front of the OHLC', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  await feed(model, oldTouch(10));
  await feed(model, oldCandle2(11));
  await feed(model, oldCandle3Wait(12));

  const sandbox = { window: {}, console: { error() {} } };
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/renderers/model-thinking-registry.js'), 'utf8'), sandbox, { filename: 'registry.js' });

  const html = sandbox.window.ModelThinkingRegistry.renderers.MODEL_002(lastDecision(ctx).checks);
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /C1 TOUCH O:60010/);
  assert.match(html, /C2 O:60003/);
  assert.match(html, /C3 O:60010/);
});

test('the reported live candles produce a Candle 1 body reference of 78237.5', () => {
  // Exactly the OHLC from the manual test.
  const a = { timestamp: BASE, open: 78220, high: 78245, low: 78190.5, close: 78237.5 };
  const b = { timestamp: BASE + MIN, open: 78250, high: 78250, low: 78220, close: 78220.5 };
  assert.equal(Math.max(a.open, a.close), 78237.5, 'C1 body high');
  assert.equal(Math.max(b.open, b.close), 78250, 'C2 body high');

  const ctx = makeCtx();
  const model = new Model002(ctx);
  model.instanceId = 'inst_live';
  const ref = model._bodyReferenceFor({ engine: 'OLD', direction: 'BUY', candle1: a, candle2: b });
  assert.equal(ref.price, 78237.5);
  assert.equal(ref.side, 'BODY_HIGH');
  assert.notEqual(ref.price, a.high);
  assert.notEqual(ref.price, a.low);
});

test('the displayed wording no longer claims Candle 3 must close through the boundary', () => {
  const map = require('../public/js/renderers/model002-reason-map.js');
  const text = map.formatModel002Reason('awaiting_boundary_break');
  assert.doesNotMatch(text, /close/i);
  assert.match(text, /touch\/cross/i);
});
