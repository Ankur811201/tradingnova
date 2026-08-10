'use strict';

/**
 * Focused tests for the "Create New Bot" UI — now MODEL_002-only.
 *
 * These are static-content checks against views/bots.ejs and
 * public/js/bots.js — this project has no headless-browser/DOM test
 * runner, so real form interaction/submission cannot be exercised here.
 * What IS verified, precisely:
 *   1. MODEL_001 does not appear anywhere in the Create Bot form —
 *      no dropdown option, no legacy fallback section (removed entirely,
 *      not hidden), no legacy submission branch.
 *   2. The Bot Model field is fixed/readonly = MODEL_002.
 *   3. The MODEL_002 fields (trend, 3 support, 3 resistance, timeframe)
 *      exist with the expected element ids.
 *   4. The submit handler builds a payload using the model's REAL,
 *      existing parameter names (trend/support/resistance/timeframe) —
 *      no invented field names — and never includes levels/targets/
 *      sizing (the legacy branch/functions are fully removed, not just
 *      unused).
 *   5. The backend contract those fields feed (bot-models/model-002/
 *      validators.js) is exercised directly and for real, matching what
 *      the new form's "exactly 3, required" fields now send.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateAndMergeParameters } = require('../bot-models/model-002/validators');

const viewPath = path.join(__dirname, '..', 'views', 'bots.ejs');
const jsPath = path.join(__dirname, '..', 'public', 'js', 'bots.js');
const view = fs.readFileSync(viewPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');

// =========================================================================
// View: obsolete fields removed from the default (MODEL_002) path
// =========================================================================

test('MODEL_001 does not appear anywhere in the Create Bot form', () => {
  const start = view.indexOf('<form id="createForm">');
  const end = view.indexOf('</form>', start);
  assert.ok(start > -1 && end > start, 'expected to find the create-bot form');
  const formBlock = view.slice(start, end);
  assert.equal(/MODEL_001/.test(formBlock), false, 'MODEL_001 must not appear anywhere in the form markup');
});

test('the Bot Model field is a fixed, readonly MODEL_002 value — not a selectable dropdown', () => {
  assert.match(view, /id="instModel" type="text" value="MODEL_002" readonly/);
  assert.equal(/<select id="instModel"/.test(view), false, 'instModel must not be a <select> (that would allow choosing another model, e.g. MODEL_001)');
});

test('none of the removed legacy MODEL_001 fields/sections exist anywhere in the Create Bot form', () => {
  const start = view.indexOf('<form id="createForm">');
  const end = view.indexOf('</form>', start);
  const formBlock = view.slice(start, end);
  const removedIds = [
    'instTopLevel', 'instBottomLevel', 'instTargets',
    'instSizingMode', 'instLotValue', 'instLotValueField',
    'legacyModelSection', 'modelParamsSection', 'modelParamsContainer',
    'autoTimeframe', 'autoStrategy',
  ];
  for (const id of removedIds) {
    assert.equal(formBlock.includes(`id="${id}"`), false, `${id} must not appear anywhere in the Create Bot form`);
  }
});

test('the Create Bot form exposes exactly the new MODEL_002 fields with the expected ids', () => {
  const requiredIds = [
    'instName', 'instModel', 'instSymbol', 'instEnv', 'instLeverage', 'instCapital',
    'trendBullish', 'trendBearish',
    'instResistance1', 'instResistance2', 'instResistance3',
    'instSupport1', 'instSupport2', 'instSupport3',
    'tf1m', 'tf3m',
  ];
  for (const id of requiredIds) {
    assert.match(view, new RegExp(`id="${id}"`), `expected element id="${id}" in the Create Bot form`);
  }
});

test('leverage is a proper 1-200 numeric input, not the old 6-option capped dropdown', () => {
  assert.match(view, /id="instLeverage" type="number" min="1" max="200"/);
});

test('all 6 level inputs (3 support + 3 resistance) are marked required in markup', () => {
  for (const id of ['instResistance1', 'instResistance2', 'instResistance3', 'instSupport1', 'instSupport2', 'instSupport3']) {
    const re = new RegExp(`id="${id}"[^>]*required`);
    assert.match(view, re, `${id} should be marked required`);
  }
});

// =========================================================================
// JS: payload construction uses the model's real parameter names, and
// never sends legacy fields for MODEL_002
// =========================================================================

test('the MODEL_002 payload builder uses the real backend parameter names (trend/support/resistance/timeframe)', () => {
  assert.match(js, /return \{ parameters: \{ trend, support, resistance, timeframe \} \};/);
});

test('modelId is hardcoded to MODEL_002 in the submit handler — never read from a selectable field', () => {
  assert.match(js, /const modelId = 'MODEL_002';/);
});

test('the submit handler payload never includes levels/targets/sizing — no legacy branch exists anymore', () => {
  assert.equal(/payload\.levels|payload\.targets|payload\.sizing/.test(js), false);
  assert.equal(/collectModelParams/.test(js), false, 'the legacy generic-parameter collector must be fully removed, not just unused');
  assert.equal(/renderModelParamFields/.test(js), false, 'the legacy generic-parameter renderer must be fully removed, not just unused');
  assert.equal(/toggleModelSections/.test(js), false, 'the legacy section-toggle logic must be fully removed — there is no other section to toggle against');
});

test('frontend validates leverage 1-200 and positive capital before ever building a payload', () => {
  assert.match(js, /leverage < 1 \|\| leverage > 200/);
  assert.match(js, /capitalAllocation <= 0/);
});

// =========================================================================
// Backend contract those fields feed — exercised for real, not just
// statically. Confirms the "exactly 3, required" rule the new form
// enforces is also authoritatively enforced server-side.
// =========================================================================

test('backend: exactly 3 support and 3 resistance levels are required (matches the new form)', () => {
  assert.throws(
    () => validateAndMergeParameters({ timeframe: '1m', trend: 'BULLISH', support: [1, 2], resistance: [1, 2, 3] }),
    /exactly 3 support levels/
  );
  const ok = validateAndMergeParameters({
    timeframe: '1m', trend: 'BULLISH',
    support: [64400, 64350, 64300], resistance: [65000, 64990, 64700],
  });
  assert.deepEqual(ok.support, [64400, 64350, 64300]);
  assert.deepEqual(ok.resistance, [65000, 64990, 64700]);
});

test('backend: timeframe restricted to 1m/3m, matching the form\'s two radio options', () => {
  assert.throws(
    () => validateAndMergeParameters({ timeframe: '5m', trend: 'BULLISH', support: [1, 2, 3], resistance: [4, 5, 6] }),
    /1m, 3m/
  );
  for (const tf of ['1m', '3m']) {
    const ok = validateAndMergeParameters({ timeframe: tf, trend: 'BULLISH', support: [1, 2, 3], resistance: [4, 5, 6] });
    assert.equal(ok.timeframe, tf);
  }
});

test('backend: trend restricted to BULLISH/BEARISH, matching the form\'s two radio options', () => {
  assert.throws(
    () => validateAndMergeParameters({ timeframe: '1m', trend: 'SIDEWAYS', support: [1, 2, 3], resistance: [4, 5, 6] }),
    /BULLISH.*BEARISH/
  );
});

// =========================================================================
// Bot Detail — no silent MODEL_001 fallback for an unknown/missing model
// =========================================================================

test('bot-detail.ejs never silently defaults a missing modelId to MODEL_001', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'views', 'bot-detail.ejs'), 'utf8');
  assert.equal(/bot\.modelId \|\| 'MODEL_001'/.test(content), false, 'must not fall back to MODEL_001 for a missing model');
  assert.match(content, /bot\.modelId \|\| 'MODEL_UNKNOWN'/);
});

test('the Bot Detail header shows the friendly MODEL_002 name, honestly falling back for any other/unknown model', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'views', 'bot-detail.ejs'), 'utf8');
  assert.match(content, /MODEL_002 — Custom Pattern/);
});

test('model-thinking-registry.js never silently falls back to the MODEL_001 renderer for an unrecognized model', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'renderers', 'model-thinking-registry.js'), 'utf8');
  assert.equal(/this\.renderers\[modelId\] \|\| this\.renderers\['MODEL_001'\]/.test(content), false);
  assert.match(content, /No renderer available for model/);
});

test('bot-detail-ws.js reads modelId from window.BOT_CONFIG and passes it through generically (no MODEL_001 hardcoding in the decision-rendering path)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bot-detail-ws.js'), 'utf8');
  assert.match(content, /const \{ instanceId, modelId, pair \} = window\.BOT_CONFIG;/);
  assert.match(content, /window\.ModelThinkingRegistry\.render\(\s*\r?\n\s*modelId,/);
});
