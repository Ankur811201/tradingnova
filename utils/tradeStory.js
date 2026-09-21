'use strict';

/**
 * Pure "Live Trade Story" timeline builder. No I/O, no DB — mirrors the
 * separation established by utils/performance.js and utils/pnl.js.
 *
 * NOVA TRADE -- PART 15 PHASE B/STEP 5: replaces the legacy `Signal`-backed
 * timeline (dead collection, zero writers since Part 7 -- see
 * controllers/botController.js) with a real narrative built strictly from
 * data already authoritative elsewhere in the app:
 *   - StrategyEvent (eventType 'DECISION') -> BUY/SELL signal steps
 *   - Trade (closed round-trips)           -> Position Opened + Position
 *                                              Closed steps
 *   - Position (current OPEN position)     -> a trailing Position Opened
 *                                              step with no close yet
 *
 * Deliberately takes already-queried arrays (the same `trades`,
 * `decisionEvents`, `currentPosition` locals botController.js already loads
 * for the Trade History / Decision History / Position card) instead of
 * running a new Mongo query, per the Part 15 Phase B "No new Mongo query"
 * requirement. Never fabricates a step: an event with a missing/invalid
 * timestamp is dropped, not guessed.
 */

function toTime(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {object} sources
 * @param {Array} sources.decisionEvents - StrategyEvent docs (eventType DECISION)
 * @param {Array} sources.trades - closed Trade docs
 * @param {object|null} sources.currentPosition - open Position doc, or null
 * @param {number} limit - max steps returned (most recent first, trimmed)
 * @returns {Array<{type:string,label:string,detail:string,at:string,tone:string}>}
 *   Chronological ascending (oldest first) — matches the existing timeline
 *   markup convention (see views/bot-detail.ejs, previously `.reverse()`
 *   on initialSignals).
 */
function buildTradeStory({ decisionEvents, trades, currentPosition, positions } = {}, limit = 10) {
  const steps = [];

  // Target Exit execution events are authoritative execution events.
  // T1-T3 partial exits live on Position.targetExit.events because they do
  // not create Trade documents; T4 is the final close and may also have a
  // Trade record. Keep the event itself in the story so the user can see
  // exactly which target executed and its realized PnL.
  (positions || []).forEach((position) => {
    const events = position && position.targetExit && Array.isArray(position.targetExit.events)
      ? position.targetExit.events : [];
    events.forEach((ev) => {
      if (!ev || ev.type !== 'TARGET_EXIT') return;
      const at = toTime(ev.recordedAt || ev.candleStart);
      if (at === null) return;
      const ti = Number(ev.targetIndex);
      const pnl = Number(ev.realizedPnl);
      const isFinal = ti === 4;
      steps.push({
        type: isFinal ? 'POSITION_CLOSED' : 'TARGET_PARTIAL_EXIT',
        label: isFinal ? 'Position Closed' : 'Partial Exit',
        detail: `TARGET_${ti} · ${Number.isFinite(pnl) ? `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}` : 'EXECUTED'}${!isFinal && ev.exitPercent != null ? ` · ${Number(ev.exitPercent)}% closed` : ''}`,
        at,
        tone: pnl >= 0 ? 'profit' : 'loss',
        storyKey: `TARGET_EXIT:${position._id || position.positionId || ''}:${ti}`,
      });
    });
  });

  (decisionEvents || []).forEach((ev) => {
    const payload = ev && ev.payload;
    const decision = payload && payload.decision;
    if (decision !== 'BUY' && decision !== 'SELL') return; // WAIT is noise, not a story beat
    const at = toTime(ev.at);
    if (at === null) return;
    steps.push({
      type: 'SIGNAL',
      label: decision,
      detail: payload.reason || '',
      at,
      tone: decision === 'BUY' ? 'buy' : 'sell',
    });
  });

  (trades || []).forEach((trade) => {
    if (!trade) return;
    const openedAt = toTime(trade.openedAt);
    if (openedAt !== null && trade.side && trade.entryPrice != null) {
      steps.push({
        type: 'POSITION_OPENED',
        label: 'Position Open',
        detail: `${trade.side} @ $${trade.entryPrice}`,
        at: openedAt,
        tone: trade.side === 'LONG' ? 'buy' : 'sell',
      });
    }
    const closedAt = toTime(trade.closedAt);
    if (closedAt !== null && Number.isFinite(Number(trade.realizedPnl))) {
      const pnl = Number(trade.realizedPnl);
      steps.push({
        type: 'POSITION_CLOSED',
        label: 'Position Closed',
        detail: `${trade.reason || 'CLOSE'} · ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`,
        at: closedAt,
        tone: pnl >= 0 ? 'profit' : 'loss',
        storyKey: trade.reason === 'TARGET_4' ? `TARGET_EXIT:${trade.position || ''}:4` : undefined,
      });
    }
  });

  if (currentPosition) {
    const openedAt = toTime(currentPosition.openedAt);
    if (openedAt !== null && currentPosition.side && currentPosition.entryPrice != null) {
      steps.push({
        type: 'POSITION_OPENED',
        label: 'Position Open',
        detail: `${currentPosition.side} @ $${currentPosition.entryPrice} (open)`,
        at: openedAt,
        tone: currentPosition.side === 'LONG' ? 'buy' : 'sell',
      });
    }
  }

  steps.sort((a, b) => a.at - b.at);
  const deduped = [];
  const seen = new Set();
  for (const step of steps) {
    const key = step.storyKey || `${step.type}:${step.at}:${step.label}:${step.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(step);
  }
  return deduped.slice(-limit);
}

module.exports = { buildTradeStory };
