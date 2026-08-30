'use strict';

/**
 * PERSISTENT SUPPORT/RESISTANCE LEVEL-TOUCH STATE
 * ==============================================
 *
 * Drives the REAL Model002 through real closed candles (same harness style
 * as tests/model002.oppositeTimeframeSwitch.test.js) plus the REAL shared
 * helpers in utils/levelTouchState.js. No mocks of the detection logic, no
 * second Support/Resistance detector anywhere. Dependency-free (node:test +
 * node:assert only): the persistence side is exercised through the same
 * pure helpers BotManager itself calls, since BotManager pulls in mongoose.
 *
 * The rule under test: once a level has been touched, the UI must keep
 * showing TOUCHED. LEVEL state is separate from PATTERN state and is never
 * re-derived from the latest decision's `activeLevel`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Model002 = require('../bot-models/model-002/Model002');
const levelTouchState = require('../utils/levelTouchState');

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

/** Far from every configured level — never a touch of Support or Resistance. */
function neutral(i) {
  return { timestamp: BASE + i * MIN, open: 62500, high: 62510, low: 62490, close: 62505, volume: null };
}

// --- BULLISH + SUPPORT (NEW A/B/C engine) fixtures ------------------------

/** A — the candle immediately before B. Body high = 60040. Touches nothing. */
function candleA(i) {
  return { timestamp: BASE + i * MIN, open: 60040, high: 60050, low: 60020, close: 60030, volume: null };
}

/** B — touches Support 60000 and PASSES A/B (body high 60060 > 60040), BodyP-max and bullish nature. */
function candleBValid(i) {
  return { timestamp: BASE + i * MIN, open: 60010, high: 60070, low: 59995, close: 60060, volume: null };
}

/** B — touches Support 60000 but FAILS A/B validation (body high 60035 <= 60040). */
function candleBFailsAB(i) {
  return { timestamp: BASE + i * MIN, open: 60005, high: 60045, low: 59990, close: 60035, volume: null };
}

/** C — high 60080 >= upper boundary 60075 -> BUY. */
function candleCBuy(i) {
  return { timestamp: BASE + i * MIN, open: 60060, high: 60080, low: 60055, close: 60070, volume: null };
}

/** C — low 59980 <= lower boundary 59990 (wrong boundary) -> INVALID. */
function candleCInvalid(i) {
  return { timestamp: BASE + i * MIN, open: 60060, high: 60065, low: 59980, close: 60000, volume: null };
}

// --- BEARISH + RESISTANCE (mirror) fixtures -------------------------------

/** A (bearish mirror) — body low = 64960. Touches nothing. */
function candleABear(i) {
  return { timestamp: BASE + i * MIN, open: 64960, high: 64980, low: 64950, close: 64970, volume: null };
}

/** B (bearish mirror) — touches Resistance 65000, body low 64940 < 64960, BodyP-max, bearish. */
function candleBBear(i) {
  return { timestamp: BASE + i * MIN, open: 64990, high: 65005, low: 64930, close: 64940, volume: null };
}

async function feed(model, candle) {
  await model.onMarketData({ type: 'candle', symbol: 'BTCUSD', timeframe: '3m', timestamp: candle.timestamp, data: candle }, null);
}

async function startBot({ trend = 'BULLISH', parameters = {} } = {}) {
  const ctx = makeCtx();
  const model = new Model002(ctx);
  await model.onStart({
    instanceId: 'inst_' + Math.random().toString(36).slice(2, 8),
    symbol: 'BTCUSD', environment: 'PAPER',
    parameters: Object.assign({
      timeframe: '3m', trend, support: SUPPORT, resistance: RESISTANCE, historySize: 20,
    }, parameters),
    capitalAllocation: 10000, leverage: 10, riskSettings: {},
  });
  for (let i = 0; i < 4; i += 1) await feed(model, neutral(i));
  return { ctx, model };
}

