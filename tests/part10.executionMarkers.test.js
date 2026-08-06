'use strict';

/**
 * Part 10 — unit tests for the normalized execution-marker contract
 * (public/js/execution-markers.js).
 *
 * This module is pure logic (no DOM/Socket.IO/Lightweight Charts calls),
 * required directly here via its `module.exports` guard, same convention
 * as any other Node unit under tests/. It is NOT a substitute for the
 * required browser verification of the full chart (see FINAL REPORT) —
 * MarkerManager/ChartManager/Lightweight Charts integration and the live
 * Socket.IO -> marker path can only be exercised in a real browser.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  toUnixSeconds,
  bucketToCandle,
  makeEntryMarkerFromPosition,
  makeEntryMarkerFromTrade,
  makeExitMarkerFromTrade,
  buildHistoricalMarkers,
  deriveLiveMarkers,
} = require('../public/js/execution-markers.js');

// ---------------------------------------------------------------------
// Timestamp normalization / candle bucketing
// ---------------------------------------------------------------------

test('[Part 10] toUnixSeconds converts ISO strings and Date instances to Unix seconds', () => {
  const iso = '2026-01-01T10:03:24.000Z';
  const seconds = toUnixSeconds(iso);
  assert.equal(seconds, Math.floor(new Date(iso).getTime() / 1000));
  assert.equal(toUnixSeconds(new Date(iso)), seconds);
});

test('[Part 10] toUnixSeconds returns null for invalid input, never fabricates a time', () => {
  assert.equal(toUnixSeconds(null), null);
  assert.equal(toUnixSeconds(undefined), null);
  assert.equal(toUnixSeconds('not-a-date'), null);
});

test('[Part 10] Test I — bucketToCandle anchors a 10:03:24 execution to the 10:00:00 candle on a 5m timeframe', () => {
  const execSeconds = toUnixSeconds('2026-01-01T10:03:24.000Z');
  const anchored = bucketToCandle(execSeconds, '5m');
  const expected = toUnixSeconds('2026-01-01T10:00:00.000Z');
  assert.equal(anchored, expected);
});

test('[Part 10] bucketToCandle respects the timeframe (1h groups to the hour)', () => {
  const execSeconds = toUnixSeconds('2026-01-01T10:47:00.000Z');
  const anchored = bucketToCandle(execSeconds, '1h');
  const expected = toUnixSeconds('2026-01-01T10:00:00.000Z');
  assert.equal(anchored, expected);
});

// ---------------------------------------------------------------------
// Test A/B — entry marker direction from real side, never inferred
// ---------------------------------------------------------------------

test('[Part 10] Test A — a real LONG position produces a BUY entry marker', () => {
  const position = {
    _id: 'pos1', side: 'LONG', entryPrice: 63720.5, openedAt: '2026-01-01T10:03:24.000Z',
  };
  const marker = makeEntryMarkerFromPosition(position, '5m');
  assert.equal(marker.id, 'entry:pos1');
  assert.equal(marker.type, 'ENTRY');
  assert.equal(marker.side, 'LONG');
  assert.equal(marker.shape, 'arrowUp');
  assert.equal(marker.position, 'belowBar');
  assert.match(marker.text, /^BUY/);
});

test('[Part 10] Test B — a real SHORT position produces a SELL entry marker', () => {
  const position = {
    _id: 'pos2', side: 'SHORT', entryPrice: 63720.5, openedAt: '2026-01-01T10:03:24.000Z',
  };
  const marker = makeEntryMarkerFromPosition(position, '5m');
  assert.equal(marker.side, 'SHORT');
  assert.equal(marker.shape, 'arrowDown');
  assert.equal(marker.position, 'aboveBar');
  assert.match(marker.text, /^SELL/);
});

test('[Part 10] entry marker direction never infers side from profit/loss — only from the real `side` field', () => {
  // A SHORT position that is currently deeply profitable must still render
  // as a SELL/arrowDown entry marker; direction comes only from `side`.
  const position = {
    _id: 'pos3', side: 'SHORT', entryPrice: 100, currentPrice: 10, openedAt: '2026-01-01T00:00:00.000Z',
  };
  const marker = makeEntryMarkerFromPosition(position, '5m');
  assert.equal(marker.side, 'SHORT');
  assert.equal(marker.shape, 'arrowDown');
});

// ---------------------------------------------------------------------
// Test C — closed trade produces entry + exit, with realized PnL label
// ---------------------------------------------------------------------

test('[Part 10] Test C — a closed LONG Trade produces an entry marker and a PnL-labeled EXIT marker', () => {
  const trade = {
    _id: 'trade1', position: 'pos1', side: 'LONG',
    entryPrice: 63720.5, exitPrice: 64200, realizedPnl: 12.4,
    openedAt: '2026-01-01T10:03:24.000Z', closedAt: '2026-01-01T11:00:00.000Z',
  };
  const entry = makeEntryMarkerFromTrade(trade, '5m');
  const exit = makeExitMarkerFromTrade(trade, '5m');

  // Same id as the original open-time entry marker (pos1) -- dedup key.
  assert.equal(entry.id, 'entry:pos1');
  assert.equal(exit.id, 'exit:trade1');
  assert.equal(exit.type, 'EXIT');
  assert.equal(exit.text, 'EXIT +$12.40');
  assert.equal(exit.color, '#089981');
});

test('[Part 10] a losing exit is labeled with a minus sign and colored red', () => {
  const trade = {
    _id: 'trade2', position: 'pos2', side: 'SHORT',
    entryPrice: 100, exitPrice: 105.1, realizedPnl: -5.1,
    openedAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-01T00:05:00.000Z',
  };
  const exit = makeExitMarkerFromTrade(trade, '5m');
  assert.equal(exit.text, 'EXIT -$5.10');
  assert.equal(exit.color, '#f23645');
});

test('[Part 10] realized PnL is only shown when the Trade record actually provides it — never computed here', () => {
  const trade = {
    _id: 'trade3', position: 'pos3', side: 'LONG',
    entryPrice: 100, exitPrice: 110, realizedPnl: undefined,
    openedAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-01T00:05:00.000Z',
  };
  const exit = makeExitMarkerFromTrade(trade, '5m');
  assert.equal(exit.text, 'EXIT');
  assert.equal(exit.realizedPnl, null);
});

// ---------------------------------------------------------------------
// Test D-equivalent — malformed/missing execution data never fabricates a marker
// ---------------------------------------------------------------------

test('[Part 10] Test D — no position/trade data produces no marker (rejected/undecided commands never appear)', () => {
  assert.equal(makeEntryMarkerFromPosition(null, '5m'), null);
  assert.equal(makeEntryMarkerFromTrade(null, '5m'), null);
  assert.equal(makeExitMarkerFromTrade(null, '5m'), null);
  assert.deepEqual(deriveLiveMarkers(null, '5m'), []);
  assert.deepEqual(deriveLiveMarkers({ instanceId: 'x', action: 'LONG', position: null, trade: null }, '5m'), []);
});

test('[Part 10] an incomplete position/trade document (missing required field) is skipped, not repaired', () => {
  assert.equal(makeEntryMarkerFromPosition({ _id: 'p', side: 'LONG' }, '5m'), null); // no entryPrice/openedAt
  assert.equal(makeExitMarkerFromTrade({ _id: 't', side: 'LONG', entryPrice: 1 }, '5m'), null); // no exitPrice/closedAt
});

// ---------------------------------------------------------------------
// Test E/F — live entry, live exit, existing markers preserved
// ---------------------------------------------------------------------

test('[Part 10] Test E — a live LONG/SHORT open bot:execution payload derives exactly one entry marker', () => {
  const payload = {
    instanceId: 'inst1', action: 'LONG',
    position: { _id: 'posLive', side: 'LONG', entryPrice: 50000, openedAt: '2026-01-01T10:00:00.000Z' },
    trade: null,
  };
  const markers = deriveLiveMarkers(payload, '5m');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].id, 'entry:posLive');
  assert.equal(markers[0].type, 'ENTRY');
});

test('[Part 10] Test F — a live CLOSE bot:execution payload derives an entry safety-net marker plus the exit marker, same entry id as the original open', () => {
  const payload = {
    instanceId: 'inst1', action: 'CLOSE',
    position: null,
    trade: {
      _id: 'tradeLive', position: 'posLive', side: 'LONG',
      entryPrice: 50000, exitPrice: 50800, realizedPnl: 40,
      openedAt: '2026-01-01T10:00:00.000Z', closedAt: '2026-01-01T10:15:00.000Z',
    },
  };
  const markers = deriveLiveMarkers(payload, '5m');
  assert.equal(markers.length, 2);
  const entry = markers.find((m) => m.type === 'ENTRY');
  const exit = markers.find((m) => m.type === 'EXIT');
  assert.equal(entry.id, 'entry:posLive'); // matches Test E's marker id -> dedup, entry marker is not duplicated
  assert.equal(exit.id, 'exit:tradeLive');
});

// ---------------------------------------------------------------------
// Phase G — open position: entry marker only, no fabricated exit
// ---------------------------------------------------------------------

test('[Part 10] Phase G — an open position with no closed trades yields exactly one entry marker, no exit', () => {
  const markers = buildHistoricalMarkers(
    [],
    { _id: 'openPos', side: 'LONG', entryPrice: 50000, openedAt: '2026-01-01T10:00:00.000Z' },
    '5m'
  );
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'ENTRY');
});

// ---------------------------------------------------------------------
// Phase C/G — full historical reconstruction from Trade history alone
// ---------------------------------------------------------------------

test('[Part 10] buildHistoricalMarkers reconstructs entry+exit for every closed trade, plus an entry for the open position', () => {
  const trades = [
    {
      _id: 'tA', position: 'pA', side: 'LONG', entryPrice: 100, exitPrice: 110, realizedPnl: 10,
      openedAt: '2026-01-01T09:00:00.000Z', closedAt: '2026-01-01T09:30:00.000Z',
    },
    {
      _id: 'tB', position: 'pB', side: 'SHORT', entryPrice: 200, exitPrice: 190, realizedPnl: 10,
      openedAt: '2026-01-01T10:00:00.000Z', closedAt: '2026-01-01T10:30:00.000Z',
    },
  ];
  const openPosition = { _id: 'pC', side: 'LONG', entryPrice: 300, openedAt: '2026-01-01T11:00:00.000Z' };

  const markers = buildHistoricalMarkers(trades, openPosition, '5m');
  assert.equal(markers.length, 5); // 2 trades x (entry+exit) + 1 open entry

  const ids = markers.map((m) => m.id).sort();
  assert.deepEqual(ids, ['entry:pA', 'entry:pB', 'entry:pC', 'exit:tA', 'exit:tB'].sort());
});

test('[Part 10] buildHistoricalMarkers returns an empty list for no trades and no open position', () => {
  assert.deepEqual(buildHistoricalMarkers([], null, '5m'), []);
  assert.deepEqual(buildHistoricalMarkers(undefined, undefined, '5m'), []);
});
