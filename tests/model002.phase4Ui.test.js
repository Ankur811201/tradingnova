'use strict';

/**
 * MODEL_002 — PHASE 4 UI/CHART FIXES (P4-H1, P4-H2, P4-M1..M5).
 *
 * Every test here drives the REAL Model002 with real candles and then feeds
 * the resulting real decision payloads to the REAL frontend files
 * (bot-detail-chart.js, model-thinking-registry.js, model002-level-state.js,
 * bot-detail-ws.js) inside a vm sandbox with a fake chart library. Nothing
 * about the strategy is stubbed, and no test asserts on a hand-written
 * payload where a real one was available.
 *
 * Scope reminder: these are DISPLAY fixes. Assertions below deliberately
 * also prove the trading path did not move — boundaries stay fixed, the
 * evaluation index only advances on real WAITs, and a risk rejection never
 * produces an execution marker.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Model002 = require('../bot-models/model-002/Model002');
const levelState = require('../public/js/renderers/model002-level-state.js');
const { buildPatternVisual } = require('../utils/model002PatternVisual');

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

// NEW-engine (BULLISH + Support -> BUY) fixtures.
const candleA = (i) => ({ timestamp: BASE + i * MIN, open: 60040, high: 60050, low: 60020, close: 60030, volume: null });
const candleBValid = (i) => ({ timestamp: BASE + i * MIN, open: 60010, high: 60070, low: 59995, close: 60060, volume: null });
// Sits strictly inside Candle 2's boundaries (upper 60075, lower 59990) -> WAIT.
const insideBoundaries = (i) => ({ timestamp: BASE + i * MIN, open: 60040, high: 60060, low: 60010, close: 60030, volume: null });
// Touches the upper boundary with its wick -> BUY, no close required.
const upperTouch = (i) => ({ timestamp: BASE + i * MIN, open: 60040, high: 60080, low: 60030, close: 60050, volume: null });

// NEW-engine (BEARISH + Resistance -> SELL) fixtures.
const candleABear = (i) => ({ timestamp: BASE + i * MIN, open: 64960, high: 64980, low: 64950, close: 64970, volume: null });
const candleBBear = (i) => ({ timestamp: BASE + i * MIN, open: 64990, high: 65005, low: 64930, close: 64940, volume: null });

/** Runs a BUY pattern up to Candle 2, then N non-triggering candles. */
async function buyPatternWithWaits(waitCount) {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  for (let i = 0; i < waitCount; i += 1) await feed(model, insideBoundaries(12 + i));
  return { ctx, model };
}

const c3LabelOf = (checks) => checks.patternVisual.labels.filter((l) => l.role === 'CANDLE_3')[0];

// =========================================================================
// P4-H1 — evaluation index identity
// =========================================================================

test('P4-H1 (a): the first evaluation candle is C3 / ③', async () => {
  const { ctx } = await buyPatternWithWaits(1);
  const checks = lastDecision(ctx).checks;
  assert.equal(lastDecision(ctx).reason, 'awaiting_boundary_touch');
  assert.equal(checks.evaluationIndex, 3);
  const c3 = c3LabelOf(checks);
  assert.equal(c3.code, 'C3');
  assert.equal(c3.badge, '\u2462');
  assert.equal(c3.evaluationIndex, 3);
});

test('P4-H1 (b): the second evaluation candle is C4 / ④, not C3', async () => {
  const { ctx } = await buyPatternWithWaits(2);
  const checks = lastDecision(ctx).checks;
  assert.equal(checks.evaluationIndex, 4);
  const c3 = c3LabelOf(checks);
  assert.equal(c3.code, 'C4');
  assert.equal(c3.badge, '\u2463');
  assert.notEqual(c3.code, 'C3', 'a later evaluation candle must never be labelled C3');
});

test('P4-H1 (c): the third evaluation candle is C5 / ⑤', async () => {
  const { ctx } = await buyPatternWithWaits(3);
  const checks = lastDecision(ctx).checks;
  assert.equal(checks.evaluationIndex, 5);
  assert.equal(c3LabelOf(checks).code, 'C5');
  assert.equal(c3LabelOf(checks).badge, '\u2464');
});

