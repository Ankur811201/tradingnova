'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeElement(id) {
  return {
    id,
    _textContent: '',
    _className: '',
    _innerHTML: '',
    children: [],
    get textContent() { return this._textContent; },
    set textContent(v) { this._textContent = v; },
    get className() { return this._className; },
    set className(v) { this._className = v; },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = v; this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child, ref) {
      const idx = ref ? this.children.indexOf(ref) : this.children.length;
      this.children.splice(idx === -1 ? 0 : idx, 0, child);
      return child;
    },
    get firstChild() { return this.children[0] || null; },
    querySelector(sel) {
      if (sel === '.italic') return this.children.find((c) => (c.className || '').includes('italic')) || null;
      return null;
    },
  };
}

function makeFakeDocument() {
  const elements = {};
  const listeners = {};
  return {
    _elements: elements,
    addEventListener(event, cb) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
      if (event === 'DOMContentLoaded') cb(); // fire immediately, like a script loaded at end of body
    },
    getElementById(id) {
      if (!elements[id]) elements[id] = makeElement(id);
      return elements[id];
    },
    createElement(tag) {
      const el = makeElement(null);
      el.tagName = tag;
      return el;
    },
  };
}

function makeFakeSocket() {
  const handlers = {};
  return {
    on(event, cb) {
      handlers[event] = handlers[event] || [];
      handlers[event].push(cb);
    },
    __fire(event, data) {
      (handlers[event] || []).forEach((cb) => cb(data));
    },
    __handlerCount(event) {
      return (handlers[event] || []).length;
    },
  };
}

/** Loads model-thinking-registry.js + bot-detail-ws.js into a fresh VM context. */
function loadClientScripts({ instanceId = 'inst_1', modelId = 'MODEL_001', pair = 'BTCUSD', initialDecision = null } = {}) {
  const doc = makeFakeDocument();
  const socket = makeFakeSocket();

  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    window: {
      BOT_CONFIG: { instanceId, modelId, pair },
      BOT_INITIAL_DECISION: initialDecision,
      NovaBotSocket: socket,
    },
    document: doc,
  };
  sandbox.window.document = doc;
  vm.createContext(sandbox);

  const registrySrc = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'renderers', 'model-thinking-registry.js'), 'utf8'
  );
  const wsSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'bot-detail-ws.js'), 'utf8'
  );

  vm.runInContext(registrySrc, sandbox, { filename: 'model-thinking-registry.js' });
  vm.runInContext(wsSrc, sandbox, { filename: 'bot-detail-ws.js' });

  return { doc, socket, sandbox };
}

test('Client: no initial decision -> Decision Engine shows "no analysis available", not a crash', () => {
  const { doc } = loadClientScripts({ initialDecision: null });
  const checks = doc.getElementById('thinking-checks');
  // Nothing should have been written since window.BOT_INITIAL_DECISION is null.
  assert.equal(checks.innerHTML, '');
});

test('Client (Phase E): server-rendered BOT_INITIAL_DECISION populates the Decision Engine on load without any socket event', () => {
  const initialDecision = {
    decision: 'WAIT',
    reason: 'no_level_touch',
    checks: {
      trend: { status: 'BULLISH', ema50: 64010 },
      support: { status: 'NOT_TOUCHED', level: 64024 },
      resistance: { status: 'NOT_TOUCHED', level: 64280 },
      bodyExpansion: { status: 'FAIL', bodySize: 1, prevBodySize: 5 },
      volume: { status: 'UNAVAILABLE', value: null },
      liquiditySweep: { status: 'NONE' },
      cycle3Candle: { status: 'NONE' },
    },
  };
  const { doc } = loadClientScripts({ initialDecision });

  const decisionEl = doc.getElementById('thinking-decision');
  const reasonEl = doc.getElementById('thinking-reason');
  const checksEl = doc.getElementById('thinking-checks');

  assert.equal(decisionEl.textContent, 'WAIT');
  assert.equal(reasonEl.textContent, 'no_level_touch');
  assert.match(checksEl.innerHTML, /UNAVAILABLE/);
  assert.doesNotMatch(checksEl.innerHTML, />PASS<.*Volume/s);
});

