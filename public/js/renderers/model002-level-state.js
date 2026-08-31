(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Model002LevelState = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * NOVA TRADE — MODEL_002 persistent level-touch helpers (client side).
   *
   * The authoritative latch lives in the backend (MODEL_002 ->
   * utils/levelTouchState.js -> BotInstance.parameters). This module does
   * NOT detect touches, does not read OHLC and does not reimplement any
   * strategy rule — it only:
   *
   *   1. applyPersistedFloor(checks, persisted)
   *      Raises a decision's Support/Resistance rows to TOUCHED when the
   *      instance's own persisted parameters say the level was already
   *      touched. This matters on page load, where the newest stored
   *      DECISION event may predate this feature (its `checks` would then
   *      still carry the old activeLevel-derived NOT_TOUCHED value). The
   *      floor is one-way: it can never turn TOUCHED back into
   *      NOT_TOUCHED.
   *
   *   2. normalizeBodyReference(checks)
   *      Extracts the visual-only body reference line payload the backend
   *      computed for the active A/B pattern, or null.
   */

  function readPersisted(botConfigLevelTouch) {
    var src = botConfigLevelTouch || {};
    var read = function (prefix) {
      return {
        touched: src[prefix + 'Touched'] === true,
        level: typeof src[prefix + 'TouchedLevel'] === 'number' ? src[prefix + 'TouchedLevel'] : null,
        index: typeof src[prefix + 'TouchedIndex'] === 'number' ? src[prefix + 'TouchedIndex'] : null,
        at: typeof src[prefix + 'TouchedAt'] === 'number' ? src[prefix + 'TouchedAt'] : null,
      };
    };
    return { support: read('support'), resistance: read('resistance') };
  }

  function raise(row, persistedSide) {
    var current = row || {};
    if (current.status === 'TOUCHED') return current;
    if (!persistedSide || !persistedSide.touched) {
      return { status: current.status || 'NOT_TOUCHED', level: current.level != null ? current.level : null, index: current.index != null ? current.index : null, at: current.at != null ? current.at : null };
    }
    return {
      status: 'TOUCHED',
      level: current.level != null ? current.level : persistedSide.level,
      index: current.index != null ? current.index : persistedSide.index,
      at: current.at != null ? current.at : persistedSide.at,
    };
  }

  /**
   * Returns a NEW checks object (never mutates the event payload) whose
   * support/resistance rows are at least as "touched" as the instance's
   * persisted state. Returns checks unchanged when it is falsy.
   */
  function applyPersistedFloor(checks, botConfigLevelTouch) {
    if (!checks) return checks;
    var persisted = readPersisted(botConfigLevelTouch);
    var out = {};
    for (var key in checks) {
      if (Object.prototype.hasOwnProperty.call(checks, key)) out[key] = checks[key];
    }
    out.support = raise(checks.support, persisted.support);
    out.resistance = raise(checks.resistance, persisted.resistance);
    return out;
  }

  /**
   * The backend's visual-only A-body reference for the active pattern, or
   * null. `fromTimestamp`/`toTimestamp` (Candle 1's and Candle 2's own
   * timestamps, as the backend already computed them in
   * Model002._bodyReferenceFor) are passed through unchanged so the chart
   * can render a segment bounded to C1->C2 instead of a full-width line.
   * `toTimestamp` is legitimately null while an OLD-engine pattern is
   * still searching for Candle 2 — that is not invented here, only
   * forwarded.
   */
  function normalizeBodyReference(checks) {
    var ref = checks && checks.bodyReference;
    if (!ref || typeof ref !== 'object') return null;
    var price = Number(ref.price);
    if (!isFinite(price) || price <= 0) return null;
    return {
      price: price,
      side: ref.side === 'BODY_LOW' ? 'BODY_LOW' : 'BODY_HIGH',
      direction: ref.direction === 'SELL' ? 'SELL' : 'BUY',
      candleTimestamp: typeof ref.candleTimestamp === 'number' ? ref.candleTimestamp : null,
      fromTimestamp: typeof ref.fromTimestamp === 'number' ? ref.fromTimestamp : null,
      toTimestamp: typeof ref.toTimestamp === 'number' ? ref.toTimestamp : null,
    };
  }

  /**
   * The chart captions for Candle 2's fixed boundaries, given the ACTIVE
   * pattern's direction.
   *
   * Which boundary triggers the trade and which one invalidates is a
   * property of the pattern's direction, not of the trend and not of
   * anything this file computes: `direction` must be passed in from the
   * backend group (checks.patternVisual.direction, which comes straight
   * from the MODEL_002 candidate the decision engine itself used). This
   * function only formats it.
   *
   *   BUY  -> upper triggers the BUY, lower invalidates
   *   SELL -> lower triggers the SELL, upper invalidates
   *
   * With no active pattern (direction null/unknown) the captions stay
   * neutral rather than asserting a direction that does not exist.
   */
  function getBoundaryLabels(direction) {
    if (direction === 'BUY') {
      return { upper: 'UPPER (BUY>)', lower: 'LOWER (INVALID<)' };
    }
    if (direction === 'SELL') {
      return { upper: 'UPPER (INVALID>)', lower: 'LOWER (SELL<)' };
    }
    return { upper: 'UPPER', lower: 'LOWER' };
  }

  /**
   * P4-M2 — which boundary TRIGGERS and which INVALIDATES, for the given
   * pattern direction. Companion to getBoundaryLabels above so the chart
   * overlay and the Decision Engine panel colour the two boundaries from
   * ONE definition instead of each hard-coding its own. Direction comes
   * from the backend group (checks.patternVisual.direction) — never from
   * the trend, never from OHLC.
   *
   *   BUY  -> upper triggers, lower invalidates
   *   SELL -> lower triggers, upper invalidates
   *
   * An unknown/absent direction reports neither side as the trigger, which
   * renders neutrally rather than guessing.
   */
  function getBoundaryRoles(direction) {
    if (direction === 'BUY') return { upper: 'TRIGGER', lower: 'INVALIDATION' };
    if (direction === 'SELL') return { upper: 'INVALIDATION', lower: 'TRIGGER' };
    return { upper: 'NEUTRAL', lower: 'NEUTRAL' };
  }

  return {
    getBoundaryLabels: getBoundaryLabels,
    getBoundaryRoles: getBoundaryRoles,
    readPersisted: readPersisted,
    applyPersistedFloor: applyPersistedFloor,
    normalizeBodyReference: normalizeBodyReference,
  };
}));
