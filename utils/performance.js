'use strict';

/**
 * Pure trading-performance math functions. No I/O, no DB — mirrors the
 * separation established by utils/pnl.js so these can be unit tested in
 * isolation and reused consistently by any controller/service that needs
 * to summarize a set of authoritative (closed) Trade documents.
 *
 * NOVA TRADE -- PART 9: these functions operate ONLY on real Trade records
 * (each with a numeric `realizedPnl` and a `closedAt` Date, matching
 * models/Trade.js). They never fabricate values; callers are responsible
 * for passing authoritative data (e.g. `Trade.find({ instanceId, ... })`).
 *
 * Day-boundary convention: "today" is defined using the server's local
 * midnight (`new Date(); setHours(0,0,0,0)`), matching the existing
 * convention already used elsewhere in the app for day-scoped trading
 * calculations (see RiskEngine._computeInstanceDailyLoss). This file
 * reuses that exact convention rather than introducing a second one.
 */

function startOfLocalDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Summarizes a list of closed Trade documents (plain objects or Mongoose
 * docs) into the Performance tab metrics.
 *
 * @param {Array<{realizedPnl: number}>} trades
 * @returns {{
 *   totalTrades: number, winningTrades: number, losingTrades: number,
 *   totalProfit: number, grossProfit: number, grossLoss: number,
 *   winRate: number|null, profitFactor: number|null
 * }}
 */
function computePerformance(trades) {
  const list = Array.isArray(trades) ? trades : [];

  let totalProfit = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let countedTrades = 0;

  for (const t of list) {
    const pnl = Number(t && t.realizedPnl);
    if (!Number.isFinite(pnl)) continue; // never invent a value for malformed data
    countedTrades += 1;
    totalProfit += pnl;
    if (pnl > 0) {
      grossProfit += pnl;
      winningTrades += 1;
    } else if (pnl < 0) {
      grossLoss += Math.abs(pnl);
      losingTrades += 1;
    }
    // pnl === 0 counts toward totalTrades but is neither a win nor a loss.
  }

  const totalTrades = countedTrades;

  // Win rate: undefined (null -> "--") with zero trades, never NaN/Infinity.
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : null;

  // Profit factor: undefined with zero trades or zero gross profit AND zero
  // gross loss. If there are wins but no losses at all, the ratio is
  // mathematically unbounded (Infinity) — real, not misleading, so it is
  // surfaced as-is and left to the caller/view to render as "∞".
  let profitFactor = null;
  if (grossLoss > 0) {
    profitFactor = grossProfit / grossLoss;
  } else if (grossProfit > 0) {
    profitFactor = Infinity;
  }

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    totalProfit,
    grossProfit,
    grossLoss,
    winRate,
    profitFactor,
    maxDrawdown: computeMaxDrawdown(list),
  };
}

/**
 * PART 14 -- PHASE H: Max Drawdown, computed from this instance's own real
 * closed-Trade history -- the largest peak-to-trough drop in cumulative
 * realizedPnl, in the same USD units as Total Profit. Previously a
 * hardcoded "N/A" in the Performance tab (see views/bot-detail.ejs); this
 * replaces that placeholder with an authoritative value derived the same
 * way computePerformance derives everything else -- never fabricated.
 *
 * Trades are re-sorted ascending by closedAt here regardless of the order
 * the caller passed them in (controllers/botController.js queries newest
 * first), since a drawdown curve is only meaningful walked forward in
 * time. Returns 0 (not null) when nothing has dropped below a prior peak
 * yet -- that is a real "no drawdown", not an "unknown" state.
 */
function computeMaxDrawdown(trades) {
  const list = (Array.isArray(trades) ? trades : [])
    .filter((t) => t && Number.isFinite(Number(t && t.realizedPnl)) && t.closedAt)
    .slice()
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of list) {
    cumulative += Number(t.realizedPnl);
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return maxDrawdown;
}

/**
 * Sums realizedPnl for trades whose closedAt falls within "today" (server
 * local day, see startOfLocalDay). Open/unrealized PnL is intentionally
 * excluded — Today's Profit represents realized results only.
 *
 * @param {Array<{realizedPnl: number, closedAt: Date|string}>} trades
 * @param {Date} now
 */
function computeTodayProfit(trades, now = new Date()) {
  const list = Array.isArray(trades) ? trades : [];
  const todayStart = startOfLocalDay(now);

  let total = 0;
  for (const t of list) {
    if (!t || !t.closedAt) continue;
    const closedAt = new Date(t.closedAt);
    if (Number.isNaN(closedAt.getTime())) continue;
    if (closedAt < todayStart) continue;
    const pnl = Number(t.realizedPnl);
    if (!Number.isFinite(pnl)) continue;
    total += pnl;
  }
  return total;
}

module.exports = { computePerformance, computeTodayProfit, computeMaxDrawdown, startOfLocalDay };
