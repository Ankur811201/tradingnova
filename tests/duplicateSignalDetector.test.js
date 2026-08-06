'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const DuplicateSignalDetector = require('../utils/duplicateSignalDetector');

test('first sighting of a commandId is not a duplicate', () => {
  const detector = new DuplicateSignalDetector(5000);
  assert.equal(detector.isDuplicate('cmd_1'), false);
});

test('a recorded commandId is flagged as duplicate within the window', () => {
  let now = 1000;
  const detector = new DuplicateSignalDetector(5000, () => now);
  detector.record('cmd_1');
  now += 1000; // 1s later, still within 5s window
  assert.equal(detector.isDuplicate('cmd_1'), true);
});

test('a commandId outside the window is no longer a duplicate', () => {
  let now = 1000;
  const detector = new DuplicateSignalDetector(5000, () => now);
  detector.record('cmd_1');
  now += 6000; // 6s later, outside 5s window
  assert.equal(detector.isDuplicate('cmd_1'), false);
});

test('different commandIds do not collide', () => {
  const detector = new DuplicateSignalDetector(5000);
  detector.record('cmd_1');
  assert.equal(detector.isDuplicate('cmd_2'), false);
});
