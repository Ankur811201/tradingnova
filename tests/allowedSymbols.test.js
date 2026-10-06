'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// This test checks the source-level default policy without requiring a live
// Delta connection or MongoDB. The deployed .env can still explicitly
// override RISK_ALLOWED_SYMBOLS.
test('default trading-pair allow-list contains all four requested pairs', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../config/env.js'), 'utf8');
  assert.match(source, /BTCUSD,ETHUSD,XAUTUSD,SOLUSD/);
});
