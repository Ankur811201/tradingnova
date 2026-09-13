'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'services', 'recording', 'LiveChartRenderer.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'services', 'recording', 'live-chart-renderer-client.js'), 'utf8');
const recording = fs.readFileSync(path.join(root, 'services', 'recording', 'RecordingService.js'), 'utf8');
const liveChart = fs.readFileSync(path.join(root, 'public', 'js', 'bot-detail-chart.js'), 'utf8');

 test('recording renderer loads the production bot-detail chart pipeline', () => {
  assert.match(renderer, /public\/js\/chart-manager\.js/);
  assert.match(renderer, /public\/js\/candle-series\.js/);
  assert.match(renderer, /public\/js\/overlay-manager\.js/);
  assert.match(renderer, /public\/js\/marker-manager\.js/);
  assert.match(renderer, /public\/js\/execution-markers\.js/);
  assert.match(renderer, /public\/js\/chart-price-label\.js/);
  assert.match(renderer, /public\/js\/bot-detail-chart\.js/);
  assert.doesNotMatch(renderer, /svgFrame\s*\(/);
});

test('recording history uses the same instance creation boundary as the live candles API', () => {
  assert.match(recording, /const candleFilter = \{ symbol: bot\.symbol, timeframe \};/);
  assert.match(recording, /candleFilter\.timestamp = \{ \$gte: bot\.createdAt\.getTime\(\) \};/);
  assert.match(recording, /Candle\.find\(candleFilter\)/);
});

test('recording bridge only forwards state into the production chart', () => {
  assert.match(bridge, /window\.NovaBotChartManager/);
  assert.match(bridge, /replaceCandleSnapshot\(candles\)/);
  assert.match(bridge, /scrollToRealTime\(\)/);
  assert.match(bridge, /NovaChartPatternMarkers/);
  assert.match(bridge, /NovaChartPatternOverlay/);
  assert.doesNotMatch(bridge, /createChart\(/);
  assert.doesNotMatch(bridge, /addCandlestickSeries\(/);
});

test('live chart readiness is exposed only after historical initialization settles', () => {
  assert.match(liveChart, /window\.__novaBotChartReady = true;/);
  assert.match(renderer, /window\.__novaBotChartReady === true/);
});

test('recording pipeline rejects zero-price OHLC that would destroy autoscale', () => {
  assert.match(recording, /function validRecordingCandle\(candle\)/);
  assert.match(recording, /low != null && low > 0/);
  assert.match(recording, /if \(decision\.candle3 && validRecordingCandle\(decision\.candle3\)/);
  assert.match(renderer, /\.filter\(c => \{/);
  assert.match(renderer, /low > 0 && close > 0/);
});


test('recording bridge replaces the complete candle snapshot instead of updating only the last candle', () => {
  assert.match(bridge, /The recording state is authoritative/);
  assert.match(bridge, /chart\.replaceCandleSnapshot\(candles\)/);
  assert.match(bridge, /series\.setData\(candles\.map/);
  assert.match(bridge, /replaceCandleSnapshot\(candles\)/);
  const chartManager = fs.readFileSync(path.join(root, 'public', 'js', 'chart-manager.js'), 'utf8');
  assert.match(chartManager, /replaceCandleSnapshot\(candles\)/);
});

test('recording viewport is 100px wider and keeps a right candle gap', () => {
  assert.match(renderer, /width: 1380px; height: 720px/);
  assert.match(renderer, /#chart-panel[^}]*width: 830px/);
  assert.match(renderer, /#side[^}]*left: 863px/);
  assert.match(renderer, /width: 1380, height: 720/);
  const chartManager = fs.readFileSync(path.join(root, 'public', 'js', 'chart-manager.js'), 'utf8');
  assert.match(chartManager, /rightOffset: 3/);
});

test('recording state cannot turn null support/resistance values into price 0', () => {
  assert.match(recording, /function positivePriceArray\(values\)/);
  assert.match(recording, /filter\(value => value != null && value > 0\)/);
  assert.match(recording, /function positivePriceArray\(values\)/);
  assert.match(renderer, /support: \(Array\.isArray\(session\.support\)/);
  assert.match(renderer, /resistance: \(Array\.isArray\(session\.resistance\)/);
});

test('recording state updates use structured CDP arguments instead of giant Runtime.evaluate expressions', () => {
  assert.match(renderer, /Runtime\.callFunctionOn/);
  assert.match(renderer, /functionDeclaration: 'function\(state\) \{ return this\(state\); \}'/);
  assert.doesNotMatch(renderer, /window\.NovaRecordingUpdate\(\$\{JSON\.stringify/);
});
