'use strict';

/**
 * ONE-TIME OPPOSITE-MARKET ACTIVE-TIMEFRAME SWITCH — Tests A..L.
 *
 * Drives the REAL Model002 through real closed candles (same harness style
 * as tests/model002.sameSidePattern.test.js) and the REAL shared helpers in
 * utils/activeTimeframe.js — no mocks of the detection logic, no second
 * detector. Dependency-free (node:test + node:assert only): the persistence
 * side is exercised through the pure helpers BotManager itself calls, since
 * BotManager pulls in mongoose.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Model002 = require('../bot-models/model-002/Model002');
const tf = require('../utils/activeTimeframe');

const MIN = 60000;
const BASE = 1_700_000_000_000;

const SUPPORT = [60000, 59000, 58000];
const RESISTANCE = [65000, 66000, 67000];

function makeCtx() {
  const ctx = { events: [], commands: [] };
  ctx.emit = (e) => ctx.events.push(e);
  ctx.submitTradeCommand = async (cmd) => { ctx.commands.push(cmd); return { approved: true, reason: 'Approved', metadata: {} }; };
  return ctx;
}

/** A closed candle whose range touches `level` (so findTouchedLevel matches it). */
function touching(level, i) {
  return {
    timestamp: BASE + i * MIN,
    open: level + 5, high: level + 10, low: level - 10, close: level + 2, volume: null,
  };
}

/** A closed candle far away from every configured level. */
function neutral(i) {
  const p = 62500;
  return { timestamp: BASE + i * MIN, open: p, high: p + 5, low: p - 5, close: p + 1, volume: null };
}

async function startBot({ trend, timeframe = '3m', parameters = {} } = {}) {
  const ctx = makeCtx();
  const model = new Model002(ctx);
  await model.onStart({
    instanceId: 'inst_' + Math.random().toString(36).slice(2, 8),
    symbol: 'BTCUSD', environment: 'PAPER',
    parameters: Object.assign({
      timeframe, trend, support: SUPPORT, resistance: RESISTANCE, historySize: 20,
    }, parameters),
    capitalAllocation: 10000, leverage: 10, riskSettings: {},
  });
  // MODEL_002 requires a few eligible closed candles before it evaluates levels.
  for (let i = 0; i < 4; i += 1) await feed(model, neutral(i));
  return { ctx, model };
}

async function feed(model, candle) {
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '3m', timestamp: candle.timestamp, data: candle }, null);
}

function switchEvents(ctx) {
  return ctx.events.filter((e) => e.eventType === 'ACTIVE_TIMEFRAME_SWITCHED');
}

// =========================================================================
// The rule itself (pure) — the ONLY two opposite combinations
// =========================================================================

test('opposite-market rule: only BULLISH+Resistance and BEARISH+Support', () => {
  assert.equal(tf.isOppositeMarketTouch('BULLISH', 'RESISTANCE'), true);
  assert.equal(tf.isOppositeMarketTouch('BEARISH', 'SUPPORT'), true);
  assert.equal(tf.isOppositeMarketTouch('BULLISH', 'SUPPORT'), false);
  assert.equal(tf.isOppositeMarketTouch('BEARISH', 'RESISTANCE'), false);
  assert.equal(tf.isOppositeMarketTouch(undefined, 'SUPPORT'), false);
});

test('there is no way back: the helper exposes no restore/reset function', () => {
  const names = Object.keys(tf).join(' ');
  assert.doesNotMatch(names, /restore|reset|revert|unswitch/i);
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'activeTimeframe.js'), 'utf8');
  assert.doesNotMatch(src, /activeTimeframe\s*=\s*.*configured/i);
});

// =========================================================================
// Test A — BULLISH + Resistance touched
// =========================================================================

test('Test A: BULLISH + Resistance touch -> active 1m, switched true, configured still 3m', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH', timeframe: '3m' });
  assert.equal(model.activeTimeframe, '3m');
  assert.equal(model.timeframeSwitched, false);

  await feed(model, touching(RESISTANCE[1], 10)); // R2

  assert.equal(model.activeTimeframe, '1m');
  assert.equal(model.timeframeSwitched, true);
  assert.equal(model.params.timeframe, '3m', 'configured timeframe must never be overwritten');

  const evt = switchEvents(ctx);
  assert.equal(evt.length, 1);
  assert.equal(evt[0].payload.trend, 'BULLISH');
  assert.equal(evt[0].payload.touchedSide, 'RESISTANCE');
  assert.equal(evt[0].payload.configuredTimeframe, '3m');
  assert.equal(evt[0].payload.activeTimeframe, '1m');
  assert.match(evt[0].payload.message, /Opposite market detected: BULLISH \+ Resistance touch\./);
  assert.match(evt[0].payload.message, /switched from 3m to 1m/);
});

