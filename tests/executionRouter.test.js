'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const executionRouter = require('../services/execution/ExecutionRouter');

test('PAPER environment routes to PAPER engine', () => {
  assert.equal(executionRouter.decideEngine('PAPER'), 'PAPER');
});

test('LIVE environment routes to LIVE engine', () => {
  assert.equal(executionRouter.decideEngine('LIVE'), 'LIVE');
});

test('unknown environment throws rather than falling back to a default', () => {
  assert.throws(() => executionRouter.decideEngine('SANDBOX'));
  assert.throws(() => executionRouter.decideEngine(undefined));
  assert.throws(() => executionRouter.decideEngine(null));
});
