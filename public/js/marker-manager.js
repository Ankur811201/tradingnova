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
    // Pattern-role markers are kept separately from authoritative execution
    // markers. Only successful TRIGGERED groups remain permanently; active
    // groups can be removed without ever deleting BUY/SELL/EXIT markers.
    this.patternMarkersById = new Map();
    this.targetMarkersById = new Map();
    this.stopHuntMarkersById = new Map();
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

  /**
   * Merge MODEL_002 pattern-role markers into chart state. Successful
   * TRIGGERED groups are retained permanently; active groups are removable.
   * Pattern markers are historical evidence, not active-trade state: adding
   * a new decision must never erase an older Candle 1/2/3/... marker.
   */
  setPatternMarkers(markers) {
    (markers || []).forEach((marker) => {
      if (!marker || !marker.id || !Number.isFinite(marker.time)) return;
      this.patternMarkersById.set(marker.id, marker);
    });
    this._apply();
  }

  /** Remove one still-active MODEL_002 pattern group after invalidation. */
  removePatternMarkersByPatternId(patternId) {
    if (!patternId) return;
    const prefix = `model002-pattern:${patternId}:`;
    let changed = false;
    for (const id of this.patternMarkersById.keys()) {
      if (id.indexOf(prefix) === 0) {
        this.patternMarkersById.delete(id);
        changed = true;
      }
    }
    if (changed) this._apply();
  }

  /**
   * Historical Target confirmation/exit markers (CT1/CT2/CT3/Tn EXIT).
   *
   * IMPORTANT: this is a MERGE, not a replace. Historical candle loading is
   * asynchronous. A live bot:target event can arrive while that request is
   * in flight; replacing the map here would silently erase that live marker.
   */
  setTargetMarkers(markers) {
    (markers || []).forEach((marker) => {
      if (!marker || !marker.id || !Number.isFinite(marker.time)) return;
      this.targetMarkersById.set(marker.id, marker);
    });
    this._apply();
  }

  addTargetMarker(marker) {
    if (!marker || !marker.id || !Number.isFinite(marker.time)) return;
    this.targetMarkersById.set(marker.id, marker);
    this._apply();
  }

  /** MODEL_002 opposite stop-hunt markers (STOP HUNT / STOP END). */
  loadStopHuntMarkers(markers) {
    (markers || []).forEach((marker) => {
      if (!marker || !marker.id || !Number.isFinite(marker.time)) return;
      this.stopHuntMarkersById.set(marker.id, marker);
    });
    this._apply();
  }

  addStopHuntMarker(marker) {
    if (!marker || !marker.id || !Number.isFinite(marker.time)) return;
    this.stopHuntMarkersById.set(marker.id, marker);
    this._apply();
  }

  /**
   * Pattern markers are permanent for the page/session. This method is kept
   * only for API compatibility; normal decision updates must never call it.
   */
  clearPatternMarkers() {
    // Intentionally do nothing: Candle 1/Candle 2/Candle 3/... are
    // permanent historical chart markers and must survive trade start/end.
  }

  /** Lightweight Charts requires markers passed to setMarkers() sorted ascending by time. */
  _apply() {
    const combined = Array.from(this.markersById.values())
      .concat(Array.from(this.patternMarkersById.values()))
      .concat(Array.from(this.targetMarkersById.values()))
      .concat(Array.from(this.stopHuntMarkersById.values()));
    const sorted = combined.sort((a, b) => a.time - b.time);
    this.series.setMarkers(sorted);
  }
}
window.MarkerManager = MarkerManager;
