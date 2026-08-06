'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { novaToDeltaSymbol, deltaToNovaSymbol, UnsupportedSymbolError } = require('../services/marketData/symbolMap');

test('identity mapping by default: Nova symbol equals Delta symbol', () => {
  assert.equal(novaToDeltaSymbol('BTCUSD'), 'BTCUSD');
  assert.equal(novaToDeltaSymbol('ETHUSD'), 'ETHUSD');
});

test('reverse mapping is also identity by default', () => {
  assert.equal(deltaToNovaSymbol('BTCUSD'), 'BTCUSD');
});

test('deltaToNovaSymbol passes through an unmapped/falsy symbol unchanged', () => {
  assert.equal(deltaToNovaSymbol(''), '');
  assert.equal(deltaToNovaSymbol(null), null);
});

test('novaToDeltaSymbol rejects empty/non-string input', () => {
  assert.throws(() => novaToDeltaSymbol(''));
  assert.throws(() => novaToDeltaSymbol(null));
  assert.throws(() => novaToDeltaSymbol(undefined));
  assert.throws(() => novaToDeltaSymbol(123));
});

test('UnsupportedSymbolError carries a clear message and 400 status', () => {
  const err = new UnsupportedSymbolError('FAKEUSD', 'no such Delta product');
  assert.match(err.message, /FAKEUSD/);
  assert.match(err.message, /no such Delta product/);
  assert.equal(err.code, 'UNSUPPORTED_SYMBOL');
  assert.equal(err.status, 400);
});