function decisions(ctx) {
  return ctx.events.filter((e) => e.eventType === 'DECISION');
}

function lastChecks(ctx) {
  const list = decisions(ctx);
  return list[list.length - 1].payload.checks;
}

function touchEvents(ctx) {
  return ctx.events.filter((e) => e.eventType === 'LEVEL_TOUCHED');
}

// =========================================================================
// 1. Support touch -> Support = TOUCHED
// =========================================================================

test('1. a Support touch sets Support: TOUCHED on the decision payload', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));

  const checks = lastChecks(ctx);
  assert.equal(checks.support.status, 'TOUCHED');
  assert.equal(checks.support.level, 60000);
  assert.equal(checks.resistance.status, 'NOT_TOUCHED');
  assert.equal(model.levelTouch.support.touched, true);

  const touches = touchEvents(ctx);
  assert.equal(touches.length, 1);
  assert.equal(touches[0].payload.side, 'SUPPORT');
  assert.equal(touches[0].payload.price, 60000);
});

// =========================================================================
// 2. Next candle without a Support touch -> still TOUCHED
// =========================================================================

test('2. a later candle that touches nothing does NOT reset Support to NOT_TOUCHED', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  await feed(model, candleCInvalid(12));  // resolves the pattern
  await feed(model, neutral(13));         // no touch at all

  const latest = decisions(ctx)[decisions(ctx).length - 1].payload;
  assert.equal(latest.reason, 'no_level_touch');
  assert.equal(latest.activeLevel, null, 'precondition: this is exactly the decision that used to break the UI');
  assert.equal(latest.checks.support.status, 'TOUCHED');
});

// =========================================================================
// 3. Pattern failure (A/B validation rejected) -> still TOUCHED
// =========================================================================

test('3. an A/B validation failure keeps Support TOUCHED (the touch really happened)', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBFailsAB(11));

  const latest = decisions(ctx)[decisions(ctx).length - 1].payload;
  assert.equal(latest.reason, 'ab_body_high_not_greater');
  assert.equal(latest.checks.support.status, 'TOUCHED');
  assert.equal(latest.checks.patternState, 'IDLE', 'pattern state is IDLE while the level stays TOUCHED');
});

// =========================================================================
// 4. Candle 3 invalidation -> still TOUCHED
// =========================================================================

test('4. Candle 3 invalidating the pattern keeps Support TOUCHED', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  await feed(model, candleCInvalid(12));

  const latest = decisions(ctx)[decisions(ctx).length - 1].payload;
  assert.match(latest.reason, /invalidated/);
  assert.equal(latest.checks.support.status, 'TOUCHED');
  assert.equal(model.patternCandidate, null, 'pattern state cleared');
  assert.equal(model.levelTouch.support.touched, true, 'level state NOT cleared');
});

// =========================================================================
// 5. Losing trade -> still TOUCHED
// =========================================================================

test('5. a losing closed trade does not reset the level latch', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  await feed(model, candleCBuy(12)); // BUY

  await model.onPositionClosed({ _id: 'trade_1', realizedPnl: -25, reason: 'STOP_LOSS', closedAt: new Date() });

  assert.equal(model.levelTouch.support.touched, true);
  await feed(model, neutral(13));
  assert.equal(lastChecks(ctx).support.status, 'TOUCHED');
});

// =========================================================================
// 6. Latest decision with activeLevel = null -> still TOUCHED
// =========================================================================

test('6. level status is NOT derived from the latest decision activeLevel', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));
  await feed(model, candleCInvalid(12));

  for (let i = 13; i < 18; i += 1) await feed(model, neutral(i));

  const tail = decisions(ctx).slice(-5);
  tail.forEach((d) => {
    assert.equal(d.payload.activeLevel, null);
    assert.equal(d.payload.checks.support.status, 'TOUCHED');
  });
});

// =========================================================================
// 7. Resistance equivalent (BEARISH + RESISTANCE)
// =========================================================================

