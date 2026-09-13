'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const recordingSrc = fs.readFileSync(path.join(root, 'services', 'recording', 'RecordingService.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'services', 'recording', 'SvgChartRenderer.js'), 'utf8');

const SvgChartRenderer = require(path.join(root, 'services', 'recording', 'SvgChartRenderer'));
const { renderChartFrame, getBoundaryLabels, getBoundaryRoles, wrapText, buildGeometry } = SvgChartRenderer;

function makeSession(overrides = {}) {
  const candleMap = new Map();
  (overrides.candles || []).forEach((c) => candleMap.set(String(c.timestamp), c));
  return Object.assign({
    symbol: 'BTCUSD',
    timeframe: '1m',
    startedAt: Date.now() - 5000,
    direction: 'BUY',
    currentPrice: 63500,
    support: [63000],
    resistance: [64000],
    level: { side: 'SUPPORT', index: 1, price: 63000 },
    trend: 'BULLISH',
    decision: { decision: 'BUY', reason: 'S1 touched' },
    currentCandle: null,
  }, overrides, { candles: candleMap });
}

function makeCandles(n, startMs) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = startMs + i * 60000;
    const base = 63000 + Math.sin(i / 4) * 300;
    out.push({ timestamp: t, open: base, high: base + 60, low: base - 60, close: base + (i % 2 ? 20 : -20) });
  }
  return out;
}

// ---------------------------------------------------------------------
// No browser / no Chrome anywhere in the recording path.
// ---------------------------------------------------------------------