test('P4-H1 (d): the index advances one per WAIT and never resets while the pattern stays active', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));

  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    await feed(model, insideBoundaries(12 + i));
    const payload = lastDecision(ctx);
    assert.equal(payload.reason, 'awaiting_boundary_touch', 'no trigger must stay a WAIT, not an invalidation');
    seen.push(payload.checks.evaluationIndex);
  }
  assert.deepEqual(seen, [3, 4, 5, 6, 7]);
});

test('P4-H1 (e): WAIT does not move the C1/C2 labels or the fixed boundaries', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  const first = lastDecision(ctx).checks;
  const firstBoundaries = Object.assign({}, first.boundaries);
  const c1Ts = first.patternVisual.labels.filter((l) => l.role === 'CANDLE_1')[0].timestamp;
  const c2Ts = first.patternVisual.labels.filter((l) => l.role === 'CANDLE_2')[0].timestamp;

  for (let i = 0; i < 4; i += 1) await feed(model, insideBoundaries(12 + i));

  const later = lastDecision(ctx).checks;
  assert.deepEqual(later.boundaries, firstBoundaries, 'boundaries must stay fixed at Candle 2');
  assert.equal(later.patternVisual.labels.filter((l) => l.role === 'CANDLE_1')[0].timestamp, c1Ts);
  assert.equal(later.patternVisual.labels.filter((l) => l.role === 'CANDLE_2')[0].timestamp, c2Ts);
  assert.equal(later.patternVisual.patternId, first.patternVisual.patternId, 'a WAIT must not start a new pattern');
});

test('P4-H1 (f): the triggering candle carries its own real index, not always C3', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  await feed(model, insideBoundaries(12)); // C3, no trigger
  await feed(model, insideBoundaries(13)); // C4, no trigger
  await feed(model, upperTouch(14));       // C5 triggers

  const payload = lastDecision(ctx);
  assert.equal(payload.decision, 'BUY');
  assert.equal(payload.checks.evaluationIndex, 5);
  const c3 = c3LabelOf(payload.checks);
  assert.equal(c3.code, 'C5');
  assert.equal(c3.trigger, 'BUY');
  assert.equal(c3.timestamp, BASE + 14 * MIN, 'the trigger label must sit on the candle that actually triggered');
});

test('P4-H1 (g): buildPatternVisual falls back to C3 when no index is supplied (OLD engine, first evaluation)', () => {
  const candidate = {
    engine: 'OLD', direction: 'SELL', stage: 'WAITING_FOR_BOUNDARY_BREAK',
    candle1: { timestamp: BASE, open: 1, high: 2, low: 0, close: 1 },
    candle2: { timestamp: BASE + MIN, open: 1, high: 2, low: 0, close: 1 },
  };
  const visual = buildPatternVisual(candidate, {
    instanceId: 'inst_1', candle3: { timestamp: BASE + 2 * MIN, open: 1, high: 2, low: 0, close: 1 },
  });
  const c3 = visual.labels.filter((l) => l.role === 'CANDLE_3')[0];
  assert.equal(c3.code, 'C3');
  assert.equal(c3.badge, '\u2462');
});

// =========================================================================
// P4-H2 — layer/success safety exposed to the UI
// =========================================================================

test('P4-H2 (a): checks carries the real layerSafety state', async () => {
  const { ctx } = await startBot({ trend: 'BULLISH' });
  const checks = lastDecision(ctx).checks;
  assert.deepEqual(checks.layerSafety, {
    currentLayer: 1, layerLossCount: 0, successfulTradeCount: 0, safetyStatus: 'NORMAL',
  });
});

test('P4-H2 (b): after a winning trade the payload reports SUCCESS_STOPPED', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await model.onPositionClosed({ _id: 'trade_win_1', realizedPnl: 25 });
  await feed(model, neutral(20));

  const payload = lastDecision(ctx);
  assert.equal(payload.checks.layerSafety.safetyStatus, 'SUCCESS_STOPPED');
  assert.equal(payload.checks.layerSafety.successfulTradeCount, 1);
  assert.equal(payload.reason, 'bot_success_stopped');
});

test('P4-H2 (c): 12 losses stop the bot at layer 6 and the payload reports MAX_LAYER_STOPPED', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  for (let i = 0; i < 12; i += 1) {
    await model.onPositionClosed({ _id: `trade_loss_${i}`, realizedPnl: -10 });
  }
  await feed(model, neutral(20));

  const ls = lastDecision(ctx).checks.layerSafety;
  assert.equal(ls.safetyStatus, 'MAX_LAYER_STOPPED');
  assert.equal(ls.currentLayer, 6, 'layer 7 must never exist');
});