test('7. Resistance latches the same way and stays TOUCHED after the pattern ends', async () => {
  const { ctx, model } = await startBot({ trend: 'BEARISH' });
  await feed(model, candleABear(10));
  await feed(model, candleBBear(11));

  assert.equal(lastChecks(ctx).resistance.status, 'TOUCHED');
  assert.equal(lastChecks(ctx).resistance.level, 65000);
  assert.equal(lastChecks(ctx).support.status, 'NOT_TOUCHED', 'the untouched side is unaffected');

  await feed(model, neutral(12));
  await feed(model, neutral(13));
  assert.equal(lastChecks(ctx).resistance.status, 'TOUCHED');
});

// =========================================================================
// 8. Multi-bot isolation
// =========================================================================

test('8. Bot A touching Support never affects Bot B', async () => {
  const a = await startBot();
  const b = await startBot();

  await feed(a.model, candleA(10));
  await feed(a.model, candleBValid(11));
  await feed(b.model, neutral(10));
  await feed(b.model, neutral(11));

  assert.equal(lastChecks(a.ctx).support.status, 'TOUCHED');
  assert.equal(lastChecks(b.ctx).support.status, 'NOT_TOUCHED');
  assert.equal(b.model.levelTouch.support.touched, false);
  assert.notEqual(a.model.levelTouch, b.model.levelTouch, 'separate per-instance objects, no shared/global state');
});

test('8b. no module-global level state exists in Model002 or the shared helper', () => {
  const model = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, '..', 'utils', 'levelTouchState.js'), 'utf8');
  assert.match(model, /this\.levelTouch = readLevelTouchState\(this\.params\)/);
  assert.doesNotMatch(model, /^(let|var|const)\s+(supportTouched|resistanceTouched|levelTouch)\b/m);
  assert.doesNotMatch(helper, /^(let|var)\s+\w+\s*=/m, 'helper module holds no mutable module-level state');
});

// =========================================================================
// 9. Reload / restart preserves the state when persisted state is available
// =========================================================================

test('9. a restarted bot whose parameters carry the latch reports TOUCHED on its first decision', async () => {
  const { ctx, model } = await startBot({
    parameters: {
      supportTouched: true, supportTouchedAt: BASE, supportTouchedLevel: 60000, supportTouchedIndex: 1,
    },
  });
  const first = decisions(ctx)[0].payload;
  assert.equal(first.checks.support.status, 'TOUCHED');
  assert.equal(first.checks.support.level, 60000);
  assert.equal(first.activeLevel, null, 'no pattern is active — only the LEVEL latch survived the restart');
  assert.equal(model.levelTouch.support.index, 1);
});

test('9b. hydration replay re-derives the latch silently (no LEVEL_TOUCHED event during hydration)', async () => {
  const ctx = makeCtx();
  const model = new Model002(ctx);
  await model.onStart({
    instanceId: 'inst_hydrate', symbol: 'BTCUSD', environment: 'PAPER',
    parameters: { timeframe: '3m', trend: 'BULLISH', support: SUPPORT, resistance: RESISTANCE, historySize: 50 },
    capitalAllocation: 10000, leverage: 10, riskSettings: {},
  });

  await model.onHydrate([neutral(0), neutral(1), candleA(2), candleBValid(3)]);

  assert.equal(model.levelTouch.support.touched, true, 'replay saw the real touch');
  assert.equal(touchEvents(ctx).length, 0, 'hydration replay stays silent, exactly as before');
  assert.equal(decisions(ctx).length, 0, 'hydration still emits no decision');
});

// =========================================================================
// 10. Bot lifecycle reset follows the existing application lifecycle
// =========================================================================

