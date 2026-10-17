'use strict';

/**
 * Pure helpers (no I/O) for interpreting Delta Exchange order objects.
 *
 * Every field used here is documented in the official Delta REST docs
 * (https://docs.delta.exchange, "Order" schema):
 *   size (int, contracts), unfilled_size (int), average_fill_price (string,
 *   null for unfilled orders), state ('open' | 'pending' | 'closed' |
 *   'cancelled'), paid_commission (string), cancellation_reason, client_order_id.
 * Product `contract_value` (e.g. "0.001" BTC per BTCUSD contract) converts
 * contracts <-> base-asset quantity. Nothing here is invented.
 */

const PHASE = Object.freeze({
  FILLED: 'FILLED',                       // state closed, nothing unfilled
  PARTIALLY_FILLED_OPEN: 'PARTIALLY_FILLED_OPEN', // still working, some filled
  OPEN: 'OPEN',                           // accepted, resting, nothing filled
  PENDING: 'PENDING',                     // waiting on trigger, nothing filled
  CANCELLED_UNFILLED: 'CANCELLED_UNFILLED',
  CANCELLED_PARTIAL: 'CANCELLED_PARTIAL', // cancelled with some fills
  UNKNOWN: 'UNKNOWN',                     // missing/contradictory data: never assume
});

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify a Delta order object using ONLY exchange-reported data.
 * Returns { phase, filledContracts, unfilledContracts, avgFillPrice, commission, reason }.
 * avgFillPrice is null (never 0/fabricated) unless exchange reported a positive price.
 */
function classifyOrder(order) {
  const out = {
    phase: PHASE.UNKNOWN, filledContracts: 0, unfilledContracts: null,
    avgFillPrice: null, commission: 0, reason: null,
  };
  if (!order || typeof order !== 'object') { out.reason = 'no order object'; return out; }

  const size = toNum(order.size);
  const unfilled = toNum(order.unfilled_size);
  if (size === null || size <= 0 || unfilled === null || unfilled < 0 || unfilled > size) {
    out.reason = `invalid size/unfilled_size (${order.size}/${order.unfilled_size})`;
    return out;
  }
  const filled = size - unfilled;
  out.filledContracts = filled;
  out.unfilledContracts = unfilled;
  out.commission = toNum(order.paid_commission) || 0;

  const avg = toNum(order.average_fill_price);
  if (filled > 0) {
    if (avg === null || !(avg > 0)) { out.reason = 'filled quantity reported without a valid average_fill_price'; return out; }
    out.avgFillPrice = avg;
  }

  switch (order.state) {
    case 'closed':
      if (unfilled === 0) out.phase = PHASE.FILLED;
      else out.reason = `state closed but unfilled_size=${unfilled}`; // contradiction -> UNKNOWN
      break;
    case 'cancelled':
      out.phase = filled > 0 ? PHASE.CANCELLED_PARTIAL : PHASE.CANCELLED_UNFILLED;
      break;
    case 'open':
      out.phase = filled > 0 ? PHASE.PARTIALLY_FILLED_OPEN : PHASE.OPEN;
      break;
    case 'pending':
      out.phase = filled > 0 ? PHASE.PARTIALLY_FILLED_OPEN : PHASE.PENDING;
      break;
    default:
      out.reason = `unrecognised order state "${order.state}"`;
  }
  return out;
}

const isTerminal = (phase) => phase === PHASE.FILLED
  || phase === PHASE.CANCELLED_UNFILLED || phase === PHASE.CANCELLED_PARTIAL;

/**
 * quantity (base asset, e.g. BTC) -> whole contracts. Delta `size` is an
 * integer number of contracts, so a non-integer result is rejected rather
 * than silently rounded (rounding would change the strategy's risk).
 */
function contractsFromQuantity(quantity, contractValue) {
  const q = Number(quantity);
  const cv = Number(contractValue);
  if (!(q > 0) || !(cv > 0)) throw new Error(`Invalid quantity/contract_value (${quantity}/${contractValue})`);
  const raw = q / cv;
  const rounded = Math.round(raw);
  if (rounded < 1) throw new Error(`Quantity ${q} is below one contract (${cv} per contract)`);
  if (Math.abs(raw - rounded) > 1e-6) {
    throw new Error(`Quantity ${q} is not a whole number of contracts (contract_value ${cv}, got ${raw})`);
  }
  return rounded;
}

function quantityFromContracts(contracts, contractValue) {
  return Number((Number(contracts) * Number(contractValue)).toFixed(10));
}

/**
 * Find the active exchange-side stop-loss order protecting a position.
 * Matches only documented fields: stop_order_type === 'stop_loss_order',
 * state open|pending, side opposite to the position, same product.
 */
function findStopLossOrder(activeOrders, { productId, positionSide }) {
  const closingSide = positionSide === 'LONG' ? 'sell' : 'buy';
  return (Array.isArray(activeOrders) ? activeOrders : []).find((o) => o
    && Number(o.product_id) === Number(productId)
    && o.stop_order_type === 'stop_loss_order'
    && o.side === closingSide
    && (o.state === 'open' || o.state === 'pending')) || null;
}

function findTargetLikeOrders(activeOrders, { productId }) {
  return (Array.isArray(activeOrders) ? activeOrders : []).filter((o) => o
    && Number(o.product_id) === Number(productId)
    && (o.stop_order_type === 'stop_loss_order' || o.stop_order_type === 'take_profit_order')
    && (o.state === 'open' || o.state === 'pending'));
}

module.exports = {
  PHASE, classifyOrder, isTerminal, contractsFromQuantity, quantityFromContracts,
  findStopLossOrder, findTargetLikeOrders,
};