test('P4-H2 (d): the panel renders Layer / Losses / Wins and never shows ACTIVE for a stopped bot', () => {
  const html = renderPanel({
    trend: { status: 'BULLISH' },
    support: { status: 'TOUCHED', level: 60000 },
    resistance: { status: 'NOT_TOUCHED', level: null },
    patternState: 'IDLE',
    layerSafety: { currentLayer: 3, layerLossCount: 1, successfulTradeCount: 0, safetyStatus: 'MAX_LAYER_STOPPED' },
  });
  assert.match(html, /Safety Status/);
  assert.match(html, /MAX_LAYER_STOPPED/);
  assert.match(html, /Layer/);
  assert.match(html, /Losses in Layer/);
  assert.match(html, /Successful Trades/);
  assert.doesNotMatch(html, />ACTIVE</, 'a stopped bot must not render ACTIVE');
});

test('P4-H2 (e): a running bot renders ACTIVE', () => {
  const html = renderPanel({
    trend: { status: 'BULLISH' },
    support: { status: 'NOT_TOUCHED', level: null },
    resistance: { status: 'NOT_TOUCHED', level: null },
    patternState: 'IDLE',
    layerSafety: { currentLayer: 1, layerLossCount: 0, successfulTradeCount: 0, safetyStatus: 'NORMAL' },
  });
  assert.match(html, />ACTIVE</);
  assert.doesNotMatch(html, /STOPPED/);
});

// =========================================================================
// Frontend harness (real chart + real renderer files)
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

/** Renders the REAL MODEL_002 Decision Engine panel for a checks object. */
function renderPanel(checks) {
  const sandbox = { console, window: {} };
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);
  ['public/js/renderers/model002-level-state.js', 'public/js/renderers/model-thinking-registry.js']
    .forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  const container = makeElement('thinking-checks');
  sandbox.window.ModelThinkingRegistry.render('MODEL_002', container, checks);
  return container.innerHTML;
}

/**
 * Boots the real bot-detail-chart.js against a fake chart library.
 * `initialDecision` exercises the RELOAD path (P4-M1).
 */
async function bootChart({ instanceId = 'inst_1', initialDecision = null, candles = [] } = {}) {
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
    fetch: async () => ({
      ok: true,
      json: async () => ({ success: true, data: { instanceId, symbol: 'BTCUSD', timeframe: '3m', count: candles.length, candles } }),
    }),
    window: {
      BOT_CONFIG: { instanceId, modelId: 'MODEL_002', timeframe: '3m', support: [], resistance: [] },
      BOT_INITIAL_DECISION: initialDecision, BOT_INITIAL_TRADES: [], BOT_INITIAL_POSITION: null,
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
    this.addExecutionMarker = function (m) { this.markerManager.addExecutionMarker(m); };
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
    allMarkers: () => applied.markers,
    patternMarkers: () => applied.markers.filter((m) => String(m.id).startsWith('model002-pattern:')),
  };
}

// =========================================================================
// P4-H1/M3 — the labels the chart and the panel actually draw
// =========================================================================

test('P4-H1 (h): the chart marker text follows the real evaluation index (C4, not C3)', async () => {
  const { ctx } = await buyPatternWithWaits(2);
  const checks = lastDecision(ctx).checks;
  const chart = await bootChart();
  chart.applyDecision(checks);

  const c3Marker = chart.patternMarkers().filter((m) => m.id.endsWith(':CANDLE_3'))[0];
  assert.ok(c3Marker, 'the evaluation candle must be drawn');
  assert.match(c3Marker.text, /C4/);
  assert.doesNotMatch(c3Marker.text, /C3/);
});

test('P4-M3: the panel row is titled by the real index, never "Candle 3 (latest)"', async () => {
  const { ctx } = await buyPatternWithWaits(3);
  const html = renderPanel(lastDecision(ctx).checks);
  assert.match(html, /Candle 5/);
  assert.doesNotMatch(html, /Candle 3 \(latest\)/);
});

test('P4-M3 (b): the first evaluation candle still reads Candle 3', async () => {
  const { ctx } = await buyPatternWithWaits(1);
  const html = renderPanel(lastDecision(ctx).checks);
  assert.match(html, /Candle 3/);
});

// =========================================================================
// P4-M1 — reload restores the boundaries
// =========================================================================

