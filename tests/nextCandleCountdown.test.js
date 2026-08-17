'use strict';

/**
 * NEXT CANDLE TIMING — unit tests for the single authoritative countdown
 * calculation (public/js/next-candle-countdown.js) plus wiring assertions
 * on the Bot Detail view / market routes.
 *
 * Dependency-free on purpose (node:test + node:assert only), so it runs in
 * the same `npm test` sweep without a DB or network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const NC = require('../public/js/next-candle-countdown.js');

const M = 60 * 1000;
const at = (iso) => Date.parse(iso);

// ===========================================================
// Timeframe parsing — nothing hardcoded to 60 seconds
// ===========================================================

test('parseTimeframeMs handles supported and future timeframes', () => {
  assert.equal(NC.parseTimeframeMs('1m'), M);
  assert.equal(NC.parseTimeframeMs('3m'), 3 * M);
  assert.equal(NC.parseTimeframeMs('5m'), 5 * M);
  assert.equal(NC.parseTimeframeMs('15m'), 15 * M);
  assert.equal(NC.parseTimeframeMs('1h'), 60 * M);
  assert.equal(NC.parseTimeframeMs('1d'), 24 * 60 * M);
});

test('parseTimeframeMs returns null (never throws) for invalid/missing timeframe', () => {
  for (const bad of ['', '0m', 'abc', '1w', null, undefined, 5, {}]) {
    assert.equal(NC.parseTimeframeMs(bad), null);
  }
});

// ===========================================================
// Test 1 — 1m boundaries
// ===========================================================

test('Test 1 (1m): boundary + countdown match the 1-minute candle bucket', () => {
  const now = at('2026-08-17T13:14:23.000Z');
  assert.equal(NC.currentBoundary(now, M), at('2026-08-17T13:14:00.000Z'));
  assert.equal(NC.nextBoundary(now, M), at('2026-08-17T13:15:00.000Z'));
  assert.equal(NC.countdownText(now, '1m'), '00:37');
});

test('Test 1 (1m): counts down 00:59 -> 00:00 without ever going negative', () => {
  const base = at('2026-08-17T13:14:00.000Z');
  assert.equal(NC.countdownText(base, '1m'), '01:00');          // exactly on the open
  assert.equal(NC.countdownText(base + 1000, '1m'), '00:59');
  assert.equal(NC.countdownText(base + 59 * 1000, '1m'), '00:01');
  assert.equal(NC.countdownText(base + 59999, '1m'), '00:00');  // last ms of the candle
  assert.equal(NC.formatRemaining(-5000), '00:00');             // clamped, never negative
});

// ===========================================================
// Test 2 — 3m boundaries
// ===========================================================

test('Test 2 (3m): 13:14:23 -> next candle 13:15:00, countdown 02:37 measured from 13:12:00', () => {
  const now = at('2026-08-17T13:14:23.000Z');
  assert.equal(NC.currentBoundary(now, 3 * M), at('2026-08-17T13:12:00.000Z'));
  assert.equal(NC.nextBoundary(now, 3 * M), at('2026-08-17T13:15:00.000Z'));
  assert.equal(NC.countdownText(now, '3m'), '00:37');
  // and from the start of the 3m bucket, the full 3 minutes remain:
  assert.equal(NC.countdownText(at('2026-08-17T13:12:23.000Z'), '3m'), '02:37');
});

test('Test 2 (3m): the same wall time yields DIFFERENT values per timeframe', () => {
  const now = at('2026-08-17T13:12:23.000Z');
  assert.equal(NC.countdownText(now, '1m'), '00:37');
  assert.equal(NC.countdownText(now, '3m'), '02:37');
});

// ===========================================================
// Test 6 — candle transition resets from the NEW boundary
// ===========================================================

test('Test 6: at the candle close the countdown resets from the new boundary, not a rolling timer', () => {
  const close = at('2026-08-17T13:15:00.000Z');
  assert.equal(NC.countdownText(close - 1, '1m'), '00:00');
  assert.equal(NC.countdownText(close, '1m'), '01:00');
  assert.equal(NC.countdownText(close + 1000, '1m'), '00:59');
});

// ===========================================================
// Fallback handling
// ===========================================================

test('invalid/missing timeframe renders --:-- instead of throwing', () => {
  assert.equal(NC.countdownText(Date.now(), ''), '--:--');
  assert.equal(NC.countdownText(Date.now(), undefined), '--:--');
  assert.equal(NC.countdownText(Date.now(), 'nonsense'), '--:--');
});

test('unknown time (clock never synchronised) renders --:--', () => {
  const clock = NC.createClock(() => 1000);
  assert.equal(clock.synced, false);
  assert.equal(NC.countdownText(clock.now(), '1m'), '--:--');
});

// ===========================================================
// Test 4 — independence from a wrong browser clock
// ===========================================================

test('Test 4: a badly skewed local clock does not affect the countdown', () => {
  const serverNow = at('2026-08-17T13:14:23.000Z');
  const skewedLocal = serverNow + 47 * 60 * 1000; // browser is 47 minutes fast
  let local = skewedLocal;
  const clock = NC.createClock(() => local);

  clock.apply(serverNow, 0);
  assert.equal(NC.countdownText(clock.now(), '1m'), '00:37');

  local += 10 * 1000; // ten seconds of real elapsed time
  assert.equal(NC.countdownText(clock.now(), '1m'), '00:27');
});

test('HTTP round-trip latency is compensated by half the RTT', () => {
  let local = 1_000_000;
  const clock = NC.createClock(() => local);
  clock.apply(5_000_000, 400); // server said 5,000,000 with a 400ms round trip
  assert.equal(clock.now(), 5_000_200);
});

test('a socket exchange timestamp re-synchronises the same single clock', () => {
  let local = 0;
  const clock = NC.createClock(() => local);
  clock.apply(at('2026-08-17T13:14:00.000Z'), 0);
  local += 1000;
  // Delta ticker timestamp arrives (market:price) — 2s ahead of our estimate
  clock.apply(at('2026-08-17T13:14:03.000Z'), 0);
  assert.equal(NC.countdownText(clock.now(), '1m'), '00:57');
});

test('non-numeric authoritative timestamps are ignored (last valid offset kept)', () => {
  let local = 0;
  const clock = NC.createClock(() => local);
  clock.apply(at('2026-08-17T13:14:23.000Z'), 0);
  const before = clock.now();
  assert.equal(clock.apply('not-a-time', 0), false);
  assert.equal(clock.apply(NaN, 0), false);
  assert.equal(clock.apply(0, 0), false);
  assert.equal(clock.now(), before);
});

// ===========================================================
// Test 5 / Test 3 / Test 8 — wiring in the view + route
// ===========================================================

const view = fs.readFileSync(
  path.join(__dirname, '..', 'views', 'bot-detail.ejs'), 'utf8');

test('Test 5: chart card and right-panel metric are rendered by ONE init with both element ids', () => {
  assert.match(view, /id="chart-next-candle"/);
  assert.match(view, /id="stat-next-candle"/);
  assert.match(view, /elementIds:\s*\['stat-next-candle',\s*'chart-next-candle'\]/);
});

test('Tests 3/8: countdown is driven by the bot\'s own configured timeframe and instance', () => {
  // (the countdown follows the bot's ACTIVE analysis timeframe — identical
  // to BOT_CONFIG.timeframe unless the one-time opposite-market switch fired)
  assert.match(view, /timeframe:\s*window\.BOT_CONFIG && \(window\.BOT_CONFIG\.activeTimeframe \|\| window\.BOT_CONFIG\.timeframe\)/);
  assert.match(view, /instanceId:\s*window\.BOT_CONFIG && window\.BOT_CONFIG\.instanceId/);
});

test('no duplicate countdown timer or local-clock calculation remains in the view', () => {
  assert.doesNotMatch(view, /NEXT_CANDLE_TIMEFRAMES_MS/);
  assert.doesNotMatch(view, /setInterval\(renderNextCandleCountdown/);
});

test('the shared socket is reused — no second Socket.IO connection for the countdown', () => {
  assert.match(view, /socket:\s*window\.NovaBotSocket/);
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'next-candle-countdown.js'), 'utf8');
  assert.doesNotMatch(src, /\bio\(\)/);
});

test('CURRENT PRICE metric is still present on the dashboard', () => {
  assert.match(view, /id="market-price"/);
});

test('GET /api/market/time is registered and does no DB / provider work', () => {
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'marketRoutes.js'), 'utf8');
  assert.match(routes, /router\.get\('\/time', marketController\.getServerTime\)/);

  // Asserted at source level rather than by require()-ing the controller,
  // because that module pulls in config/env + the market-data provider
  // (dotenv/mongoose), which this dependency-free suite deliberately avoids.
  const controller = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'marketController.js'), 'utf8');
  const handler = controller.slice(controller.indexOf('function getServerTime'));
  const body = handler.slice(0, handler.indexOf('\n}') + 2);
  assert.match(body, /success\(res, \{ serverTime: Date\.now\(\) \}\)/);
  assert.doesNotMatch(body, /await|provider|Candle|find|axios|fetch/);
  assert.match(controller, /module\.exports = \{[^}]*getServerTime/);
});

test('the on-chart price label is hidden only on the Bot Detail chart instance', () => {
  const botChart = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'bot-detail-chart.js'), 'utf8');
  assert.match(botChart, /lastValueVisible: false/);
  // the shared series module (also used by the terminal page) is untouched
  const shared = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'candle-series.js'), 'utf8');
  assert.doesNotMatch(shared, /lastValueVisible/);
});

test('the countdown controller tears down its interval and listeners on destroy', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'next-candle-countdown.js'), 'utf8');
  assert.match(src, /clearInterval\(tickTimer\)/);
  assert.match(src, /clearTimeout\(syncTimer\)/);
  assert.match(src, /socket\.off\('market:price', onPrice\)/);
  assert.match(src, /removeEventListener\('visibilitychange', onVisibility\)/);
  // exactly one recurring 1s interval for the countdown
  assert.equal((src.match(/setInterval\(/g) || []).length, 1);
  assert.match(view, /pagehide[\s\S]{0,80}NovaNextCandle\.destroy\(\)/);
});

// ===========================================================
// Chart PRICE-AXIS LABEL: one label, price + countdown, no labels/icon
// ===========================================================

test('the chart label shows ONLY the price and the countdown — no descriptive text, no icon', () => {
  const card = view.slice(
    view.indexOf('id="chart-price-label"'),
    view.indexOf('id="chart-next-candle">') + 200);
  assert.match(card, /id="chart-current-price"/);
  assert.match(card, /id="chart-next-candle"/);
  for (const label of [/Next candle in/i, /Current price/i, /\bPRICE\b/]) {
    assert.doesNotMatch(card, label);
  }
  assert.doesNotMatch(card, /data-lucide/);
});

test('the old floating card is gone — exactly one chart-level price/countdown visual', () => {
  assert.doesNotMatch(view, /chart-next-candle-card/);
  assert.equal((view.match(/id="chart-current-price"/g) || []).length, 1);
  assert.equal((view.match(/id="chart-next-candle"/g) || []).length, 1);
  assert.equal((view.match(/id="chart-price-label"/g) || []).length, 1);
});

test('label price is larger than the label countdown', () => {
  assert.match(view, /class="text-xs font-bold font-mono text-white" id="chart-current-price"/);
  assert.match(view, /class="text-\[10px\] font-semibold font-mono text-emerald-400" id="chart-next-candle"/);
});

test('label is pinned to the right price axis and never uses a hardcoded Y', () => {
  const card = view.slice(view.indexOf('id="chart-price-label"'), view.indexOf('id="chart-current-price"'));
  assert.match(card, /absolute right-0/);
  assert.match(card, /pointer-events-none/);
  assert.doesNotMatch(card, /top-1\/2|top-\[\d/);   // no fixed vertical position in markup

  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'chart-price-label.js'), 'utf8');
  assert.match(src, /priceToCoordinate\(lastPrice\)/); // Y derived from the price
  assert.doesNotMatch(src, /top:\s*['"`]?50%/);
});

test('label price is fed by the EXISTING market:price handler (no new socket/poll/timer)', () => {
  const ws = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'bot-detail-ws.js'), 'utf8');
  const handler = ws.slice(ws.indexOf("socket.on('market:price'"));
  const body = handler.slice(0, handler.indexOf('});'));
  assert.match(body, /NovaChartPriceLabel\.setPrice\(price\)/);
  assert.match(body, /getElementById\('market-price'\)/); // dashboard metric still updated here
  assert.doesNotMatch(ws, /\bio\(\)/);
  assert.doesNotMatch(ws, /chart-next-candle'/);           // countdown text stays NovaNextCandle's

  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'chart-price-label.js'), 'utf8');
  assert.doesNotMatch(src, /setInterval|\bio\(\)|socket\.on/); // no timer, no socket of its own
  assert.match(src, /unsubscribeVisibleLogicalRangeChange/);      // and it cleans up
});

test('label repositions on pan/zoom, on resize, and after a live candle rescales the axis', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'chart-price-label.js'), 'utf8');
  assert.match(src, /subscribeVisibleLogicalRangeChange\(onRangeChange\)/);
  assert.match(src, /new ResizeObserver\(\(\) => position\(\)\)/);

  const chartJs = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'bot-detail-chart.js'), 'utf8');
  assert.match(chartJs, /onLiveCandle\(candle\);[\s\S]{0,200}NovaChartPriceLabel\.position\(\)/);
  assert.match(chartJs, /NovaChartPriceLabel\.attach\(/);
});

// --- Y-coordinate maths (pure) ---------------------------------------

const priceLabel = require('../public/js/chart-price-label.js');

test('Y position comes from the price coordinate, and moves with the price', () => {
  // higher price -> smaller Y (further up the chart), exactly as the chart maps it
  assert.equal(priceLabel.clampCoordinate(300, 460, 40), 300);
  assert.equal(priceLabel.clampCoordinate(120, 460, 40), 120);
  assert.equal(priceLabel.clampCoordinate(null, 460, 40), null);   // off-scale -> hidden
  assert.equal(priceLabel.clampCoordinate(NaN, 460, 40), null);
});

test('label is clamped, never clipped, at the very top and bottom of the chart', () => {
  const H = 460;
  const LH = 40;
  assert.equal(priceLabel.clampCoordinate(0, H, LH), LH / 2 + priceLabel.EDGE_PADDING);   // price at the top
  assert.equal(priceLabel.clampCoordinate(H, H, LH), H - LH / 2 - priceLabel.EDGE_PADDING); // at the bottom
  assert.equal(priceLabel.clampCoordinate(-50, H, LH), LH / 2 + priceLabel.EDGE_PADDING);
  assert.equal(priceLabel.clampCoordinate(H + 80, H, LH), H - LH / 2 - priceLabel.EDGE_PADDING);
  // a chart shorter than the label still yields a visible, finite position
  assert.equal(priceLabel.clampCoordinate(5, 20, 60), 10);
});

test('a smaller chart recomputes a different clamped position for the same price', () => {
  assert.equal(priceLabel.clampCoordinate(450, 460, 40), 438);
  assert.equal(priceLabel.clampCoordinate(450, 200, 40), 178); // after resize
});

test('price formatting follows the existing grouped convention, no invented precision', () => {
  assert.equal(priceLabel.formatPrice(63636.5), '63,636.5');
  assert.equal(priceLabel.formatPrice(63497), '63,497.0');
  assert.equal(priceLabel.formatPrice(Number.NaN), '--');
});

test('right-side dashboard metrics are unchanged (CURRENT PRICE + NEXT CANDLE cards still present)', () => {
  assert.match(view, /Current Price<\/div>\s*\n\s*<div[^>]*id="market-price"/);
  assert.match(view, /Next Candle<\/div>\s*\n\s*<div[^>]*id="stat-next-candle"/);
});

// ===========================================================
// BEHAVIOURAL: real client scripts loaded in a VM with a fake DOM,
// fake shared socket and fake clock — verifies live price updates,
// one-per-second countdown ticks, and chart/right-panel sync.
// ===========================================================

const vm = require('node:vm');

function makeElement(id, doc) {
  return { id, textContent: '', className: '', innerHTML: '', children: [],
    style: {}, offsetHeight: 40, clientHeight: 460,
    classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    get firstChild() { return this.children[0] || null; },
    querySelector(sel) { return doc && sel && sel.startsWith('#') ? doc.getElementById(sel.slice(1)) : null; } };
}

function loadOverlayScripts({ timeframe = '1m', pair = 'BTCUSD', serverNow }) {
  const elements = {};
  const doc = {}; // forward reference so elements can resolve querySelector('#id')
  Object.assign(doc, {
    hidden: false,
    addEventListener(evt, cb) { if (evt === 'DOMContentLoaded') cb(); },
    removeEventListener() {},
    getElementById(id) { return (elements[id] = elements[id] || makeElement(id, doc)); },
    createElement() { return makeElement(null, doc); },
  });
  const socketHandlers = {};
  const socket = {
    on(e, cb) { (socketHandlers[e] = socketHandlers[e] || []).push(cb); },
    off() {},
    fire(e, d) { (socketHandlers[e] || []).forEach((cb) => cb(d)); },
  };

  const intervals = [];
  let localClock = 1_000_000_000_000; // deliberately WRONG browser clock

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: undefined, // server-time endpoint unavailable -> exercises the fallback path
    ResizeObserver: function (cb) { this.observe = () => {}; this.disconnect = () => {}; this._cb = cb; },
    document: doc,
    window: {
      BOT_CONFIG: { instanceId: 'inst_1', modelId: 'MODEL_002', pair, timeframe },
      NovaBotSocket: socket,
      addEventListener() {},
      lucide: null,
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = doc;
  vm.createContext(sandbox);

  for (const f of ['public/js/next-candle-countdown.js', 'public/js/chart-price-label.js', 'public/js/bot-detail-ws.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }

  // Intervals registered by bot-detail-ws.js itself (unrelated staleness
  // refreshers) are out of scope here — only the countdown's own timer,
  // registered by the init() below, is driven by tick().
  const baseline = intervals.length;

  // Minimal stand-in for the real Lightweight Charts objects: the label
  // module is exercised through the SAME priceToCoordinate() contract the
  // installed v4.1.3 chart provides.
  const labelPrices = [];
  const rangeHandlers = [];
  const fakeChartManager = {
    chart: {
      timeScale: () => ({
        subscribeVisibleLogicalRangeChange: (cb) => rangeHandlers.push(cb),
        unsubscribeVisibleLogicalRangeChange: () => {},
      }),
    },
    candleSeries: {
      candlestickSeries: {
        priceToCoordinate: (price) => { labelPrices.push(price); return 460 - (price % 460); },
      },
    },
  };
  sandbox.window.NovaChartPriceLabel.attach({
    chartManager: fakeChartManager,
    container: doc.getElementById('bot-chart-container'),
    label: doc.getElementById('chart-price-label'),
  });

  const controller = sandbox.window.NovaNextCandle.init({
    timeframe, symbol: pair, instanceId: 'inst_1', socket,
    elementIds: ['stat-next-candle', 'chart-next-candle'],
    now: () => localClock,
  });

  return {
    el: (id) => doc.getElementById(id).textContent,
    fire: (e, d) => socket.fire(e, d),
    tick(seconds) { localClock += seconds * 1000; intervals.slice(baseline).forEach((i) => i.fn()); },
    intervalCount: () => intervals.length - baseline,
    intervalMs: () => intervals.slice(baseline).map((i) => i.ms),
    labelPrices: () => labelPrices,
    labelTop: () => doc.getElementById('chart-price-label').style.top,
    labelHidden: () => doc.getElementById('chart-price-label').classList.contains('hidden'),
    fireRangeChange() { rangeHandlers.forEach((cb) => cb()); },
    controller,
  };
}

test('BEHAVIOUR: live Delta price reaches the chart label AND the dashboard metric', () => {
  const app = loadOverlayScripts({ timeframe: '1m' });

  app.fire('market:price', { symbol: 'BTCUSD', price: 63636.5, timestamp: at('2026-08-17T13:14:14.000Z') });
  assert.equal(app.el('chart-current-price'), '63,636.5'); // via NovaChartPriceLabel.setPrice
  assert.equal(app.el('market-price'), '$63636.50');       // dashboard metric unchanged
  assert.equal(app.labelPrices().length, 1);

  app.fire('market:price', { symbol: 'BTCUSD', price: 63510.9, timestamp: at('2026-08-17T13:14:15.000Z') });
  assert.equal(app.el('chart-current-price'), '63,510.9');

  // another symbol must never write into this bot's label
  app.fire('market:price', { symbol: 'ETHUSD', price: 2500, timestamp: at('2026-08-17T13:14:16.000Z') });
  assert.equal(app.el('chart-current-price'), '63,510.9');
  assert.equal(app.labelPrices().length, 2);
});

test('BEHAVIOUR: countdown ticks once per second and chart == right panel at every step', () => {
  const app = loadOverlayScripts({ timeframe: '1m' });
  // exchange time arrives on the existing market:price event (fetch is unavailable here)
  app.fire('market:price', { symbol: 'BTCUSD', price: 63497, timestamp: at('2026-08-17T13:14:14.000Z') });

  assert.equal(app.el('chart-next-candle'), '00:46');
  assert.equal(app.el('stat-next-candle'), '00:46');

  const seen = [];
  for (let i = 0; i < 5; i++) {
    app.tick(1);
    assert.equal(app.el('chart-next-candle'), app.el('stat-next-candle'), 'chart and right panel must stay synchronized');
    seen.push(app.el('chart-next-candle'));
  }
  assert.deepEqual(seen, ['00:45', '00:44', '00:43', '00:42', '00:41']);
});

test('BEHAVIOUR: exactly one 1s interval drives both values, and it survives candle rollover', () => {
  const app = loadOverlayScripts({ timeframe: '1m' });
  app.fire('market:price', { symbol: 'BTCUSD', price: 63497, timestamp: at('2026-08-17T13:14:58.400Z') });
  assert.deepEqual(app.intervalMs(), [1000]);   // ONE timer, 1 second
  assert.equal(app.el('chart-next-candle'), '00:01');
  app.tick(1); assert.equal(app.el('chart-next-candle'), '00:00'); // final second of the candle
  app.tick(1); assert.equal(app.el('chart-next-candle'), '00:59'); // new candle, reset from the new boundary
  assert.equal(app.el('stat-next-candle'), '00:59');
  assert.deepEqual(app.intervalMs(), [1000]);   // still ONE timer
});

test('BEHAVIOUR: 3m bot gets 3m boundaries from the same single calculation', () => {
  const app = loadOverlayScripts({ timeframe: '3m' });
  app.fire('market:price', { symbol: 'BTCUSD', price: 63497, timestamp: at('2026-08-17T13:12:14.000Z') });
  assert.equal(app.el('chart-next-candle'), '02:46');
  assert.equal(app.el('stat-next-candle'), '02:46');
});

test('BEHAVIOUR: the label follows the price — Y is recomputed from priceToCoordinate on every tick', () => {
  const app = loadOverlayScripts({ timeframe: '1m' });

  app.fire('market:price', { symbol: 'BTCUSD', price: 63636.5, timestamp: at('2026-08-17T13:14:14.000Z') });
  const firstTop = app.labelTop();
  assert.match(firstTop, /^-?\d+(\.\d+)?px$/);
  assert.equal(app.labelHidden(), false, 'label becomes visible once a real price arrives');

  app.fire('market:price', { symbol: 'BTCUSD', price: 63200.0, timestamp: at('2026-08-17T13:14:15.000Z') });
  assert.notEqual(app.labelTop(), firstTop, 'a different price must yield a different Y');

  // pan/zoom re-derives the position from the SAME price (no new tick needed)
  const before = app.labelPrices().length;
  app.fireRangeChange();
  assert.equal(app.labelPrices().length, before + 1);
  assert.equal(app.labelPrices()[before], 63200.0);
});

test('BEHAVIOUR: label countdown and dashboard #stat-next-candle stay identical', () => {
  const app = loadOverlayScripts({ timeframe: '1m' });
  app.fire('market:price', { symbol: 'BTCUSD', price: 63636.5, timestamp: at('2026-08-17T13:14:14.000Z') });

  for (let i = 0; i < 4; i++) {
    app.tick(1);
    assert.equal(app.el('chart-next-candle'), app.el('stat-next-candle'));
  }
  assert.equal(app.el('chart-next-candle'), '00:42');
  assert.deepEqual(app.intervalMs(), [1000]); // still exactly one timer
});
