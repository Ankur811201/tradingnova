const test = require('node:test');
const assert = require('node:assert/strict');

const envPath = require.resolve('../config/env');

test('default paper and risk leverage ceilings support 200x', () => {
  delete process.env.PAPER_MAX_LEVERAGE;
  delete process.env.RISK_MAX_LEVERAGE;
  delete require.cache[envPath];
  const env = require('../config/env');
  assert.equal(env.PAPER_MAX_LEVERAGE, 200);
  assert.equal(env.RISK_MAX_LEVERAGE, 200);
});
