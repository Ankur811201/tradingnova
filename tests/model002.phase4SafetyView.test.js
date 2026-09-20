'use strict';

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
    bot: { instanceId: 'inst_1', modelId: 'MODEL_002', symbol: 'BTCUSD', name: 'M2 Bot', status: 'RUNNING', environment: 'PAPER', capitalAllocation: 1000, config: { timeframe: '3m' }, parameters: { timeframe: '3m' } },
    initialTrades: [], initialSignals: [], initialDecisions: [], currentPosition: null, performanceData: null,
    initialDecision: { payload: Object.assign({ decision: 'WAIT', reason: 'no_level_touch', layerSafety }, extraPayload) },
  };
}

const normal = { levelLosses: {S1:1,S2:0,S3:2,R1:0,R2:1,R3:0}, successfulTradeCount:0, safetyStatus:'NORMAL' };

test('level safety card renders all six level counters and remains ACTIVE', () => {
  const html = render(args(normal));
  assert.match(html, /id="safety-status-badge"[\s\S]{0,300}ACTIVE/);
  for (const level of ['S1','S2','S3','R1','R2','R3']) assert.match(html, new RegExp(`id=\"layer-safety-${level}\"[^>]*>[0-2]</`));
  assert.match(html, /id="layer-safety-wins"[^>]*>0</);
  assert.doesNotMatch(html, /BOT STOPPED/);
});

test('SUCCESS_STOPPED renders stopped state after the first successful trade', () => {
  const html = render(args({ levelLosses: {S1:2,S2:0,S3:0,R1:0,R2:0,R3:0}, successfulTradeCount:1, safetyStatus:'SUCCESS_STOPPED' }));
  assert.match(html, /SUCCESS_STOPPED/);
  assert.doesNotMatch(html.split('id="safety-status-badge"')[1].split('</span>')[0], /ACTIVE/);
  assert.match(html, /BOT STOPPED — one successful trade has been completed/);
});

test('no decision renders safe zero defaults', () => {
  const html = render(Object.assign(args(null), { initialDecision: null }));
  assert.match(html, /id="safety-status-badge"[\s\S]{0,300}ACTIVE/);
});
