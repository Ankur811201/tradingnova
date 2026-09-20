const test = require('node:test');
const assert = require('node:assert/strict');
const { LayerSafety, MAX_LOSSES_PER_LEVEL, MAX_SUCCESSFUL_TRADES_PER_BOT } = require('../bot-models/model-002/layerSafety');

test('fresh level safety starts all six levels at zero and one-success cap', () => {
  const s = new LayerSafety();
  assert.deepEqual(s.getState().levelLosses, {S1:0,S2:0,S3:0,R1:0,R2:0,R3:0});
  assert.equal(s.getState().successfulTradeCount, 0);
  assert.equal(s.getState().safetyStatus, 'NORMAL');
});

test('loss increments only the level that opened the trade', () => {
  const s = new LayerSafety();
  s.recordTradeOutcome('a', -10, 'S1');
  s.recordTradeOutcome('b', -10, 'R2');
  assert.equal(s.getState().levelLosses.S1, 1);
  assert.equal(s.getState().levelLosses.R2, 1);
  assert.equal(s.getState().levelLosses.S2, 0);
});

test('two losses block only that level; other levels remain available', () => {
  const s = new LayerSafety();
  s.recordTradeOutcome('a', -10, 'S1');
  const r = s.recordTradeOutcome('b', -10, {side:'SUPPORT', index:0});
  assert.equal(r.transition, 'LEVEL_BLOCKED');
  assert.equal(s.canOpenLevel('S1'), false);
  assert.equal(s.canOpenLevel('S2'), true);
  assert.equal(s.canOpenLevel('R1'), true);
  assert.equal(s.getState().levelLosses.S1, 2);
});

test('T1/T2/T3 do not count because only final Trade outcomes are recorded', () => {
  const s = new LayerSafety();
  assert.equal(s.getState().levelLosses.S1, 0);
  assert.equal(s.getState().successfulTradeCount, 0);
});

test('first positive final trade stops bot permanently', () => {
  const s = new LayerSafety();
  const r = s.recordTradeOutcome('win1', -25, 'S2', 'TARGET_4');
  assert.equal(r.outcome, 'WIN');
  assert.equal(r.transition, 'SUCCESS_STOPPED');
  assert.equal(s.getState().successfulTradeCount, 1);
  assert.equal(s.getState().safetyStatus, 'SUCCESS_STOPPED');
  assert.equal(s.canOpenLevel('R1'), false);
  assert.equal(MAX_SUCCESSFUL_TRADES_PER_BOT, 1);
});


test('T4 is a success by exit reason even when cumulative PnL is negative', () => {
  const s = new LayerSafety();
  const r = s.recordTradeOutcome('t4', -20, 'R1', 'TARGET_4');
  assert.equal(r.outcome, 'WIN');
  assert.equal(s.getState().successfulTradeCount, 1);
  assert.equal(s.getState().safetyStatus, 'SUCCESS_STOPPED');
});

test('STOP_LOSS is a loss by exit reason even if realized PnL is positive', () => {
  const s = new LayerSafety();
  const r = s.recordTradeOutcome('sl', 20, 'S3', 'STOP_LOSS');
  assert.equal(r.outcome, 'LOSS');
  assert.equal(s.getState().levelLosses.S3, 1);
});
test('break-even changes neither level losses nor success count', () => {
  const s = new LayerSafety();
  const r = s.recordTradeOutcome('be', 0, 'S3');
  assert.equal(r.outcome, 'BREAK_EVEN');
  assert.deepEqual(s.getState().levelLosses, {S1:0,S2:0,S3:0,R1:0,R2:0,R3:0});
  assert.equal(s.getState().successfulTradeCount, 0);
});

test('same trade id is never counted twice', () => {
  const s = new LayerSafety();
  s.recordTradeOutcome('dup', -10, 'R3');
  const r = s.recordTradeOutcome('dup', -10, 'R3');
  assert.equal(r.duplicate, true);
  assert.equal(s.getState().levelLosses.R3, 1);
});

test('restart replay reproduces level counters and success stop', () => {
  const trades = [
    {id:'1', pnl:-1, level:'S1', reason:'STOP_LOSS'},
    {id:'2', pnl:-1, level:'S1', reason:'STOP_LOSS'},
    {id:'3', pnl:-1, level:'S2', reason:'STOP_LOSS'},
    {id:'4', pnl:-5, level:'R1', reason:'TARGET_4'},
  ];
  const live = new LayerSafety();
  for (const t of trades) live.recordTradeOutcome(t.id,t.pnl,t.level,t.reason);
  const recovered = new LayerSafety();
  for (const t of trades) recovered.recordTradeOutcome(t.id,t.pnl,t.level,t.reason);
  assert.deepEqual(recovered.getState(), live.getState());
  assert.equal(recovered.getState().levelLosses.S1, 2);
  assert.equal(recovered.getState().levelLosses.S2, 1);
  assert.equal(recovered.getState().safetyStatus, 'SUCCESS_STOPPED');
});

test('constants remain 2 losses per level and 1 success per bot', () => {
  assert.equal(MAX_LOSSES_PER_LEVEL, 2);
  assert.equal(MAX_SUCCESSFUL_TRADES_PER_BOT, 1);
});