test('10. only the existing trend/levels edit lifecycle clears the latch', () => {
  const touched = levelTouchState.applyLevelTouch({ timeframe: '3m' }, { side: 'SUPPORT', price: 60000, index: 1, at: BASE });
  assert.equal(touched.supportTouched, true);

  // Same-level repeat -> no write.
  assert.equal(levelTouchState.applyLevelTouch(touched, { side: 'SUPPORT', price: 60000, index: 1, at: BASE + 1 }), null);

  // A different level DOES update.
  const moved = levelTouchState.applyLevelTouch(touched, { side: 'SUPPORT', price: 59000, index: 2, at: BASE + 2 });
  assert.equal(moved.supportTouchedLevel, 59000);
  assert.equal(moved.supportTouchedIndex, 2);

  const cleared = levelTouchState.clearLevelTouchState(moved);
  assert.equal(cleared.supportTouched, undefined);
  assert.equal(cleared.supportTouchedLevel, undefined);
  assert.equal(cleared.timeframe, '3m', 'unrelated parameters are preserved');
  assert.equal(levelTouchState.clearLevelTouchState({ timeframe: '3m' }), null, 'nothing to clear -> no write');
});

test('10b. BotManager persists LEVEL_TOUCHED into the instance parameters and clears it only on a levels edit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'botManager', 'BotManager.js'), 'utf8');
  assert.match(src, /event\.eventType === 'LEVEL_TOUCHED'/);
  assert.match(src, /applyLevelTouch\(dbInstance\.parameters \|\| \{\}/);
  assert.match(src, /clearLevelTouchLatches = true;/);
  // The clear flag is set in the trend/support/resistance edit block only —
  // the same place that already sets levelsUpdatedAt.
  const editBlock = src.slice(src.indexOf('paramPatch.levelsUpdatedAt'), src.indexOf('paramPatch.levelsUpdatedAt') + 1200);
  assert.match(editBlock, /clearLevelTouchLatches = true;/);
  // No reset anywhere in the per-decision / per-candle path.
  assert.doesNotMatch(src, /clearLevelTouchState\(.*event\.payload/);
});

test('10c. Model002 never clears the level latch itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bot-models', 'model-002', 'Model002.js'), 'utf8');
  assert.doesNotMatch(src, /levelTouch\s*=\s*null/);
  assert.doesNotMatch(src, /touched:\s*false/);
});

// =========================================================================
// LEVEL STATE vs PATTERN STATE remain separate concepts
// =========================================================================

test('LEVEL state and PATTERN state are reported as separate fields', async () => {
  const { ctx, model } = await startBot();
  await feed(model, candleA(10));
  await feed(model, candleBValid(11));

  const afterB = lastChecks(ctx);
  assert.equal(afterB.support.status, 'TOUCHED');
  assert.equal(afterB.patternState, 'AWAITING_CANDLE3');

  await feed(model, candleCInvalid(12));
  const afterC = lastChecks(ctx);
  assert.equal(afterC.support.status, 'TOUCHED');
  assert.equal(afterC.patternState, 'IDLE');
});

// =========================================================================
// The pure helper's own contract
// =========================================================================

test('readLevelTouchState defaults safely for an instance that never touched anything', () => {
  const state = levelTouchState.readLevelTouchState(null);
  assert.deepEqual(state.support, { touched: false, at: null, level: null, index: null });
  assert.deepEqual(state.resistance, { touched: false, at: null, level: null, index: null });

  const fromInstance = levelTouchState.readLevelTouchState({ parameters: { resistanceTouched: true, resistanceTouchedLevel: 65000 } });
  assert.equal(fromInstance.resistance.touched, true);
  assert.equal(fromInstance.resistance.level, 65000);
  assert.equal(fromInstance.support.touched, false);
});

test('toChecksLevelStatus maps the latch to the UI contract without consulting any pattern state', () => {
  const status = levelTouchState.toChecksLevelStatus({
    support: { touched: true, level: 60000, index: 1, at: BASE },
    resistance: { touched: false, level: null, index: null, at: null },
  });
  assert.equal(status.support.status, 'TOUCHED');
  assert.equal(status.support.level, 60000);
  assert.equal(status.resistance.status, 'NOT_TOUCHED');
});