// =========================================================================
// Test B — BEARISH + Support touched
// =========================================================================

test('Test B: BEARISH + Support touch -> active 1m, switched true, configured still 3m', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH', timeframe: '3m' });
  await feed(model, touching(SUPPORT[0], 10)); // S1

  assert.equal(model.activeTimeframe, '1m');
  assert.equal(model.timeframeSwitched, true);
  assert.equal(model.params.timeframe, '3m');
  const evt = switchEvents(ctx);
  assert.equal(evt.length, 1);
  assert.equal(evt[0].payload.touchedSide, 'SUPPORT');
  assert.match(evt[0].payload.message, /BEARISH \+ Support touch/);
});

// =========================================================================
// Tests C / D — same-side touches never trigger
// =========================================================================

test('Test C: BULLISH + Support touch -> no switch', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH', timeframe: '3m' });
  await feed(model, touching(SUPPORT[0], 10));
  assert.equal(model.activeTimeframe, '3m');
  assert.equal(model.timeframeSwitched, false);
  assert.equal(switchEvents(ctx).length, 0);
});

test('Test D: BEARISH + Resistance touch -> no switch', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH', timeframe: '3m' });
  await feed(model, touching(RESISTANCE[0], 10));
  assert.equal(model.activeTimeframe, '3m');
  assert.equal(model.timeframeSwitched, false);
  assert.equal(switchEvents(ctx).length, 0);
});

// =========================================================================
// Test E — bot already configured on 1m
// =========================================================================

test('Test E: bot configured on 1m -> opposite touch causes no state change at all', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH', timeframe: '1m' });
  await feed(model, touching(RESISTANCE[0], 10));
  assert.equal(model.activeTimeframe, '1m');
  assert.equal(model.timeframeSwitched, false, 'no switch flag is set for a bot already on 1m');
  assert.equal(switchEvents(ctx).length, 0);
  assert.equal(tf.shouldSwitch({ timeframe: '1m' }), false);
});

// =========================================================================
// Test F — one-time only
// =========================================================================

test('Test F: a second (and third) opposite touch produces no second transition or event', async () => {
  const { ctx, model } = await startBot({ trend: 'BULLISH', timeframe: '3m' });
  await feed(model, touching(RESISTANCE[0], 10));
  await feed(model, touching(RESISTANCE[1], 20));
  await feed(model, touching(RESISTANCE[2], 30));

  assert.equal(model.activeTimeframe, '1m');
  assert.equal(switchEvents(ctx).length, 1, 'the switch must be recorded exactly once');
});

// =========================================================================
// Test G — never switches back
// =========================================================================

test('Test G: normal (same-side / neutral) market after the switch never restores 3m', async () => {
  const { model } = await startBot({ trend: 'BULLISH', timeframe: '3m' });
  await feed(model, touching(RESISTANCE[0], 10));
  assert.equal(model.activeTimeframe, '1m');

  for (let i = 11; i < 20; i += 1) await feed(model, neutral(i));
  await feed(model, touching(SUPPORT[0], 21));  // the "normal" bullish condition
  for (let i = 22; i < 26; i += 1) await feed(model, neutral(i));

  assert.equal(model.activeTimeframe, '1m');
  assert.equal(model.timeframeSwitched, true);
  assert.equal(model.params.timeframe, '3m');
});

// =========================================================================
// Test H — the candle already forming at the switch instant is not analysed
// =========================================================================

test('Test H: only a 1m candle whose period STARTS at/after the switch is analysable', () => {
  const switchedAt = Date.parse('2026-08-17T14:23:35.000Z');
  const dbInstance = {
    createdAt: new Date(Date.parse('2026-08-17T09:00:00.000Z')),
    parameters: { timeframe: '3m', activeTimeframe: '1m', timeframeSwitched: true, timeframeSwitchedAt: switchedAt },
  };
  const baseline = tf.computeAnalysisBaselineMs(dbInstance);
  assert.equal(baseline, switchedAt);

  const forming1423 = Date.parse('2026-08-17T14:23:00.000Z'); // already forming when we switched
  const next1424 = Date.parse('2026-08-17T14:24:00.000Z');    // the first genuinely new candle
  assert.ok(forming1423 < baseline, '14:23 candle must be rejected');
  assert.ok(next1424 >= baseline, '14:24 candle must be the first accepted');
});

