'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'recording', 'RecordingService.js'), 'utf8');

test('S1/R1 level recording is lifetime-one-time while trade entry/exit are repeatable', () => {
  assert.match(src, /this\.levelTouchRecordingTriggered = new Map\(\)/);
  assert.match(src, /const lifetimeKey = \(!manual && !tradeEntry && !tradeExit\)/);
  assert.match(src, /get\(instanceId\)\?\.has\(lifetimeKey\)/);
  assert.match(src, /tradeEntry \? 'TRADE_ENTRY'/);
  assert.match(src, /tradeExit \? 'TRADE_EXIT'/);
});

test('trade entry starts a recording even when no S1/R1 session is active', () => {
  assert.match(src, /if \(!session\) \{[\s\S]*?tradeEntry: true/);
});

test('trade entry recordings stop after three closed candles', () => {
  assert.match(src, /\['LEVEL_TOUCH', 'TRADE_ENTRY'\]\.includes\(session\.mode\)/);
  assert.match(src, /entryCandleCloseCount >= ENTRY_CANDLE_CLOSE_LIMIT/);
});
