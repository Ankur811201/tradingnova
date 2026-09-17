'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { normalizeTargetExitInput } = require('../utils/targetExit');

test('4-target LONG plan calculates T4 remaining and switches to 3m', () => {
  const plan = normalizeTargetExitInput({
    enabled: true,
    targets: [
      { price: 7300, exitPercent: 30 },
      { price: 7400, exitPercent: 40 },
      { price: 7500, exitPercent: 20 },
      { price: 7600 },
    ],
  }, 'LONG', 7200, 100, '1m');

  assert.deepEqual(plan.targets.map(t => t.exitPercent), [30, 40, 20, 10]);
  assert.deepEqual(plan.targets.map(t => t.quantity), [30, 40, 20, 10]);
  assert.equal(plan.activeTimeframe, '3m');
  assert.equal(plan.confirmationTimeframe, '3m');
});

test('4-target SHORT plan requires descending prices', () => {
  assert.doesNotThrow(() => normalizeTargetExitInput({
    enabled: true,
    targets: [
      { price: 7500, exitPercent: 30 },
      { price: 7400, exitPercent: 40 },
      { price: 7300, exitPercent: 20 },
      { price: 7200 },
    ],
  }, 'SHORT', 7600, 100, '3m'));
});

test('target percentages and direction are validated', () => {
  assert.throws(() => normalizeTargetExitInput({
    enabled: true,
    targets: [
      { price: 7300, exitPercent: 50 },
      { price: 7400, exitPercent: 40 },
      { price: 7500, exitPercent: 20 },
      { price: 7600 },
    ],
  }, 'LONG', 7200, 100, '1m'));

  assert.throws(() => normalizeTargetExitInput({
    enabled: true,
    targets: [
      { price: 7300, exitPercent: 30 },
      { price: 7400, exitPercent: 40 },
      { price: 7500, exitPercent: 20 },
      { price: 7600 },
    ],
  }, 'SHORT', 7700, 100, '1m'));
});

test('Create New Bot page does not contain Target Exit UI', () => {
  const bots = fs.readFileSync(require('path').join(__dirname, '../views/bots.ejs'), 'utf8');
  assert.equal(/Target Exit/i.test(bots), false);
});

test('Target Exit section is below Control Center on Bot Details', () => {
  const detail = fs.readFileSync(require('path').join(__dirname, '../views/bot-detail.ejs'), 'utf8');
  assert.ok(detail.indexOf('SECTION 2: CONTROL CENTER') < detail.indexOf('TARGET EXIT: POSITION-LEVEL CONTROL'));
});