test('Test H (cont.): the baseline still respects createdAt and levelsUpdatedAt', () => {
  const created = Date.parse('2026-08-17T09:00:00.000Z');
  const levels = Date.parse('2026-08-17T12:00:00.000Z');
  const switched = Date.parse('2026-08-17T10:00:00.000Z');
  const baseline = tf.computeAnalysisBaselineMs({
    createdAt: new Date(created),
    parameters: { timeframe: '3m', levelsUpdatedAt: levels, timeframeSwitched: true, activeTimeframe: '1m', timeframeSwitchedAt: switched },
  });
  assert.equal(baseline, levels, 'baseline is the max of all three, never only the switch');

  // A bot that never switched keeps exactly the pre-existing baseline.
  assert.equal(
    tf.computeAnalysisBaselineMs({ createdAt: new Date(created), parameters: { timeframe: '3m' } }),
    created
  );
});

// =========================================================================
// Test I — restart / recovery
// =========================================================================

test('Test I: persisted switch state survives restart and does not re-trigger', async () => {
  // What BotManager writes to BotInstance.parameters when the switch happens.
  const persisted = tf.applySwitch({ timeframe: '3m', trend: 'BULLISH', support: SUPPORT, resistance: RESISTANCE }, 1_700_000_500_000);
  assert.equal(persisted.timeframe, '3m');
  assert.equal(persisted.activeTimeframe, '1m');
  assert.equal(persisted.timeframeSwitched, true);
  assert.equal(persisted.timeframeSwitchedAt, 1_700_000_500_000);

  // Restart: the same parameters come back out of MongoDB into onStart.
  const { ctx, model } = await startBot({ trend: 'BULLISH', timeframe: '3m', parameters: persisted });
  assert.equal(model.activeTimeframe, '1m', 'must NOT restart on 3m');
  assert.equal(model.timeframeSwitched, true);
  assert.equal(model.params.timeframe, '3m', 'configured value still recoverable after restart');

  // Another opposite touch after the restart must not re-log or re-switch.
  await feed(model, touching(RESISTANCE[0], 10));
  assert.equal(switchEvents(ctx).length, 0);
  assert.equal(model.activeTimeframe, '1m');

  // And applySwitch itself refuses to run twice.
  assert.equal(tf.applySwitch(persisted, Date.now()), null);
});

// =========================================================================
// Test J — per-instance isolation
// =========================================================================

test('Test J: bot A switches, bot B (same process, same model) stays on 3m', async () => {
  const a = await startBot({ trend: 'BULLISH', timeframe: '3m' });
  const b = await startBot({ trend: 'BULLISH', timeframe: '3m' });

  await feed(a.model, touching(RESISTANCE[0], 10));

  assert.equal(a.model.activeTimeframe, '1m');
  assert.equal(b.model.activeTimeframe, '3m');
  assert.equal(b.model.timeframeSwitched, false);
  assert.equal(switchEvents(b.ctx).length, 0);

  // Routing is per-instance too — same helper, different parameters objects.
  const dbA = { parameters: { timeframe: '3m', activeTimeframe: '1m', timeframeSwitched: true } };
  const dbB = { parameters: { timeframe: '3m' } };
  assert.equal(tf.getActiveTimeframe(dbA), '1m');
  assert.equal(tf.getActiveTimeframe(dbB), '3m');
});

test('no module-level/global switch state exists in the model or the helper', () => {
  const model = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  // the flags are only ever read/written through `this.`
  const hits = model.match(/timeframeSwitched/g) || [];
  const scoped = model.match(/this\.timeframeSwitched/g) || [];
  assert.ok(hits.length > 0);
  assert.ok(scoped.length >= 3, 'switch state must be per-instance (this.*)');
  assert.doesNotMatch(model, /^let\s+timeframeSwitched/m);
  assert.doesNotMatch(model, /^const\s+timeframeSwitched/m);
});

// =========================================================================
// Test K — no historical replay
// =========================================================================

