'use strict';

/**
 * MODEL_002 BOUNDARY LABELS — direction-driven, never trend-driven.
 *
 * The chart used to hard-code "UPPER (BUY>)" / "LOWER (INVALID<)", which is
 * wrong for every SELL pattern — including a BULLISH bot whose Resistance
 * touch routes, through the EXISTING opposite-side rule, to SELL.
 *
 * These tests drive the REAL Model002 through real candles for all four
 * trend/level combinations, then feed those exact decision payloads to the
 * REAL frontend (bot-detail-chart.js + the real OverlayManager) and assert
 * on the price lines that actually reached the series.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Model002 = require('../bot-models/model-002/Model002');
const levelState = require('../public/js/renderers/model002-level-state.js');

const MIN = 60000;
const BASE = 1_700_000_000_000;
const SUPPORT = [60000, 59000, 58000];
const RESISTANCE = [65000, 66000, 67000];

function makeCtx() {
  const ctx = { events: [], commands: [] };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => { ctx.commands.push(cmd); return { approved: true, reason: 'Approved' }; };
  return ctx;
}

const neutral = (i) => ({ timestamp: BASE + i * MIN, open: 62500, high: 62510, low: 62490, close: 62505, volume: null });

async function feed(model, candle) {
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '3m', timestamp: candle.timestamp, data: candle }, null);
}

async function startBot({ trend, instanceId = 'inst_1' } = {}) {
  const ctx = makeCtx();
  const model = new Model002(ctx);
  await model.onStart({
    instanceId, symbol: 'BTCUSD', environment: 'PAPER',
    parameters: { timeframe: '3m', trend, support: SUPPORT, resistance: RESISTANCE, historySize: 20 },
    capitalAllocation: 10000, leverage: 10, riskSettings: {},
  });
  for (let i = 0; i < 4; i += 1) await feed(model, neutral(i));
  return { ctx, model };
}

const decisions = (ctx) => ctx.events.filter((e) => e.eventType === 'DECISION');
const lastDecision = (ctx) => decisions(ctx)[decisions(ctx).length - 1].payload;

// --- same-side (NEW engine) fixtures --------------------------------------

const candleA = (i) => ({ timestamp: BASE + i * MIN, open: 60040, high: 60050, low: 60020, close: 60030, volume: null });
const candleBValid = (i) => ({ timestamp: BASE + i * MIN, open: 60010, high: 60070, low: 59995, close: 60060, volume: null });
const candleABear = (i) => ({ timestamp: BASE + i * MIN, open: 64960, high: 64980, low: 64950, close: 64970, volume: null });
const candleBBear = (i) => ({ timestamp: BASE + i * MIN, open: 64990, high: 65005, low: 64930, close: 64940, volume: null });

// --- opposite-side (OLD engine) fixtures ----------------------------------
// BULLISH + Resistance touch -> SELL; BEARISH + Support touch -> BUY.

const resTouch = (i) => ({ timestamp: BASE + i * MIN, open: 64995, high: 65010, low: 64985, close: 65005, volume: null });
// Touches Candle 1's body low (64995) without touching Resistance itself.
const resCandle2 = (i) => ({ timestamp: BASE + i * MIN, open: 64998, high: 64999, low: 64980, close: 64985, volume: null });
const supTouch = (i) => ({ timestamp: BASE + i * MIN, open: 60010, high: 60020, low: 59990, close: 60005, volume: null });
const supCandle2 = (i) => ({ timestamp: BASE + i * MIN, open: 60003, high: 60025, low: 60002, close: 60020, volume: null });

// =========================================================================
// The pure mapping
// =========================================================================

test('1-2. getBoundaryLabels maps direction, and only direction', () => {
  assert.deepEqual(levelState.getBoundaryLabels('BUY'), { upper: 'UPPER (BUY>)', lower: 'LOWER (INVALID<)' });
  assert.deepEqual(levelState.getBoundaryLabels('SELL'), { upper: 'UPPER (INVALID>)', lower: 'LOWER (SELL<)' });
});

test('7. with no active pattern the captions assert no direction at all', () => {
  assert.deepEqual(levelState.getBoundaryLabels(null), { upper: 'UPPER', lower: 'LOWER' });
  assert.deepEqual(levelState.getBoundaryLabels(undefined), { upper: 'UPPER', lower: 'LOWER' });
  assert.deepEqual(levelState.getBoundaryLabels('BULLISH'), { upper: 'UPPER', lower: 'LOWER' }, 'a trend is not a direction');
});

test('the chart file no longer hard-codes a direction anywhere', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bot-detail-chart.js'), 'utf8');
  assert.doesNotMatch(src, /'UPPER \(BUY>\)'/);
  assert.doesNotMatch(src, /'LOWER \(INVALID<\)'/);
  const wsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bot-detail-ws.js'), 'utf8');
  assert.doesNotMatch(wsSrc, /trend\s*===\s*'BULLISH'\s*\?/);
});

// =========================================================================
// The real frontend, boundary lines as actually drawn
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

async function bootChart({ instanceId = 'inst_1' } = {}) {
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
    setMarkers(m) { applied.markers = m.slice(); },
    createPriceLine(opts) { return { opts }; },
    removePriceLine() {},
    setData() {}, update() {},
  };
  const chart = { addLineSeries: () => ({ setData() {}, update() {} }) };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 0, clearInterval: () => {},
    document: doc,
    fetch: async () => ({ ok: true, json: async () => ({ success: true, data: { instanceId, symbol: 'BTCUSD', timeframe: '3m', count: 0, candles: [] } }) }),
    window: {
      BOT_CONFIG: { instanceId, modelId: 'MODEL_002', timeframe: '3m', support: [], resistance: [] },
      BOT_INITIAL_DECISION: null, BOT_INITIAL_TRADES: [], BOT_INITIAL_POSITION: null,
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
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const om = sandbox.window.NovaBotChartManager.overlayManager;
  return {
    sandbox,
    /** Applies a real decision payload exactly as bot-detail-ws.js does. */
    applyDecision(checks) {
      const group = checks && checks.patternVisual;
      const b = checks && checks.boundaries;
      if (group && b && b.upper != null && b.lower != null) {
        sandbox.window.NovaChartPatternOverlay.setBoundaries(b.upper, b.lower, group.direction);
      } else {
        sandbox.window.NovaChartPatternOverlay.clearBoundaries();
      }
      sandbox.window.NovaChartPatternMarkers.setFromChecks(checks || null);
    },
    lines: () => om.priceLines,
    patternMarkers: () => applied.markers.filter((m) => String(m.id).startsWith('model002-pattern:')),
  };
}

