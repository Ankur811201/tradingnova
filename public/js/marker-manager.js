'use strict';

/**
 * NOVA TRADE -- PART 10: render and synchronize authoritative execution
 * markers (real BUY/SELL entries + EXIT) on the candlestick series.
 *
 * Normalization (Trade/Position -> marker shape) lives in
 * execution-markers.js, NOT here -- this class only owns marker STATE:
 * keeping a deduplicated collection keyed by stable id (`entry:<positionId>`
 * / `exit:<tradeId>`, see execution-markers.js) and re-applying it to the
 * Lightweight Charts series. This is the single place marker state lives
 * for the page (see chart-manager.js, which owns one MarkerManager per
 * chart) -- bot-detail-chart.js / bot-detail-ws.js never call
 * series.setMarkers() directly.
 *
 * Historical load and every live execution both flow through the same two
 * entry points below, so "don't erase existing markers when a new one
 * arrives" and "a repeated event for the same id must not duplicate a
 * marker" are both satisfied by construction (Map keyed by id; upsert is
 * idempotent).
 */
class MarkerManager {
  constructor(candlestickSeries) {
    this.series = candlestickSeries;
    this.markersById = new Map();
  }

  /**
   * Merges a batch of normalized markers (see execution-markers.js) into
   * the current collection and re-applies. Used for the historical load on
   * page open (Phase C) -- never wipes markers that were already present
   * from an earlier call.
   */
  loadExecutionMarkers(markers) {
    (markers || []).forEach((marker) => this._upsert(marker));
    this._apply();
  }

  /**
   * Adds/updates a single normalized marker (see execution-markers.js) --
   * used for live `bot:execution` events (Phase D). Existing markers are
   * left untouched (Test F: an EXIT arriving live must not remove the
   * entry marker already on the chart).
   */
  addExecutionMarker(marker) {
    if (!this._upsert(marker)) return;
    this._apply();
  }

  _upsert(marker) {
    if (!marker || !marker.id || !Number.isFinite(marker.time)) return false;
    this.markersById.set(marker.id, marker);
    return true;
  }

  /** Lightweight Charts requires markers passed to setMarkers() sorted ascending by time. */
  _apply() {
    const sorted = Array.from(this.markersById.values()).sort((a, b) => a.time - b.time);
    this.series.setMarkers(sorted);
  }
}
window.MarkerManager = MarkerManager;
