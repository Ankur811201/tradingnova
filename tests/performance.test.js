'use strict';

/**
 * Part 9 — pure unit tests for utils/performance.js. No DB required; these
 * exercise the exact formulas the Performance tab and Today's Profit stat
 * rely on (see controllers/botController.js).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computePerformance, computeTodayProfit, startOfLocalDay } = require('../utils/performance');

// ===========================================================
// Test G — Win rate
// ===========================================================

test('[Part 9] computePerformance: win rate for +10/-5/+20 example', () => {
  const trades = [{ realizedPnl: 10 }, { realizedPnl: -5 }, { realizedPnl: 20 }];
  const perf = computePerformance(trades);
  assert.equal(perf.totalTrades, 3);
  assert.equal(perf.winningTrades, 2);
  assert.equal(perf.losingTrades, 1);
  assert.ok(Math.abs(perf.winRate - (2 / 3) * 100) < 1e-9);
  assert.equal(perf.totalProfit, 25);
});

// ===========================================================
// Test H — Profit factor
// ===========================================================

test('[Part 9] computePerformance: profit factor for gross 30 / gross loss 5 == 6', () => {
  const trades = [{ realizedPnl: 10 }, { realizedPnl: 20 }, { realizedPnl: -5 }];
  const perf = computePerformance(trades);
  assert.equal(perf.grossProfit, 30);
  assert.equal(perf.grossLoss, 5);
  assert.equal(perf.profitFactor, 6);
});

test('[Part 9] computePerformance: zero trades -> null winRate/profitFactor, never NaN', () => {
  const perf = computePerformance([]);
  assert.equal(perf.totalTrades, 0);
  assert.equal(perf.winRate, null);
  assert.equal(perf.profitFactor, null);
  assert.equal(Number.isNaN(perf.winRate), false);
});

test('[Part 9] computePerformance: zero losing trades -> profitFactor is Infinity, not misleading zero/undefined', () => {
  const perf = computePerformance([{ realizedPnl: 10 }, { realizedPnl: 5 }]);
  assert.equal(perf.grossLoss, 0);
  assert.equal(perf.profitFactor, Infinity);
});

test('[Part 9] computePerformance: all losing trades -> profitFactor is 0 (grossProfit 0 / grossLoss > 0)', () => {
  const perf = computePerformance([{ realizedPnl: -10 }, { realizedPnl: -5 }]);
  assert.equal(perf.grossProfit, 0);
  assert.equal(perf.profitFactor, 0);
  assert.equal(perf.winRate, 0);
});

test('[Part 9] computePerformance: malformed/missing realizedPnl entries are skipped, not treated as zero-value trades', () => {
  const perf = computePerformance([{ realizedPnl: 10 }, { realizedPnl: 'garbage' }, {}, { realizedPnl: NaN }]);
  assert.equal(perf.totalTrades, 1);
  assert.equal(perf.totalProfit, 10);
});

test('[Part 9] computePerformance: breakeven trade (realizedPnl === 0) counts toward totalTrades but not win/loss', () => {
  const perf = computePerformance([{ realizedPnl: 0 }, { realizedPnl: 10 }]);
  assert.equal(perf.totalTrades, 2);
  assert.equal(perf.winningTrades, 1);
  assert.equal(perf.losingTrades, 0);
});

// ===========================================================
// Test F — Today's Profit
// ===========================================================

test("[Part 9] computeTodayProfit: only counts trades closed within today's local window", () => {
  const now = new Date('2026-07-29T15:00:00');
  const todayStart = startOfLocalDay(now);

  const trades = [
    { realizedPnl: 100, closedAt: new Date('2026-07-29T08:00:00') }, // today
    { realizedPnl: 50, closedAt: new Date('2026-07-29T14:59:59') }, // today
    { realizedPnl: -30, closedAt: new Date('2026-07-28T23:59:59') }, // yesterday, excluded
  ];

  const result = computeTodayProfit(trades, now);
  assert.equal(result, 150);
  assert.ok(todayStart <= new Date('2026-07-29T08:00:00'));
});

test('[Part 9] computeTodayProfit: excludes trades from previous days', () => {
  const now = new Date('2026-07-29T10:00:00');
  const trades = [
    { realizedPnl: 100, closedAt: new Date('2026-07-28T10:00:00') },
    { realizedPnl: 50, closedAt: new Date('2026-07-27T10:00:00') },
  ];
  assert.equal(computeTodayProfit(trades, now), 0);
});

test('[Part 9] computeTodayProfit: trades with no closedAt are ignored (open positions never counted)', () => {
  const now = new Date('2026-07-29T10:00:00');
  const trades = [{ realizedPnl: 500, closedAt: null }];
  assert.equal(computeTodayProfit(trades, now), 0);
});
