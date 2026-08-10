'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compile } = require('./support/miniEjs');

const templatePath = path.join(__dirname, '..', 'views', 'bot-detail.ejs');
const template = fs.readFileSync(templatePath, 'utf8');
const render = compile(template);

function baseBot() {
  return {
    instanceId: 'inst_1', modelId: 'MODEL_001', symbol: 'BTCUSD', name: 'Test Bot',
    status: 'RUNNING', environment: 'PAPER', capitalAllocation: 1000,
    config: { timeframe: '5m' },
  };
}

function baseArgs(overrides = {}) {
  return Object.assign({
    title: 'Nova Trade | Test',
    bot: baseBot(),
    initialTrades: [],
    initialSignals: [],
    initialDecisions: [],
    initialDecision: null,
  }, overrides);
}

// ===========================================================
// Test A — no position
// ===========================================================

test('[Part 9] Test A: no authoritative Position -> "No Active Open Position", no legacy fallback', () => {
  const html = render(baseArgs({ currentPosition: null, performanceData: null }));
  assert.match(html, /No Active Open Position/);
  assert.doesNotMatch(html, /pos-current-price[^>]*>\$/); // no fabricated current price
});

// ===========================================================
// Test B — open position renders real fields
// ===========================================================

test('[Part 9] Test B: authoritative open Position renders real side/entry/current/PnL/TP/SL', () => {
  const currentPosition = {
    _id: 'pos1', side: 'LONG', symbol: 'BTCUSD', entryPrice: 50000, currentPrice: 51000,
    quantity: 0.1, leverage: 2, margin: 2500, unrealizedPnl: 100,
    stopLoss: 49000, takeProfit: 53000, openedAt: new Date('2026-07-29T09:00:00Z'),
    pnlPct: 4,
  };
  const html = render(baseArgs({ currentPosition, performanceData: null }));
  assert.match(html, /LONG 2x/);
  assert.match(html, /\$50000/);
  assert.match(html, /\$51000/);
  assert.match(html, /\$100\.00/);
  assert.match(html, /\$49000/); // SL
  assert.match(html, /\$53000/); // TP
  assert.doesNotMatch(html, /No Active Open Position/);
});

test('[Part 9] Test B: missing optional fields (no SL/TP) render N/A, never invented', () => {
  const currentPosition = {
    _id: 'pos2', side: 'SHORT', symbol: 'ETHUSD', entryPrice: 3000, currentPrice: 2950,
    quantity: 1, leverage: 1, margin: 3000, unrealizedPnl: 50,
    stopLoss: null, takeProfit: null, openedAt: new Date(),
    pnlPct: null,
  };
  const html = render(baseArgs({ currentPosition, performanceData: null }));
  assert.match(html, /N\/A/);
});

// ===========================================================
// Test F — Trade History uses real schema fields
// ===========================================================

test('[Part 9] Trade History: renders real Trade fields (side LONG/SHORT, realizedPnl, reason), no BUY/SELL or pnl/closeReason leftovers', () => {
  const trades = [
    { side: 'LONG', entryPrice: 50000, exitPrice: 50500, realizedPnl: 45.5, reason: 'BOT_SIGNAL', closedAt: new Date() },
    { side: 'SHORT', entryPrice: 3000, exitPrice: 3100, realizedPnl: -102.3, reason: 'STOP_LOSS', closedAt: new Date() },
  ];
  const html = render(baseArgs({ initialTrades: trades, currentPosition: null, performanceData: null }));
  assert.match(html, /\$45\.50/);
  assert.match(html, /\$-102\.30|\$102\.30/); // toFixed on negative renders "-102.30"
  assert.match(html, /BOT_SIGNAL/);
  assert.match(html, /STOP_LOSS/);
  assert.doesNotMatch(html, />OPEN</); // legacy "OPEN" closeReason fallback must be gone
});

test('[Part 9] Trade History: empty state says "No trades yet", not a blank table', () => {
  const html = render(baseArgs({ initialTrades: [], currentPosition: null, performanceData: null }));
  assert.match(html, /No trades yet/);
});

// ===========================================================
// Test G/H — Performance tab
// ===========================================================

