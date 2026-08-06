'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compile } = require('./support/miniEjs');

const templatePath = path.join(__dirname, '..', 'views', 'bot-detail.ejs');
const template = fs.readFileSync(templatePath, 'utf8');
const render = compile(template);

function baseBot() {
  return {
    instanceId: 'inst_1', modelId: 'MODEL_001', symbol: 'BTCUSD', name: 'Test Bot',
    status: 'RUNNING', environment: 'PAPER', capitalAllocation: 1000,
    config: { timeframe: '5m' },
    runtime: { status: 'RUNNING', currentPosition: null, thinking: null },
  };
}

test('bot-detail.ejs compiles and renders with no decisions yet (fresh bot)', () => {
  const html = render({
    title: 'Nova Trade | Test',
    bot: baseBot(),
    initialTrades: [],
    initialSignals: [],
    initialDecisions: [],
    initialDecision: null,
  });
  assert.match(html, /No decisions recorded yet/);
  assert.match(html, /window\.BOT_INITIAL_DECISION = null;/);
});

test('bot-detail.ejs renders a real WAIT decision in Decision History and BOT_INITIAL_DECISION', () => {
  const waitEvent = {
    at: new Date('2026-07-29T10:00:00Z'),
    payload: {
      decision: 'WAIT',
      reason: 'no_level_touch',
      checks: {
        trend: { status: 'NEUTRAL', ema50: 64123.45 },
        support: { status: 'NOT_TOUCHED', level: 64024 },
        resistance: { status: 'NOT_TOUCHED', level: 64280 },
        bodyExpansion: { status: 'FAIL', bodySize: 1, prevBodySize: 5 },
        volume: { status: 'UNAVAILABLE', value: null },
        liquiditySweep: { status: 'NONE' },
        cycle3Candle: { status: 'NONE' },
      },
    },
  };

  const html = render({
    title: 'Nova Trade | Test',
    bot: baseBot(),
    initialTrades: [],
    initialSignals: [],
    initialDecisions: [waitEvent],
    initialDecision: waitEvent,
  });

  // Decision History row rendered from StrategyEvent, not Signal.
  assert.match(html, /no_level_touch/);
  // No fake PASS for volume -- must literally say UNAVAILABLE somewhere in
  // the injected initial-decision JSON (the client-side renderer maps this
  // to the visible "UNAVAILABLE" badge -- see model-thinking-registry.js).
  assert.match(html, /"status":"UNAVAILABLE"/);
  assert.doesNotMatch(html, /Volume Confirmation.{0,40}PASS/s);
});

test('bot-detail.ejs renders a real BUY decision payload without legacy mock phrasing', () => {
  const buyEvent = {
    at: new Date('2026-07-29T10:05:00Z'),
    payload: {
      decision: 'BUY',
      reason: '3-Candle Buy Cycle at Support (64024)',
      checks: {
        trend: { status: 'BULLISH', ema50: 64010 },
        support: { status: 'TOUCHED', level: 64024 },
        resistance: { status: 'NOT_TOUCHED', level: 64280 },
        bodyExpansion: { status: 'PASS', bodySize: 8, prevBodySize: 4 },
        volume: { status: 'UNAVAILABLE', value: null },
        liquiditySweep: { status: 'NONE' },
        cycle3Candle: { status: 'BUY' },
      },
    },
  };

  const html = render({
    title: 'Nova Trade | Test',
    bot: baseBot(),
    initialTrades: [],
    initialSignals: [],
    initialDecisions: [buyEvent],
    initialDecision: buyEvent,
  });

  assert.match(html, /3-Candle Buy Cycle at Support/);
  assert.doesNotMatch(html, /Waiting for valid breakout confirmation\./); // legacy mock string must be gone
});

test('bot-detail.ejs renders a real SELL decision payload', () => {
  const sellEvent = {
    at: new Date('2026-07-29T10:10:00Z'),
    payload: {
      decision: 'SELL',
      reason: 'Rejection Sweep at Resistance (64280)',
      checks: {
        trend: { status: 'BEARISH', ema50: 64300 },
        support: { status: 'NOT_TOUCHED', level: 64024 },
        resistance: { status: 'TOUCHED', level: 64280 },
        bodyExpansion: { status: 'PASS', bodySize: 9, prevBodySize: 3 },
        volume: { status: 'UNAVAILABLE', value: null },
        liquiditySweep: { status: 'DETECTED' },
        cycle3Candle: { status: 'NONE' },
      },
    },
  };

  const html = render({
    title: 'Nova Trade | Test',
    bot: baseBot(),
    initialTrades: [],
    initialSignals: [],
    initialDecisions: [sellEvent],
    initialDecision: sellEvent,
  });

  assert.match(html, /Rejection Sweep at Resistance/);
});

test('bot-detail.ejs Decision History never falls back to legacy Signal fields when decisions exist', () => {
  const waitEvent = { at: new Date(), payload: { decision: 'WAIT', reason: 'no_level_touch', checks: null } };
  const html = render({
    title: 'Nova Trade | Test',
    bot: baseBot(),
    initialTrades: [],
    // A legacy Signal record is present too (simulating pre-Part-7 leftover
    // data). It legitimately still feeds the separate, out-of-scope "Live
    // Trade Story" timeline (see IMPORTANT DISTINCTIONS in the Part 8
    // prompt -- that is trade/timeline visualization, not the Decision
    // Engine/Decision History), but must NOT be what Decision History
    // renders.
    initialSignals: [{ type: 'BUY', decision: 'EXECUTE', reason: 'LEGACY MOCK REASON', createdAt: new Date() }],
    initialDecisions: [waitEvent],
    initialDecision: waitEvent,
  });
  const historyMatch = html.match(/id="signal-history-container"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(historyMatch, 'Decision History container must be present in the rendered page');
  assert.doesNotMatch(historyMatch[0], /LEGACY MOCK REASON/);
  assert.match(historyMatch[0], /no_level_touch/);
});