test('Client (live update + Test B/C): bot:decision (BUY) updates Decision Engine and history, with real reason/checks', () => {
  const { doc, socket } = loadClientScripts({ instanceId: 'inst_42' });

  socket.__fire('bot:decision', {
    instanceId: 'inst_42',
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
  });

  assert.equal(doc.getElementById('thinking-decision').textContent, 'BUY');
  assert.match(doc.getElementById('thinking-decision').className, /text-emerald-400/);
  assert.equal(doc.getElementById('thinking-reason').textContent, '3-Candle Buy Cycle at Support (64024)');

  // Decision History got a new prepended row.
  const history = doc.getElementById('signal-history-container');
  assert.equal(history.children.length, 1);
  assert.equal(history.children[0].children[1].textContent, 'BUY');
});

test('Client (live update, Test B/SELL): bot:decision (SELL) updates Decision Engine correctly', () => {
  const { doc, socket } = loadClientScripts({ instanceId: 'inst_42' });
  socket.__fire('bot:decision', {
    instanceId: 'inst_42',
    decision: 'SELL',
    reason: 'Rejection Sweep at Resistance (64280)',
    checks: null,
  });
  assert.equal(doc.getElementById('thinking-decision').textContent, 'SELL');
  assert.match(doc.getElementById('thinking-decision').className, /text-rose-400/);
});

test('Client: bot:decision for a DIFFERENT instanceId is ignored (per-bot isolation)', () => {
  const { doc, socket } = loadClientScripts({ instanceId: 'inst_A' });
  socket.__fire('bot:decision', { instanceId: 'inst_B', decision: 'BUY', reason: 'wrong bot' });
  assert.equal(doc.getElementById('thinking-decision').textContent, '');
});

test('Client (Test F): legacy bot:thinking CANNOT overwrite an authoritative bot:decision value', () => {
  const { doc, socket } = loadClientScripts({ instanceId: 'inst_42' });

  socket.__fire('bot:decision', {
    instanceId: 'inst_42',
    decision: 'BUY',
    reason: 'REAL MODEL_001 reason',
    checks: { trend: { status: 'BULLISH', ema50: 1 }, support: { status: 'TOUCHED', level: 1 }, resistance: { status: 'NOT_TOUCHED', level: 1 }, bodyExpansion: { status: 'PASS' }, volume: { status: 'UNAVAILABLE', value: null }, liquiditySweep: { status: 'NONE' }, cycle3Candle: { status: 'BUY' } },
  });

  // Legacy event arrives afterwards with fake mock-style values.
  socket.__fire('bot:thinking', {
    instanceId: 'inst_42',
    decision: 'WAIT',
    factors: [{ label: 'EMA Filter', status: 'PASS' }],
    humanReason: 'Waiting for valid breakout confirmation.',
  });

  assert.equal(doc.getElementById('thinking-decision').textContent, 'BUY', 'legacy bot:thinking must not overwrite the real decision');
  assert.equal(doc.getElementById('thinking-reason').textContent, 'REAL MODEL_001 reason');
});

test('Client (Test H sanity): bot:tick never touches Decision Engine fields', () => {
  const { doc, socket } = loadClientScripts({ instanceId: 'inst_42' });

  socket.__fire('bot:decision', { instanceId: 'inst_42', decision: 'WAIT', reason: 'no_level_touch', checks: null });
  const before = doc.getElementById('thinking-decision').textContent;

  socket.__fire('bot:tick', {
    instanceId: 'inst_42', price: 65000,
    position: { pnl: 12.3, pnlPct: 1.1 },
  });

  assert.equal(doc.getElementById('thinking-decision').textContent, before);
  assert.equal(doc.getElementById('market-price').textContent, '$65000.00');
});