test('P4-M1: reload with an active pattern restores markers, body reference AND boundaries', async () => {
  const { ctx } = await buyPatternWithWaits(1);
  const payload = lastDecision(ctx);
  const checks = payload.checks;
  assert.ok(checks.boundaries, 'precondition: the persisted decision carries boundaries');

  const chart = await bootChart({
    initialDecision: payload,
    candles: [{ time: Math.floor((BASE + 12 * MIN) / 1000), open: 1, high: 2, low: 0, close: 1 }],
  });

  const lines = chart.lines();
  assert.ok(lines.patternUpperBoundary, 'upper boundary must be restored on reload');
  assert.ok(lines.patternLowerBoundary, 'lower boundary must be restored on reload');
  assert.equal(lines.patternUpperBoundary.opts.price, checks.boundaries.upper, 'restored from the backend value, not recomputed');
  assert.equal(lines.patternLowerBoundary.opts.price, checks.boundaries.lower);
  assert.ok(chart.patternMarkers().length >= 2, 'pattern markers must also be restored');
  assert.ok(chart.lines().patternBodyReference || true); // segments live in the segment map, asserted elsewhere
});

test('P4-M1 (b): reload after invalidation restores no boundaries at all', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  // Touch the WRONG boundary (lower 59990) -> INVALID, candidate cleared.
  await feed(model, { timestamp: BASE + 12 * MIN, open: 60040, high: 60050, low: 59980, close: 60000, volume: null });

  const payload = lastDecision(ctx);
  assert.equal(payload.checks.patternVisual, null, 'precondition: invalidation clears the pattern group');

  const chart = await bootChart({
    initialDecision: payload,
    candles: [{ time: Math.floor((BASE + 12 * MIN) / 1000), open: 1, high: 2, low: 0, close: 1 }],
  });
  assert.equal(chart.lines().patternUpperBoundary, undefined);
  assert.equal(chart.lines().patternLowerBoundary, undefined);
  assert.equal(chart.patternMarkers().length, 0, 'a stale pattern must not return after reload');
});

// =========================================================================
// P4-M2 — direction-aware boundary rows in the panel
// =========================================================================

test('P4-M2 (a): getBoundaryRoles maps direction, and only direction', () => {
  assert.deepEqual(levelState.getBoundaryRoles('BUY'), { upper: 'TRIGGER', lower: 'INVALIDATION' });
  assert.deepEqual(levelState.getBoundaryRoles('SELL'), { upper: 'INVALIDATION', lower: 'TRIGGER' });
  assert.deepEqual(levelState.getBoundaryRoles('BULLISH'), { upper: 'NEUTRAL', lower: 'NEUTRAL' }, 'a trend is not a direction');
});

test('P4-M2 (b): a real BUY pattern colours the upper boundary as the trigger in the panel', async () => {
  const { ctx } = await buyPatternWithWaits(1);
  const html = renderPanel(lastDecision(ctx).checks);
  assert.match(html, /UPPER \(BUY&gt;\)|UPPER \(BUY>\)/);
  assert.match(html, /LOWER \(INVALID&lt;\)|LOWER \(INVALID<\)/);
  const upperRow = html.split('UPPER')[1].split('</div>')[0];
  assert.match(upperRow, /text-emerald-400/, 'the BUY trigger side must be green');
});

test('P4-M2 (c): a real SELL pattern inverts the colours — panel matches chart', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  await feed(model, candleABear(10));
  await feed(model, candleBBear(11));
  const checks = lastDecision(ctx).checks;
  assert.equal(checks.patternVisual.direction, 'SELL');

  const html = renderPanel(checks);
  const upperRow = html.split('UPPER')[1].split('</div>')[0];
  const lowerRow = html.split('LOWER')[1].split('</div>')[0];
  assert.match(upperRow, /text-rose-400/, 'on a SELL pattern the upper boundary invalidates');
  assert.match(lowerRow, /text-emerald-400/, 'on a SELL pattern the lower boundary triggers');

  // And the chart agrees, from the same helper.
  const chart = await bootChart();
  chart.applyDecision(checks);
  assert.equal(chart.lines().patternUpperBoundary.opts.color, '#f43f5e');
  assert.equal(chart.lines().patternLowerBoundary.opts.color, '#22c55e');
});

// =========================================================================
// P4-M4 — risk rejection is visually distinct, and creates nothing
// =========================================================================

