'use strict';

/**
 * NOVA TRADE -- PART 13: canonical configuration-contract validators.
 *
 * These are the single, authoritative validation functions for the pieces
 * of Bot Instance configuration the client asked to make explicit: Top/
 * Bottom Level, Target Levels, and Sizing Mode (CAPITAL vs LOT). Both
 * BotManager.createInstance and BotManager.updateConfiguration call these
 * — there is exactly one place that decides whether a level/target/sizing
 * value is valid, not one set of rules on create and a looser one on
 * update.
 *
 * These functions are pure (no DB, no I/O) and throw a plain Error with a
 * human-readable message; callers wrap that into an AppError(..., 400).
 */

const SIZING_MODES = ['CAPITAL', 'LOT'];

function isFinitePositive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * PHASE E — level validation. Both top/bottom finite, positive, and
 * bottom strictly less than top. Never silently swaps values.
 * @param {{top:number, bottom:number}|null|undefined} levels
 * @returns {{top:number, bottom:number}|null} normalized levels, or null if not supplied
 */
function validateLevels(levels) {
  if (levels === null || levels === undefined) return null;
  if (typeof levels !== 'object') {
    throw new Error('levels must be an object with top and bottom');
  }
  const { top, bottom } = levels;
  // Allow a partial update to leave levels untouched entirely (handled by
  // caller via `has()`), but once the caller decides to validate levels,
  // both sides must be present and valid — a lone top or bottom is
  // ambiguous ("bottom < top" cannot be checked against nothing) and is
  // rejected rather than guessed.
  if (top === undefined || top === null || top === '' || bottom === undefined || bottom === null || bottom === '') {
    throw new Error('levels requires both top and bottom');
  }
  const topNum = Number(top);
  const bottomNum = Number(bottom);
  if (!isFinitePositive(topNum) || !isFinitePositive(bottomNum)) {
    throw new Error('levels.top and levels.bottom must be finite positive numbers');
  }
  if (bottomNum >= topNum) {
    throw new Error('levels.bottom must be strictly less than levels.top');
  }
  return { top: topNum, bottom: bottomNum };
}

/**
 * PHASE F/G — target level validation. Finite, positive, deterministically
 * ordered (ascending by price), de-duplicated. Direction (LONG needs a
 * target above entry, SHORT needs one below) is NOT checked here — that
 * requires an entry/direction which only exists at TradeCommand build
 * time (see Model001._buildTradeCommand / PHASE G).
 * @param {Array<{price:number}|number>|null|undefined} targets
 * @returns {Array<{price:number}>|null}
 */
function validateTargets(targets) {
  if (targets === null || targets === undefined) return null;
  if (!Array.isArray(targets)) {
    throw new Error('targets must be an array');
  }
  const prices = targets.map((t) => {
    const price = typeof t === 'number' ? t : t && t.price;
    const num = Number(price);
    if (!isFinitePositive(num)) {
      throw new Error(`Invalid target price: ${JSON.stringify(t)}`);
    }
    return num;
  });
  const unique = Array.from(new Set(prices));
  if (unique.length !== prices.length) {
    throw new Error('targets must not contain duplicate prices');
  }
  unique.sort((a, b) => a - b);
  return unique.map((price) => ({ price }));
}

/**
 * PHASE H/I — sizing mode validation. CAPITAL is the legacy/default
 * behavior (existing dynamic-lot-table quantity, capital acts only as a
 * RiskEngine ceiling — unchanged). LOT requires an explicit positive
 * `value`, interpreted as a literal contract/quantity unit exactly as
 * Delta's own order `size` field expects (see DeltaAdapter.placeOrder) —
 * never a guessed conversion.
 * @param {{mode:string, value?:number}|null|undefined} sizing
 * @returns {{mode:string, value:number|null}|null}
 */
function validateSizing(sizing) {
  if (sizing === null || sizing === undefined) return null;
  if (typeof sizing !== 'object') {
    throw new Error('sizing must be an object with mode (and value for LOT mode)');
  }
  const mode = sizing.mode;
  if (!SIZING_MODES.includes(mode)) {
    throw new Error(`sizing.mode must be one of ${SIZING_MODES.join(', ')}`);
  }
  if (mode === 'LOT') {
    const value = Number(sizing.value);
    if (!isFinitePositive(value)) {
      throw new Error('sizing.value must be a finite positive number when sizing.mode is LOT');
    }
    return { mode: 'LOT', value };
  }
  return { mode: 'CAPITAL', value: null };
}

/**
 * PHASE J — leverage validation shared by create + update. Backend policy
 * (maxLeverage) always wins over whatever the UI requests.
 * @param {number} leverage
 * @param {number} maxLeverage
 * @returns {number}
 */
function validateLeverage(leverage, maxLeverage) {
  const num = Number(leverage);
  if (!Number.isFinite(num) || num < 1 || num > maxLeverage) {
    throw new Error(`leverage must be a number between 1 and ${maxLeverage}`);
  }
  return num;
}

/**
 * PHASE G — direction-specific target validation, performed at
 * TradeCommand build time once direction is known. Returns the nearest
 * valid target price for the given direction, or null if none of the
 * configured targets are on the correct side of the entry price.
 * Does NOT throw: an invalid/absent target for this trade simply means no
 * take-profit is attached, it never blocks the entry itself.
 * @param {Array<{price:number}>} targets
 * @param {'LONG'|'SHORT'} direction
 * @param {number} entryPrice
 * @returns {number|null}
 */
function resolveDirectionalTarget(targets, direction, entryPrice) {
  if (!Array.isArray(targets) || !targets.length) return null;
  if (!isFinitePositive(entryPrice)) return null;

  if (direction === 'LONG') {
    const above = targets.filter((t) => t.price > entryPrice).map((t) => t.price);
    return above.length ? Math.min(...above) : null;
  }
  if (direction === 'SHORT') {
    const below = targets.filter((t) => t.price < entryPrice).map((t) => t.price);
    return below.length ? Math.max(...below) : null;
  }
  return null;
}

module.exports = {
  SIZING_MODES,
  validateLevels,
  validateTargets,
  validateSizing,
  validateLeverage,
  resolveDirectionalTarget,
};
