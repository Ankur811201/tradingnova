'use strict';

/**
 * Tracks recently-seen command ids within a sliding time window to reject
 * duplicate bot signals before they can create duplicate orders.
 * Pure in-memory logic (injectable clock for testability).
 */
class DuplicateSignalDetector {
  constructor(windowMs, clock = () => Date.now()) {
    this.windowMs = windowMs;
    this.clock = clock;
    this.seen = new Map(); // commandId -> timestamp
  }

  isDuplicate(commandId) {
    this._prune();
    return this.seen.has(commandId);
  }

  record(commandId) {
    this.seen.set(commandId, this.clock());
  }

  _prune() {
    const cutoff = this.clock() - this.windowMs;
    for (const [id, ts] of this.seen.entries()) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }
}

module.exports = DuplicateSignalDetector;