test('[Part 9] Performance tab: renders server-computed Total Profit/Win Rate/Profit Factor/trade counts', () => {
  const performanceData = {
    totalTrades: 3, winningTrades: 2, losingTrades: 1,
    totalProfit: 25, grossProfit: 30, grossLoss: 5,
    winRate: (2 / 3) * 100, profitFactor: 6, todayProfit: 25,
  };
  const html = render(baseArgs({ performanceData, currentPosition: null }));
  assert.match(html, /\$25\.00/); // Total Profit
  assert.match(html, /66\.7%/); // Win Rate
  assert.match(html, /6\.00/); // Profit Factor
  assert.match(html, />3</); // Total Trades
  assert.match(html, />2</); // Winning Trades
  assert.match(html, />1</); // Losing Trades
});

test('[Part 9] Performance tab: zero trades render "--", never NaN or "--%%"', () => {
  const performanceData = {
    totalTrades: 0, winningTrades: 0, losingTrades: 0,
    totalProfit: 0, grossProfit: 0, grossLoss: 0,
    winRate: null, profitFactor: null, todayProfit: 0,
  };
  const html = render(baseArgs({ performanceData, currentPosition: null }));
  assert.doesNotMatch(html, /NaN/);
  assert.doesNotMatch(html, /--%%/);
});

test('[Part 9] Performance tab: all-winning-trades profit factor renders as infinity symbol, not a fake number', () => {
  const performanceData = {
    totalTrades: 2, winningTrades: 2, losingTrades: 0,
    totalProfit: 15, grossProfit: 15, grossLoss: 0,
    winRate: 100, profitFactor: Infinity, todayProfit: 15,
  };
  const html = render(baseArgs({ performanceData, currentPosition: null }));
  assert.match(html, /&#8734;/);
});

test('[Part 5] Max Drawdown renders N/A only when performanceData is genuinely absent, never a fabricated $0.00', () => {
  const html = render(baseArgs({ currentPosition: null, performanceData: null }));
  assert.match(html, /id="perf-drawdown"[^>]*>N\/A/);
});

test('[Part 5] Max Drawdown renders the real server-computed value (utils/performance.js computeMaxDrawdown) once performanceData exists, including a genuine zero', () => {
  const performanceData = {
    totalTrades: 3, winningTrades: 2, losingTrades: 1,
    totalProfit: 25, grossProfit: 30, grossLoss: 5,
    winRate: (2 / 3) * 100, profitFactor: 6, todayProfit: 25,
    maxDrawdown: 12.34,
  };
  const html = render(baseArgs({ performanceData, currentPosition: null }));
  assert.match(html, /id="perf-drawdown"[^>]*>\$12\.34/);

  const zeroDrawdown = Object.assign({}, performanceData, { maxDrawdown: 0 });
  const html2 = render(baseArgs({ performanceData: zeroDrawdown, currentPosition: null }));
  assert.match(html2, /id="perf-drawdown"[^>]*>\$0\.00/);
});

test('[Part 5] Equity Curve stays an honest "not yet wired in" empty state, never fabricated chart points', () => {
  const html = render(baseArgs({ currentPosition: null, performanceData: null }));
  assert.match(html, /id="equity-curve-container"[^>]*>[\s\S]*?renders once historical balance data is wired in/);
});

// ===========================================================
// Regression: the `performance` global-object collision (Node/browser
// expose a global `Performance` API; EJS's with(locals) would silently
// fall through to it if the local isn't actually passed).
// ===========================================================

test('[Part 9] Regression: rendering WITHOUT performanceData/currentPosition locals (legacy call shape) does not throw and shows honest empty states', () => {
  const html = render(baseArgs()); // no performanceData, no currentPosition key at all
  assert.match(html, /No Active Open Position/);
  assert.match(html, /No trades yet/);
  assert.doesNotMatch(html, /NaN/);
});

// ===========================================================
// Today's Profit must be its own value, not a re-labelled Total Profit
// ===========================================================

test("[Part 9] Today's Profit quick-stat is independently rendered from performanceData.todayProfit, decoupled from Total Profit", () => {
  const performanceData = {
    totalTrades: 5, winningTrades: 3, losingTrades: 2,
    totalProfit: 500, grossProfit: 600, grossLoss: 100,
    winRate: 60, profitFactor: 6, todayProfit: 12.5,
  };
  const html = render(baseArgs({ performanceData, currentPosition: null }));
  assert.match(html, /id="stat-today-profit"[^>]*>\s*\$12\.50/);
  assert.match(html, /id="perf-total-pnl"[^>]*>\$500\.00/);
});