test('Test K: 1m candles older than the switch are filtered out of hydration', () => {
  const switchedAt = Date.parse('2026-08-17T14:23:35.000Z');
  const dbInstance = {
    createdAt: new Date(Date.parse('2026-08-17T09:00:00.000Z')),
    parameters: { timeframe: '3m', activeTimeframe: '1m', timeframeSwitched: true, timeframeSwitchedAt: switchedAt },
  };
  const baseline = tf.computeAnalysisBaselineMs(dbInstance);

  const history = [];
  for (let i = 0; i < 40; i += 1) history.push({ timestamp: Date.parse('2026-08-17T14:00:00.000Z') + i * MIN });
  const kept = history.filter((c) => c.timestamp >= baseline); // the exact rule BotManager applies

  assert.equal(kept.length, 16, 'only 14:24..14:39 survive');
  assert.equal(kept[0].timestamp, Date.parse('2026-08-17T14:24:00.000Z'));
  assert.ok(kept.every((c) => c.timestamp >= switchedAt));
});

// =========================================================================
// Test L — UI shows the active timeframe
// =========================================================================

const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'bot-detail.ejs'), 'utf8');

test('Test L: the Bot Detail page shows the ACTIVE timeframe once switched, and keeps the configured one', () => {
  assert.match(view, /id="active-timeframe-row"/);
  assert.match(view, /id="active-timeframe-value"/);
  // configured timeframe display is untouched
  assert.match(view, /Timeframe<\/div>\s*\n\s*<div[^>]*>&lt;%=|Timeframe<\/div>/);
  assert.match(view, /bot\.parameters\.timeframeSwitched === true\) \? '' : 'hidden'/);
  // exposed to the client and used by chart + countdown
  assert.match(view, /activeTimeframe:\s*"<%=/);
  assert.match(view, /window\.BOT_CONFIG\.activeTimeframe \|\| window\.BOT_CONFIG\.timeframe/);
  // live update rides the EXISTING bot:status handler — no new socket/event
  assert.match(view, /renderActiveTimeframe\(data\)/);
});

test('Test L (cont.): chart candles and execution markers follow the active timeframe', () => {
  for (const f of ['public/js/bot-detail-chart.js', 'public/js/bot-detail-ws.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(src, /window\.BOT_CONFIG\.activeTimeframe \|\| window\.BOT_CONFIG\.timeframe/, f);
    assert.doesNotMatch(src, /\bio\(\)/, f); // still no second socket connection
  }
  const controller = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'botInstancesController.js'), 'utf8');
  assert.match(controller, /getActiveTimeframe\(instance\)/);
});

// =========================================================================
// Wiring: routing/persistence reuse the ONE helper, nothing duplicated
// =========================================================================

test('BotManager and CandlePersistenceService both route on the shared active timeframe', () => {
  const bm = fs.readFileSync(path.join(__dirname, '..', 'services', 'botManager', 'BotManager.js'), 'utf8');
  assert.match(bm, /require\('\.\.\/\.\.\/utils\/activeTimeframe'\)/);
  assert.match(bm, /if \(getActiveTimeframe\(dbInstance\) === timeframe\) return true;/);
  assert.match(bm, /const baselineMs = computeAnalysisBaselineMs\(dbInstance\);/);
  assert.match(bm, /event\.eventType === 'ACTIVE_TIMEFRAME_SWITCHED'/);
  assert.match(bm, /markModified\('parameters'\)/);
  // never rewrites the user's configured timeframe
  assert.doesNotMatch(bm, /parameters\.timeframe\s*=\s*'1m'/);

  const cps = fs.readFileSync(path.join(__dirname, '..', 'services', 'marketData', 'CandlePersistenceService.js'), 'utf8');
  assert.match(cps, /const tf = getActiveTimeframe\(bot\);/);
  assert.match(cps, /invalidateSymbol\(symbol\)/);
});

test('MODEL_002 detection hangs off the existing touch path, not a second detector', () => {
  const model = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  // called from _startCandle1 — the single existing fresh-touch entry point
  const startFn = model.slice(model.indexOf('_startCandle1(candle, direction, matchedLevel) {'));
  assert.match(startFn.slice(0, 300), /_maybeSwitchToOppositeMarketTimeframe\(candle, direction, matchedLevel\)/);
  // it reuses the shared rule rather than re-deriving trend/side comparisons
  assert.match(model, /isOppositeMarketTouch\(this\.params\.trend, touchedSide\)/);
  // and the model never touches the database itself — persistence stays in
  // BotManager (the model only emits through the existing event pipeline)
  assert.doesNotMatch(model, /require\(.*models\/BotInstance/);
  assert.match(model, /this\.emitStrategyEvent\('ACTIVE_TIMEFRAME_SWITCHED'/);
});
