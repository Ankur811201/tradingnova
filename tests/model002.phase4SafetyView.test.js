'use strict';

/**
 * PHASE 4 / P4-H2 — the server-rendered Safety card on views/bot-detail.ejs.
 *
 * Before this fix the badge read only the 3-consecutive-loss tracker, so a
 * bot permanently stopped by the PHASE 2 layer/success rules rendered a
 * green ACTIVE badge on page load. These tests render the REAL template
 * with real-shaped decision payloads (layerSafety = LayerSafety.getState()).
 *
 * Display only: the LayerSafety state machine is not exercised or modified
 * here — see tests/model002.layerSafety.test.js for its behaviour.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compile } = require('./support/miniEjs');

const template = fs.readFileSync(path.join(__dirname, '..', 'views', 'bot-detail.ejs'), 'utf8');
const render = compile(template);

function args(layerSafety, extraPayload = {}) {
  return {
    title: 'Nova Trade | Test',
    bot: {
      instanceId: 'inst_1', modelId: 'MODEL_002', symbol: 'BTCUSD', name: 'M2 Bot',
      status: 'RUNNING', environment: 'PAPER', capitalAllocation: 1000,
      config: { timeframe: '3m' }, parameters: { timeframe: '3m' },
    },
    initialTrades: [], initialSignals: [], initialDecisions: [],
    currentPosition: null, performanceData: null,
    initialDecision: {
      payload: Object.assign({
        decision: 'WAIT', reason: 'no_level_touch',
        consecutiveLosses: 0, safetyLimit: 3, safetyStatus: 'NORMAL',
        layerSafety,
      }, extraPayload),
    },
  };
}

test('P4-H2 view (a): a NORMAL bot renders ACTIVE with its real layer counters', () => {
  const html = render(args({ currentLayer: 2, layerLossCount: 1, successfulTradeCount: 0, safetyStatus: 'NORMAL' }));
  assert.match(html, /id="safety-status-badge"[\s\S]{0,300}ACTIVE/);
  assert.match(html, /id="layer-safety-layer"[^>]*>2</);
  assert.match(html, /id="layer-safety-losses"[^>]*>1</);
  assert.match(html, /id="layer-safety-wins"[^>]*>0</);
  assert.doesNotMatch(html, /BOT STOPPED/);
});

test('P4-H2 view (b): SUCCESS_STOPPED never renders ACTIVE and explains itself', () => {
  const html = render(args({ currentLayer: 1, layerLossCount: 0, successfulTradeCount: 1, safetyStatus: 'SUCCESS_STOPPED' }));
  const badge = html.split('id="safety-status-badge"')[1].split('</span>')[0];
  assert.match(badge, /SUCCESS_STOPPED/);
  assert.doesNotMatch(badge, /ACTIVE/);
  assert.match(badge, /rose/, 'a stopped bot must not render in the green ACTIVE style');
  assert.match(html, /BOT STOPPED — a successful trade has already been recorded/);
  assert.match(html, /id="layer-safety-wins"[^>]*>1</);
});

test('P4-H2 view (c): MAX_LAYER_STOPPED never renders ACTIVE and names the layer limit', () => {
  const html = render(args({ currentLayer: 6, layerLossCount: 2, successfulTradeCount: 0, safetyStatus: 'MAX_LAYER_STOPPED' }));
  const badge = html.split('id="safety-status-badge"')[1].split('</span>')[0];
  assert.match(badge, /MAX_LAYER_STOPPED/);
  assert.doesNotMatch(badge, /ACTIVE/);
  assert.match(html, /BOT STOPPED — maximum layer \(6\) reached/);
  assert.match(html, /id="layer-safety-layer"[^>]*>6</);
});

test('P4-H2 view (d): a layer stop outranks the consecutive-loss badge, and PAUSED still works alone', () => {
  const stopped = render(args(
    { currentLayer: 6, layerLossCount: 2, successfulTradeCount: 0, safetyStatus: 'MAX_LAYER_STOPPED' },
    { safetyStatus: 'PAUSED', consecutiveLosses: 3 }
  ));
  assert.match(stopped.split('id="safety-status-badge"')[1].split('</span>')[0], /MAX_LAYER_STOPPED/);

  const pausedOnly = render(args(
    { currentLayer: 1, layerLossCount: 0, successfulTradeCount: 0, safetyStatus: 'NORMAL' },
    { safetyStatus: 'PAUSED', consecutiveLosses: 3 }
  ));
  assert.match(pausedOnly.split('id="safety-status-badge"')[1].split('</span>')[0], /PAUSED/);
  assert.match(pausedOnly, /SAFETY PAUSED/);
});

test('P4-H2 view (e): a bot with no decision yet renders honest defaults, not fabricated state', () => {
  const noDecision = Object.assign(args(null), { initialDecision: null });
  const html = render(noDecision);
  assert.match(html, /id="safety-status-badge"[\s\S]{0,300}ACTIVE/);
  assert.match(html, /id="layer-safety-layer"[^>]*>1</);
  assert.match(html, /id="layer-safety-losses"[^>]*>0</);
  assert.match(html, /id="layer-safety-wins"[^>]*>0</);
});
