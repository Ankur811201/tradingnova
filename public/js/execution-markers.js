'use strict';

/**
 * NOVA TRADE -- PART 10: normalized execution-marker contract.
 *
 * Pure logic only (no DOM, no Socket.IO, no Lightweight Charts calls) so it
 * can be loaded either as a plain <script> in the browser (public/js/*.js
 * convention used across this project — see marker-manager.js,
 * chart-manager.js) OR required directly from a Node test file. Nothing in
 * here touches window/document except the final `window.NovaExecutionMarkers
 * = ...` assignment, which only runs when `window` actually exists.
 *
 * Source of truth for markers is EXECUTION data only:
 *   - a Position document (authoritative open position -> entry marker)
 *   - a Trade document (authoritative closed round-trip -> entry + exit)
 * Never a MODEL_001 decision (bot:decision / StrategyEvent) and never
 * BotEngineManager/TechnicalAnalysisService — see BotManager.js, which only
 * emits `bot:execution` strictly after ExecutionRouter has successfully
 * routed a command to PaperEngine/LiveEngine.
 *
 * Timestamp handling: Trade/Position `openedAt`/`closedAt` are Mongoose
 * Dates. By the time they reach the browser (JSON.stringify in the EJS
 * bootstrap, or Socket.IO's JSON payload encoding) they are ISO-8601
 * strings. `new Date(value).getTime()` handles that, a raw millisecond
 * number, and a Date instance uniformly. Lightweight Charts (see
 * candle-series.js / controllers/botInstancesController.js `getCandles`)
 * always uses Unix SECONDS, never milliseconds — every value handed to the
 * chart in this module is divided down to seconds before being returned.
 */

// UI-only duplicate of bot-models/model-001/config.js TIMEFRAMES_MS. This is
// NOT strategy logic and NOT authoritative — it exists purely so an
// execution timestamp can be anchored to the candle it occurred within on
// the chart. PART 12.2: no silent fallback — an unrecognized timeframe
// must not be misrepresented as a 5m bucket on the chart.
var TIMEFRAME_SECONDS = {
  '1m': 60,
  '3m': 3 * 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
};

function timeframeSeconds(timeframe) {
  return TIMEFRAME_SECONDS[timeframe]; // undefined for unrecognized/missing — never silently 5m
}

/** Converts a Date / ISO string / epoch-ms number to Unix seconds. Returns null if invalid. */
function toUnixSeconds(value) {
  if (value === null || value === undefined) return null;
  var ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * Anchors a raw execution time to the candle it belongs to, per the bot's
 * own timeframe (Phase F "Candle alignment" — an execution at 10:03:24 on a
 * 5m chart anchors to the 10:00:00 candle). Does not alter/return the
 * original execution time; callers that need it should keep it separately.
 */
function bucketToCandle(unixSeconds, timeframe) {
  if (!Number.isFinite(unixSeconds)) return null;
  var tf = timeframeSeconds(timeframe);
  if (!tf) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[execution-markers] unrecognized timeframe "' + timeframe + '" — cannot anchor marker to a candle');
    }
    return null;
  }
  return Math.floor(unixSeconds / tf) * tf;
}

function formatPnlLabel(realizedPnl) {
  var pnl = Number(realizedPnl);
  if (!Number.isFinite(pnl)) return 'EXIT';
  var sign = pnl >= 0 ? '+' : '-';
  return 'EXIT ' + sign + '$' + Math.abs(pnl).toFixed(2);
}

/**
 * Entry marker from an authoritative OPEN Position document. Marker id is
 * keyed by the position's own _id so a later CLOSE (which carries a Trade
 * referencing the same position id — see makeExitMarkerFromTrade) can never
 * produce a second, disconnected entry marker for the same position.
 */
function makeEntryMarkerFromPosition(position, timeframe) {
  if (!position || !position._id || !position.side || !position.entryPrice || !position.openedAt) return null;
  var execSeconds = toUnixSeconds(position.openedAt);
  var time = bucketToCandle(execSeconds, timeframe);
  if (time === null) return null;

  var isLong = position.side === 'LONG';
  return {
    id: 'entry:' + String(position._id),
    type: 'ENTRY',
    side: position.side,
    execTime: execSeconds,
    time: time,
    price: position.entryPrice,
    position: isLong ? 'belowBar' : 'aboveBar',
    color: isLong ? '#089981' : '#f23645',
    shape: isLong ? 'arrowUp' : 'arrowDown',
    text: (isLong ? 'BUY' : 'SELL') + ' @ ' + position.entryPrice,
  };
}

/**
 * Entry marker reconstructed from a CLOSED Trade document (used for
 * historical trades, and as a live safety net on CLOSE in case the LONG/
 * SHORT open event was missed). `trade.position` is the same ObjectId that
 * was used as the Position's own _id when it was opened, so the id here is
 * intentionally identical to makeEntryMarkerFromPosition's id for the same
 * round trip -- this is what lets live + historical markers dedupe safely.
 */