const upperLine = (chart) => chart.lines().patternUpperBoundary && chart.lines().patternUpperBoundary.opts;
const lowerLine = (chart) => chart.lines().patternLowerBoundary && chart.lines().patternLowerBoundary.opts;

// =========================================================================
// 3-6. All four trend/level combinations, driven by the real engine
// =========================================================================

test('3. BULLISH + SUPPORT (same-side, BUY): upper is the BUY side, lower invalidates', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));

  const checks = lastDecision(ctx).checks;
  assert.equal(checks.patternVisual.direction, 'BUY');

  const chart = await bootChart();
  chart.applyDecision(checks);
  assert.equal(upperLine(chart).title, 'UPPER (BUY>)');
  assert.equal(lowerLine(chart).title, 'LOWER (INVALID<)');
  assert.equal(upperLine(chart).color, '#22c55e', 'trigger side is green');
  assert.equal(lowerLine(chart).color, '#f43f5e');
});

test('4. BULLISH + RESISTANCE (opposite-side, SELL): upper invalidates, lower is the SELL side', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, resTouch(10));
  await feed(model, resCandle2(11));

  const payload = lastDecision(ctx);
  // The existing routing really does produce SELL here — this is the exact
  // screenshot scenario (Trend BULLISH, Resistance TOUCHED, awaiting break).
  assert.equal(payload.reason, 'candle2_confirmed_awaiting_boundary_break');
  assert.equal(payload.checks.resistance.status, 'TOUCHED');
  assert.equal(payload.checks.trend.status, 'BULLISH');
  assert.equal(payload.checks.patternVisual.direction, 'SELL');
  assert.equal(payload.checks.patternState, 'WAITING_FOR_BOUNDARY_BREAK');

  const chart = await bootChart();
  chart.applyDecision(payload.checks);
  assert.equal(upperLine(chart).title, 'UPPER (INVALID>)');
  assert.equal(lowerLine(chart).title, 'LOWER (SELL<)');
  assert.equal(lowerLine(chart).color, '#22c55e', 'the SELL trigger side is the green one');
  assert.equal(upperLine(chart).color, '#f43f5e');
});