test('recording path has no Chrome/Chromium/Puppeteer/Playwright/DevTools references', () => {
  const forbidden = [
    /puppeteer/i, /playwright/i, /chromium/i, /chrome_path/i, /chromium_path/i,
    /remote-debugging-port/i, /Runtime\.evaluate/, /DevTools/, /findBrowser/,
    /browser\s*websocket/i, /page\s*screenshot/i, /browser\s*screenshot/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(recordingSrc, pattern, `RecordingService.js must not reference ${pattern}`);
    assert.doesNotMatch(rendererSrc, pattern, `SvgChartRenderer.js must not reference ${pattern}`);
  }
  assert.doesNotMatch(recordingSrc, /require\(['"]puppeteer['"]\)/);
  assert.doesNotMatch(recordingSrc, /require\(['"]playwright['"]\)/);
});

test('LiveChartRenderer and its browser client bridge no longer exist', () => {
  assert.equal(fs.existsSync(path.join(root, 'services', 'recording', 'LiveChartRenderer.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'services', 'recording', 'live-chart-renderer-client.js')), false);
});

test('RecordingService uses SvgChartRenderer, not a browser-based renderer', () => {
  assert.match(recordingSrc, /require\(['"]\.\/SvgChartRenderer['"]\)/);
  assert.doesNotMatch(recordingSrc, /LiveChartRenderer/);
});

test('package.json depends on sharp and not on puppeteer/playwright', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.sharp, 'sharp must be a dependency');
  assert.equal(pkg.dependencies.puppeteer, undefined);
  assert.equal(pkg.dependencies.playwright, undefined);
  assert.equal(pkg.dependencies.chromium, undefined);
});

// ---------------------------------------------------------------------
// Frame generation is deterministic and always complete.
// ---------------------------------------------------------------------

test('renderChartFrame produces one complete, well-formed SVG document', () => {
  const state = {
    symbol: 'BTCUSD', timeframe: '1m', startedAt: Date.now(), direction: 'BUY',
    currentPrice: 63500, support: [63000], resistance: [64000],
    level: { side: 'SUPPORT', index: 1, price: 63000 }, trend: 'BULLISH',
    decision: { decision: 'BUY', reason: 'S1 touched' },
    candles: makeCandles(30, Date.now() - 30 * 60000).map((c) => ({ time: c.timestamp / 1000, open: c.open, high: c.high, low: c.low, close: c.close })),
  };
  const svg = renderChartFrame(state);
  assert.match(svg, /^<svg viewBox="0 0 1380 720" width="1380" height="720"/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /NOVA TRADE/);
  assert.match(svg, /BOT DECISION ENGINE/);
  // one rect per candle body at minimum
  const rectCount = (svg.match(/<rect/g) || []).length;
  assert.ok(rectCount >= 30, 'expected at least one <rect> per candle body');
});

test('renderChartFrame never produces a blank/partial frame when there are no candles yet', () => {
  const state = {
    symbol: 'BTCUSD', timeframe: '1m', startedAt: Date.now(), direction: 'MANUAL',
    currentPrice: null, support: [], resistance: [], level: null, trend: '',
    decision: { decision: 'TOUCHED', reason: 'Manual recording started' },
    candles: [],
  };
  const svg = renderChartFrame(state);
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /Waiting for candle data/);
});

test('SvgChartRenderer.update() keeps the last known-good candle state instead of blanking a frame', async () => {
  const renderer = new SvgChartRenderer();
  const withCandles = makeSession({ candles: makeCandles(10, Date.now() - 10 * 60000) });
  await renderer.start(withCandles);
  await renderer.update(withCandles);
  assert.ok(renderer.state.candles.length > 0);

  // Simulate a temporary data outage: session.candles is momentarily empty.
  const noCandles = makeSession({ candles: [] });
  await renderer.update(noCandles);
  assert.ok(renderer.state.candles.length > 0, 'renderer must not drop to zero candles on a transient gap');
});

test('SvgChartRenderer.screenshot() rasterizes a real PNG file for every frame', async () => {
  const renderer = new SvgChartRenderer();
  const session = makeSession({ candles: makeCandles(20, Date.now() - 20 * 60000) });
  await renderer.start(session);
  await renderer.update(session);
  const file = path.join(require('node:os').tmpdir(), `nova-recording-test-${Date.now()}.png`);
  await renderer.screenshot(file);
  const stat = fs.statSync(file);
  assert.ok(stat.isFile() && stat.size > 0);
  const header = fs.readFileSync(file).slice(0, 8);
  assert.deepEqual([...header], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'file must be a real PNG');
  fs.rmSync(file, { force: true });
  await renderer.stop();
});

// ---------------------------------------------------------------------
// MODEL_002 boundary / pattern visual parity with the live chart.
// ---------------------------------------------------------------------

test('boundary trigger/invalidation roles and labels match the live chart mapping', () => {
  assert.deepEqual(getBoundaryRoles('BUY'), { upper: 'TRIGGER', lower: 'INVALIDATION' });
  assert.deepEqual(getBoundaryRoles('SELL'), { upper: 'INVALIDATION', lower: 'TRIGGER' });
  assert.deepEqual(getBoundaryLabels('BUY'), { upper: 'UPPER (BUY>)', lower: 'LOWER (INVALID<)' });
  assert.deepEqual(getBoundaryLabels('SELL'), { upper: 'UPPER (INVALID>)', lower: 'LOWER (SELL<)' });
});

test('a pattern boundary line is only drawn when it falls within the visible candle price range', () => {
  const candles = makeCandles(30, Date.now() - 30 * 60000).map((c) => ({ time: c.timestamp / 1000, open: c.open, high: c.high, low: c.low, close: c.close }));
  const state = {
    symbol: 'BTCUSD', timeframe: '1m', startedAt: Date.now(), direction: 'BUY',
    currentPrice: 63000, support: [], resistance: [], level: null, trend: '',
    decision: {
      decision: 'WAIT',
      checks: { boundaries: { upper: 999999, lower: 63000 }, patternVisual: { direction: 'BUY', labels: [] } },
    },
    candles,
  };
  const svg = renderChartFrame(state);
  // The out-of-range upper boundary label must never appear.
  assert.doesNotMatch(svg, /UPPER \(BUY>\)/);
});

// ---------------------------------------------------------------------
// Text wrapping / geometry helpers.
// ---------------------------------------------------------------------

test('wrapText always returns at least one line and never silently drops long reasons', () => {
  assert.deepEqual(wrapText('', 20, 3), ['--']);
  const long = 'a '.repeat(200).trim();
  const lines = wrapText(long, 20, 3);
  assert.ok(lines.length <= 3);
  assert.ok(lines.length >= 1);
});

test('buildGeometry degrades gracefully for a single flat candle instead of dividing by zero', () => {
  const geo = buildGeometry([{ time: 1, open: 100, high: 100, low: 100, close: 100 }]);
  assert.ok(Number.isFinite(geo.min) && Number.isFinite(geo.max));
  assert.ok(geo.max > geo.min);
});

// ---------------------------------------------------------------------
// RecordingService: unchanged history-boundary / validation / logging contracts.
// ---------------------------------------------------------------------

test('recording history uses the same instance creation boundary as the live candles API', () => {
  assert.match(recordingSrc, /const candleFilter = \{ symbol: bot\.symbol, timeframe \};/);
  assert.match(recordingSrc, /candleFilter\.timestamp = \{ \$gte: bot\.createdAt\.getTime\(\) \};/);
  assert.match(recordingSrc, /Candle\.find\(candleFilter\)/);
});

test('recording pipeline rejects zero-price OHLC that would destroy autoscale', () => {
  assert.match(recordingSrc, /function validRecordingCandle\(candle\)/);
  assert.match(recordingSrc, /low != null && low > 0/);
  assert.match(recordingSrc, /if \(decision\.candle3 && validRecordingCandle\(decision\.candle3\)/);
});

test('recording state cannot turn null support/resistance values into price 0', () => {
  assert.match(recordingSrc, /function positivePriceArray\(values\)/);
  assert.match(recordingSrc, /filter\(value => value != null && value > 0\)/);
});

test('TradeRecording direction enum accepts MANUAL (no validation-failure regression)', () => {
  const modelSrc = fs.readFileSync(path.join(root, 'models', 'TradeRecording.js'), 'utf8');
  assert.match(modelSrc, /direction:\s*\{\s*type:\s*String,\s*enum:\s*\['BUY',\s*'SELL',\s*'MANUAL'\]/);
});

test('RecordingService logs the required lifecycle and error events without per-frame spam', () => {
  assert.match(recordingSrc, /\[RECORDING\] starting/);
  assert.match(recordingSrc, /\[RECORDING\] rotating/);
  assert.match(recordingSrc, /\[RECORDING\] encoding/);
  assert.match(recordingSrc, /\[RECORDING\] ffmpeg complete/);
  assert.match(recordingSrc, /\[RECORDING\] database record ready/);
  assert.match(recordingSrc, /\[RECORDING\] frame generation failed/);
  assert.match(recordingSrc, /\[RECORDING\] frame rasterization failed/);
  assert.match(recordingSrc, /\[RECORDING\] ffmpeg failed/);
  assert.match(recordingSrc, /\[RECORDING\] database save failed/);
  // No per-frame (every-second) log line.
  assert.doesNotMatch(recordingSrc, /\[RECORDING\] frame generated/);
});

test('RecordingService cleans up temp frame directories on ffmpeg/renderer failure and on stop', () => {
  assert.match(recordingSrc, /fs\.rmSync\(oldDir, \{ recursive: true, force: true \}\)/);
  assert.match(recordingSrc, /fs\.rmSync\(session\.framesDir, \{ recursive: true, force: true \}\)/);
  assert.match(recordingSrc, /fs\.rmSync\(framesDir, \{ recursive: true, force: true \}\)/);
});

test('resolveFfmpeg still resolves ffmpeg-static without requiring a system ffmpeg install', () => {
  assert.match(recordingSrc, /require\('ffmpeg-static'\)/);
});