function makeEntryMarkerFromTrade(trade, timeframe) {
  if (!trade || !trade.position || !trade.side || !trade.entryPrice || !trade.openedAt) return null;
  var execSeconds = toUnixSeconds(trade.openedAt);
  var time = bucketToCandle(execSeconds, timeframe);
  if (time === null) return null;

  var isLong = trade.side === 'LONG';
  return {
    id: 'entry:' + String(trade.position),
    type: 'ENTRY',
    side: trade.side,
    execTime: execSeconds,
    time: time,
    price: trade.entryPrice,
    position: isLong ? 'belowBar' : 'aboveBar',
    color: isLong ? '#089981' : '#f23645',
    shape: isLong ? 'arrowUp' : 'arrowDown',
    text: (isLong ? 'BUY' : 'SELL') + ' @ ' + trade.entryPrice,
  };
}

/** Exit marker from an authoritative closed Trade document. */
function makeExitMarkerFromTrade(trade, timeframe) {
  if (!trade || !trade._id || !trade.exitPrice || !trade.closedAt) return null;
  var execSeconds = toUnixSeconds(trade.closedAt);
  var time = bucketToCandle(execSeconds, timeframe);
  if (time === null) return null;

  var hasPnl = trade.realizedPnl !== null && trade.realizedPnl !== undefined && Number.isFinite(Number(trade.realizedPnl));
  return {
    id: 'exit:' + String(trade._id),
    type: 'EXIT',
    side: trade.side || null,
    execTime: execSeconds,
    time: time,
    price: trade.exitPrice,
    realizedPnl: hasPnl ? Number(trade.realizedPnl) : null,
    position: 'aboveBar',
    color: hasPnl && Number(trade.realizedPnl) < 0 ? '#f23645' : '#089981',
    shape: 'circle',
    text: hasPnl ? formatPnlLabel(trade.realizedPnl) : 'EXIT',
  };
}

/**
 * Builds the full historical marker set for a bot-detail page load.
 * `trades` = closed Trade documents (already scoped instanceId+environment
 * server-side — see controllers/botController.js `initialTrades`).
 * `openPosition` = the current OPEN Position document, or null/undefined.
 * A trade with malformed/missing fields is silently skipped (never
 * fabricated), matching sanitizeCandle's "drop, don't repair" convention in
 * bot-detail-chart.js.
 */
function buildHistoricalMarkers(trades, openPosition, timeframe) {
  var out = [];
  (trades || []).forEach(function (trade) {
    var entry = makeEntryMarkerFromTrade(trade, timeframe);
    if (entry) out.push(entry);
    var exit = makeExitMarkerFromTrade(trade, timeframe);
    if (exit) out.push(exit);
  });

  if (openPosition) {
    var openEntry = makeEntryMarkerFromPosition(openPosition, timeframe);
    // An OPEN position has, by definition, no exit yet -- never invent one
    // (Phase G "Open position" requirement).
    if (openEntry) out.push(openEntry);
  }

  return out;
}

/**
 * Derives the marker(s) implied by a single `bot:execution` payload
 * ({ instanceId, action, position, trade }, see BotManager._emitExecutionUpdate).
 * Returns an array of 0-2 markers -- never more:
 *   - LONG/SHORT open: `position` is the freshly opened OPEN position -> [entry]
 *   - CLOSE: `position` is null (already closed), `trade` is the just-closed
 *     Trade -> [entry (safety net, same id as the original open marker),
 *     exit]
 */
function deriveLiveMarkers(executionPayload, timeframe) {
  var out = [];
  if (!executionPayload) return out;

  if (executionPayload.position) {
    var entry = makeEntryMarkerFromPosition(executionPayload.position, timeframe);
    if (entry) out.push(entry);
  }

  if (executionPayload.trade) {
    var tradeEntry = makeEntryMarkerFromTrade(executionPayload.trade, timeframe);
    if (tradeEntry) out.push(tradeEntry);
    var exit = makeExitMarkerFromTrade(executionPayload.trade, timeframe);
    if (exit) out.push(exit);
  }

  return out;
}

var NovaExecutionMarkers = {
  toUnixSeconds: toUnixSeconds,
  bucketToCandle: bucketToCandle,
  makeEntryMarkerFromPosition: makeEntryMarkerFromPosition,
  makeEntryMarkerFromTrade: makeEntryMarkerFromTrade,
  makeExitMarkerFromTrade: makeExitMarkerFromTrade,
  buildHistoricalMarkers: buildHistoricalMarkers,
  deriveLiveMarkers: deriveLiveMarkers,
};

if (typeof window !== 'undefined') {
  window.NovaExecutionMarkers = NovaExecutionMarkers;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NovaExecutionMarkers;
}