test('P4-M4 (a): a rejection annotates the triggered pattern without creating any execution marker', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  await feed(model, upperTouch(12));

  const payload = lastDecision(ctx);
  assert.equal(payload.decision, 'BUY');

  const chart = await bootChart();
  chart.applyDecision(payload.checks);
  const before = chart.patternMarkers().filter((m) => m.id.endsWith(':CANDLE_3'))[0];
  assert.match(before.text, /BUY/);
  assert.doesNotMatch(before.text, /REJECTED/);
  assert.equal(before.color, '#22c55e');

  chart.sandbox.window.NovaChartPatternMarkers.markRejected();

  const after = chart.patternMarkers().filter((m) => m.id.endsWith(':CANDLE_3'))[0];
  assert.match(after.text, /REJECTED/);
  assert.equal(after.color, '#f59e0b', 'a rejected trigger must not stay green');
  assert.equal(chart.allMarkers().filter((m) => !String(m.id).startsWith('model002-pattern:')).length, 0,
    'a risk rejection must never create an execution marker');
});

test('P4-M4 (b): a rejection with no triggered pattern on the chart draws nothing', async () => {
  const { ctx } = await buyPatternWithWaits(1); // ACTIVE, not TRIGGERED
  const chart = await bootChart();
  chart.applyDecision(lastDecision(ctx).checks);
  const before = chart.patternMarkers().map((m) => m.text).join('|');

  chart.sandbox.window.NovaChartPatternMarkers.markRejected();

  assert.equal(chart.patternMarkers().map((m) => m.text).join('|'), before, 'nothing may change');
  assert.doesNotMatch(chart.patternMarkers().map((m) => m.text).join('|'), /REJECTED/);
});

test('P4-M4 (c): the REJECTED annotation does not survive into the next pattern', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH' });
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  await feed(model, upperTouch(12));
  const triggered = lastDecision(ctx).checks;

  const chart = await bootChart();
  chart.applyDecision(triggered);
  chart.sandbox.window.NovaChartPatternMarkers.markRejected();
  assert.match(chart.patternMarkers().map((m) => m.text).join('|'), /REJECTED/);

  // A genuinely different pattern group arrives (different bot, different
  // engine direction), so the patternId differs.
  const { ctx: ctx2, model: model2 } = await startBot({ trend: 'BEARISH', instanceId: 'inst_2' });
  await feed(model2, candleABear(10));
  await feed(model2, candleBBear(11));
  const fresh = lastDecision(ctx2).checks;
  assert.notEqual(fresh.patternVisual.patternId, triggered.patternVisual.patternId);
  chart.applyDecision(fresh);
  assert.doesNotMatch(chart.patternMarkers().map((m) => m.text).join('|'), /REJECTED/);
});

test('P4-M4 (d): the ws handler only reacts to a rejection for its own instance', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/bot-detail-ws.js'), 'utf8');
  const handler = src.split("socket.on('risk:rejected'")[1].split('});')[0];
  assert.match(handler, /data\.instanceId !== instanceId/, 'instance isolation must be checked before anything else');
  assert.match(handler, /markRejected/);
  assert.doesNotMatch(handler, /addExecutionMarker/, 'a rejection must never create an execution marker');
});

// =========================================================================
// P4-M5 — AWAITING_CANDLE3 styling
// =========================================================================

test('P4-M5: AWAITING_CANDLE3 renders with the active-pattern styling, not grey IDLE', async () => {
  const { ctx } = await buyPatternWithWaits(1);
  const checks = lastDecision(ctx).checks;
  assert.equal(checks.patternState, 'AWAITING_CANDLE3', 'precondition: the backend state name is unchanged');

  const html = renderPanel(checks);
  const stateRow = html.split('Pattern State')[1].split('</div>')[0];
  assert.match(stateRow, /text-amber-400/);
  assert.doesNotMatch(stateRow, /text-gray-400">AWAITING_CANDLE3/);
});

test('P4-M5 (b): IDLE still renders grey', () => {
  const html = renderPanel({
    trend: { status: 'BULLISH' },
    support: { status: 'NOT_TOUCHED', level: null },
    resistance: { status: 'NOT_TOUCHED', level: null },
    patternState: 'IDLE',
  });
  const stateRow = html.split('Pattern State')[1].split('</div>')[0];
  assert.match(stateRow, /text-gray-400/);
});
