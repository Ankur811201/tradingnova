'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateTradeCommand } = require('../bot-models/TradeCommandSchema');

function baseCommand(overrides = {}) {
  return {
    commandId: 'cmd_1',
    modelId: 'model-001',
    instanceId: 'inst_1',
    symbol: 'BTCUSD',
    environment: 'PAPER',
    action: 'LONG',
    quantity: 1,
    ...overrides,
  };
}

test('accepts a well-formed LONG command', () => {
  const { valid, errors } = validateTradeCommand(baseCommand());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('accepts NO_ACTION without quantity', () => {
  const { valid } = validateTradeCommand(baseCommand({ action: 'NO_ACTION', quantity: undefined }));
  assert.equal(valid, true);
});

test('rejects missing commandId', () => {
  const cmd = baseCommand();
  delete cmd.commandId;
  const { valid, errors } = validateTradeCommand(cmd);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('commandId')));
});

test('rejects invalid environment', () => {
  const { valid, errors } = validateTradeCommand(baseCommand({ environment: 'SANDBOX' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('environment')));
});

test('rejects invalid action', () => {
  const { valid, errors } = validateTradeCommand(baseCommand({ action: 'HOLD' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('action')));
});

test('rejects LONG/SHORT with zero or missing quantity', () => {
  const zero = validateTradeCommand(baseCommand({ quantity: 0 }));
  assert.equal(zero.valid, false);

  const missing = baseCommand();
  delete missing.quantity;
  const result = validateTradeCommand(missing);
  assert.equal(result.valid, false);
});

test('rejects non-numeric stopLoss/takeProfit', () => {
  const { valid, errors } = validateTradeCommand(baseCommand({ stopLoss: 'not-a-number' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('stopLoss')));
});

test('normalizes numeric fields to Number type', () => {
  const { normalized } = validateTradeCommand(baseCommand({ quantity: '2.5', stopLoss: '100' }));
  assert.equal(typeof normalized.quantity, 'number');
  assert.equal(normalized.quantity, 2.5);
  assert.equal(normalized.stopLoss, 100);
});

test('CLOSE action does not require quantity', () => {
  const cmd = baseCommand({ action: 'CLOSE' });
  delete cmd.quantity;
  const { valid } = validateTradeCommand(cmd);
  assert.equal(valid, true);
});
