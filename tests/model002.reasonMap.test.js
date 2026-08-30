'use strict';

/**
 * Tests for public/js/renderers/model002-reason-map.js — the single
 * shared source of truth for translating MODEL_002's internal snake_case
 * reason codes into human-readable text, used by both the live formatter
 * (public/js/bot-detail-ws.js) and server-rendered Decision History
 * (controllers/botController.js -> views/bot-detail.ejs).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// --- Node/CommonJS loading ------------------------------------------------

test('model002-reason-map.js loads under Node/CommonJS (require)', () => {
  const mod = require('../public/js/renderers/model002-reason-map.js');
  assert.equal(typeof mod.formatModel002Reason, 'function');
  assert.equal(typeof mod.REASON_TEXT, 'object');
});

// --- Browser (UMD) loading -------------------------------------------------

test('model002-reason-map.js is structured as a UMD module that also attaches window.Model002ReasonMap in a browser-like global', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'renderers', 'model002-reason-map.js'), 'utf8');
  assert.match(content, /root\.Model002ReasonMap = factory\(\)/);
  assert.match(content, /typeof module === 'object' && module\.exports/);

  // Simulate a browser global (no `module`) and confirm the same file
  // attaches the map to that global, proving the browser branch works,
  // not just the Node branch.
  const vm = require('node:vm');
  const sandbox = { self: {} };
  vm.createContext(sandbox);
  vm.runInContext(content, sandbox);
  assert.equal(typeof sandbox.self.Model002ReasonMap, 'object');
  assert.equal(typeof sandbox.self.Model002ReasonMap.formatModel002Reason, 'function');
  assert.equal(sandbox.self.Model002ReasonMap.formatModel002Reason('no_level_touch'), 'Waiting for price to touch a configured level');
});

// --- Formatting correctness — every real MODEL_002 reason code -----------

const { formatModel002Reason, REASON_TEXT } = require('../public/js/renderers/model002-reason-map.js');

test('every reason code actually emitted by Model002.js/sameSidePatternEngine.js has a human-readable mapping', () => {
  // Exhaustive list, copied directly from grepping the real source files —
  // not guessed. If a new reason is ever added to Model002.js without a
  // mapping here, this test fails loudly rather than silently showing a
  // raw code in production.
  const realReasonCodes = [
    'three_consecutive_losses', 'insufficient_history', 'position_already_open',
    'direct_entry_pending_client_confirmation', 'no_level_touch',
    'candle1_support_touch_awaiting_candle2', 'candle1_resistance_touch_awaiting_candle2',
    'awaiting_candle2_body_touch', 'candle2_did_not_touch_body_high', 'candle2_did_not_touch_body_low',
    'bodyP_not_maximum', 'candle2_not_bullish', 'candle2_not_bearish', 'candle2_confirmed',
    'candle2_confirmed_awaiting_boundary_break', 'awaiting_boundary_break',
    'invalidated_close_below_lower_boundary', 'invalidated_close_above_upper_boundary',
    'risk_length_exceeds_maximum', 'lot_mapping_unavailable',
    'r1_calibration_confirmed_no_trade', 's1_calibration_confirmed_no_trade',
    'no_prior_candle_for_ab_validation', 'ab_body_high_not_greater', 'ab_body_low_not_less',
    'candle2_confirmed_awaiting_candle3', 'invalidated_candle3_wrong_or_no_boundary_touch',
    'invalidated_both_boundaries_tick_order', 'invalidated_both_boundaries_no_tick_evidence',
    'rejected',
  ];
  for (const code of realReasonCodes) {
    assert.ok(Object.prototype.hasOwnProperty.call(REASON_TEXT, code), `missing mapping for real reason code: ${code}`);
    assert.notEqual(REASON_TEXT[code], code, `mapping for ${code} must not just echo the raw code`);
  }
});

test('formatModel002Reason never returns a raw snake_case code for a known reason', () => {
  assert.equal(formatModel002Reason('candle1_support_touch_awaiting_candle2'), 'Support touched — Candle 1 set, awaiting Candle 2');
  // Display wording only — Candle 3 triggers on a touch/cross, never on a close.
  assert.equal(formatModel002Reason('awaiting_boundary_break'), 'Waiting for Candle 3 to touch/cross the boundary');
  assert.equal(formatModel002Reason('direct_entry_pending_client_confirmation'), 'Opposite-side pattern — pending client confirmation, not traded');
  assert.equal(/_/.test(formatModel002Reason('candle1_support_touch_awaiting_candle2')), false);
});

test('formatModel002Reason passes through the already-human-readable "<DIRECTION> pattern confirmed" text unchanged', () => {
  assert.equal(formatModel002Reason('BUY pattern confirmed'), 'BUY pattern confirmed');
  assert.equal(formatModel002Reason('SELL pattern confirmed'), 'SELL pattern confirmed');
});

test('formatModel002Reason never hides an unknown/future reason code — falls back to the raw code rather than going blank', () => {
  assert.equal(formatModel002Reason('some_future_reason_code'), 'some_future_reason_code');
  assert.equal(formatModel002Reason(''), '');
  assert.equal(formatModel002Reason(null), '');
});

test('the reason map never mentions the removed "1.5x" / "Body Confirmation" counter-trend terminology', () => {
  const allText = Object.values(REASON_TEXT).join(' ');
  assert.equal(/1\.5x/.test(allText), false);
  assert.equal(/Body Confirmation/i.test(allText), false);
});

// --- MODEL_002 source drift guard ------------------------------------------

test('every reason: string literal in Model002.js/sameSidePatternEngine.js is present in the shared map (drift guard)', () => {
  const model002Content = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  const patternEngineContent = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'sameSidePatternEngine.js'), 'utf8');
  const combined = model002Content + patternEngineContent;

  const literalReasonRegex = /reason:\s*'([a-zA-Z_]+)'/g;
  const found = new Set();
  let m;
  while ((m = literalReasonRegex.exec(combined)) !== null) {
    found.add(m[1]);
  }
  assert.ok(found.size > 0, 'sanity check: the regex must find at least one reason literal');
  for (const code of found) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(REASON_TEXT, code),
      `Model002 source now emits reason "${code}" with no entry in model002-reason-map.js`
    );
  }
});

// --- Wiring: live formatter (bot-detail-ws.js) -----------------------------

test('bot-detail-ws.js routes MODEL_002 reasons through the shared Model002ReasonMap, gated so MODEL_001 is untouched', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bot-detail-ws.js'), 'utf8');
  assert.match(content, /modelId === 'MODEL_002' && window\.Model002ReasonMap/);
  assert.match(content, /window\.Model002ReasonMap\.formatModel002Reason/);
  // The gate must exist at least twice: the thinking-reason panel and the
  // live-appended Decision History row (prependDecisionHistoryRow).
  const gateCount = (content.match(/modelId === 'MODEL_002' && window\.Model002ReasonMap/g) || []).length;
  assert.ok(gateCount >= 2, `expected the MODEL_002 gate in at least 2 places (thinking-reason panel + history row), found ${gateCount}`);
});

// --- Wiring: server-rendered Decision History (single source of truth) ---

test('bot-detail.ejs uses the shared formatMode2Reason local for MODEL_002 in Decision History, not a duplicate inline map', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'views', 'bot-detail.ejs'), 'utf8');
  assert.match(content, /bot\.modelId === 'MODEL_002' && typeof formatModel002Reason === 'function'/);
  assert.match(content, /formatModel002Reason\(d\.reason\)/);
  // No second reason-map object literal should exist in the EJS file itself.
  assert.equal(/candle1_support_touch_awaiting_candle2\s*:/.test(content), false, 'EJS must not duplicate the reason map inline');
});

test('controllers/botController.js requires the shared reason-map module and passes it into the template locals', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'botController.js'), 'utf8');
  assert.match(content, /require\(['"]\.\.\/public\/js\/renderers\/model002-reason-map\.js['"]\)/);
  assert.match(content, /formatModel002Reason,/);
});

test('views/bot-detail.ejs loads the shared reason-map script before model-thinking-registry.js and bot-detail-ws.js (browser side)', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'views', 'bot-detail.ejs'), 'utf8');
  const reasonMapIdx = content.indexOf('<script src="/js/renderers/model002-reason-map.js">');
  const registryIdx = content.indexOf('<script src="/js/renderers/model-thinking-registry.js">');
  const wsIdx = content.indexOf('<script src="/js/bot-detail-ws.js">');
  assert.ok(reasonMapIdx > -1, 'reason-map script tag must exist');
  assert.ok(registryIdx > -1, 'model-thinking-registry.js script tag must exist');
  assert.ok(wsIdx > -1, 'bot-detail-ws.js script tag must exist');
  assert.ok(reasonMapIdx < registryIdx, 'reason-map must load before model-thinking-registry.js');
  assert.ok(reasonMapIdx < wsIdx, 'reason-map must load before bot-detail-ws.js');
});

// --- MODEL_001 preservation -------------------------------------------------

test('MODEL_001 source files are untouched and never reference the MODEL_002 reason map', () => {
  const dir = path.join(__dirname, '..', 'bot-models', 'model-001');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(/model002-reason-map/.test(content), false, `${file} must not reference the MODEL_002 reason map`);
  }
});

test('the Decision History reason formatting is gated to MODEL_002 only — MODEL_001 rows render bot.reason unchanged', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'views', 'bot-detail.ejs'), 'utf8');
  // The ternary's false branch (non-MODEL_002 path) must fall back to the
  // raw `d.reason` exactly as before this change — i.e. MODEL_001's
  // already-human-readable sentences are never passed through the map.
  assert.match(content, /:\s*\(d\.reason \|\| ''\)/);
});

// --- Description accuracy (bot-models/model-002/index.js) ----------------

test('bot-models/model-002/index.js describes the CURRENT same-side strategy, not the old counter-trend formula', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'index.js'), 'utf8');
  assert.match(content, /BULLISH\+SUPPORT=BUY/);
  assert.match(content, /BEARISH\+RESISTANCE=SELL/);
  assert.equal(/BEARISH\+SUPPORT=BUY/.test(content), false, 'must not describe the old counter-trend BUY combination');
  assert.equal(/BULLISH\+RESISTANCE=SELL/.test(content), false, 'must not describe the old counter-trend SELL combination');
  assert.equal(/1\.5x body confirmation/i.test(content), false, 'must not describe the removed 1.5x-body-average rule');
});