test('5. BEARISH + RESISTANCE (same-side, SELL): SELL labels', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  await feed(model, candleABear(10));
  await feed(model, candleBBear(11));

  const checks = lastDecision(ctx).checks;
  assert.equal(checks.patternVisual.direction, 'SELL');

  const chart = await bootChart();
  chart.applyDecision(checks);
  assert.equal(upperLine(chart).title, 'UPPER (INVALID>)');
  assert.equal(lowerLine(chart).title, 'LOWER (SELL<)');
});

test('6. BEARISH + SUPPORT (opposite-side, BUY): BUY labels', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  await feed(model, supTouch(10));
  await feed(model, supCandle2(11));

  const payload = lastDecision(ctx);
  assert.equal(payload.checks.patternVisual.direction, 'BUY');
  assert.equal(payload.checks.trend.status, 'BEARISH');

  const chart = await bootChart();
  chart.applyDecision(payload.checks);
  assert.equal(upperLine(chart).title, 'UPPER (BUY>)');
  assert.equal(lowerLine(chart).title, 'LOWER (INVALID<)');
});

// =========================================================================
// 8-10. Nothing previously working was broken
// =========================================================================

test('8. C1/C2/C3 labels still render alongside the corrected boundaries', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, resTouch(10));
  await feed(model, resCandle2(11));

  const chart = await bootChart();
  chart.applyDecision(lastDecision(ctx).checks);
  const m = chart.patternMarkers();
  assert.equal(m.length, 2);
  assert.match(m.find((x) => x.id.endsWith('CANDLE_1')).text, /^\u2460 C1 \u2022 TOUCH$/);
  assert.match(m.find((x) => x.id.endsWith('CANDLE_2')).text, /^\u2461 C2$/);
  m.forEach((x) => assert.equal(x.position, 'aboveBar', 'a SELL pattern labels above the candles'));
});

test('9. invalidation removes the boundary lines together with C1/C2/C3', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, resTouch(10));
  await feed(model, resCandle2(11));

  const chart = await bootChart();
  chart.applyDecision(lastDecision(ctx).checks);
  assert.ok(upperLine(chart));
  assert.equal(chart.patternMarkers().length, 2);

  // Close above the upper boundary invalidates a SELL pattern.
  await feed(model, { timestamp: BASE + 12 * MIN, open: 64998, high: 65020, low: 64996, close: 65015, volume: null });
  const invalid = lastDecision(ctx);
  assert.match(invalid.reason, /invalidated/);
  assert.equal(invalid.checks.patternVisual, null);
  assert.notEqual(invalid.checks.boundaries, null, 'the payload still carries boundaries — they must not be drawn from that alone');

  chart.applyDecision(invalid.checks);
  assert.equal(upperLine(chart), undefined);
  assert.equal(lowerLine(chart), undefined);
  assert.equal(chart.patternMarkers().length, 0);
  assert.equal(invalid.checks.bodyReference, null);
});

test('10. a refresh with no active pattern draws no boundary lines and no labels', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, neutral(10));

  const chart = await bootChart();
  chart.applyDecision(lastDecision(ctx).checks);
  assert.equal(upperLine(chart), undefined);
  assert.equal(lowerLine(chart), undefined);
  assert.equal(chart.patternMarkers().length, 0);
});

// =========================================================================
// The panel must agree with the chart
// =========================================================================

test('the decision panel shows the same backend direction the chart uses', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, resTouch(10));
  await feed(model, resCandle2(11));

  const sandbox = { window: {}, console: { error() {} } };
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/renderers/model-thinking-registry.js'), 'utf8'), sandbox, { filename: 'registry.js' });

  const html = sandbox.window.ModelThinkingRegistry.renderers.MODEL_002(lastDecision(ctx).checks);
  assert.match(html, /Direction/);
  assert.match(html, />SELL</);
  assert.match(html, /BULLISH/);
  assert.match(html, /WAITING_FOR_BOUNDARY_BREAK/);
});
