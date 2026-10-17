'use strict';

/**
 * In-memory stand-ins for the LIVE execution tests. NOTHING here touches the
 * network, MongoDB or real credentials: a scriptable fake Delta exchange
 * (shaped like documented Delta order/position objects) and minimal fake
 * Mongoose-style models supporting only what LiveEngine/LiveReconciler use.
 */

let seq = 1000;

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([k, v]) => {
    const actual = doc[k];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$ne' in v) return String(actual) !== String(v.$ne);
      if ('$in' in v) return v.$in.map(String).includes(String(actual));
    }
    return String(actual) === String(v);
  });
}

function makeModel(defaults) {
  const rows = [];
  const model = {
    rows,
    async create(data) {
      const doc = { _id: `id${seq += 1}`, createdAt: new Date(), ...JSON.parse(JSON.stringify(defaults())), ...data };
      doc.save = async function save() { return this; };
      rows.push(doc);
      return doc;
    },
    async findById(id) { return rows.find((r) => String(r._id) === String(id)) || null; },
    async findOne(filter) { return rows.find((r) => matches(r, filter)) || null; },
    find(filter) {
      const out = rows.filter((r) => matches(r, filter));
      out.select = () => out;
      return out;
    },
    async findOneAndUpdate(filter, update) {
      const doc = rows.find((r) => matches(r, filter));
      if (!doc) return null;
      Object.assign(doc, update.$set || {});
      return doc;
    },
    async updateOne(filter, update) {
      const doc = rows.find((r) => matches(r, filter));
      if (doc) Object.assign(doc, update.$set || {});
      return { matchedCount: doc ? 1 : 0 };
    },
  };
  return model;
}

function makeStore() {
  const Order = makeModel(() => ({ status: 'PENDING', filledQuantity: 0, filledContracts: 0, fees: 0 }));
  const Position = makeModel(() => ({
    status: 'OPEN', closeInFlight: false, realizedPnl: 0, feesPaid: 0, entryFee: 0, margin: 0,
    openedAt: new Date(), protectionStatus: 'NONE', needsReconciliation: false,
  }));
  const Trade = makeModel(() => ({}));
  const settings = { liveTradingEnabled: true, async save() { return this; } };
  const SystemSetting = { settings, async getSingleton() { return settings; } };
  return { Order, Position, Trade, SystemSetting };
}

function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status; e.ambiguous = false; e.isAuthError = false;
  return Object.assign(e, extra);
}

/**
 * Scriptable exchange. Behaviours consumed in order from `script.place` for
 * placeOrder; default is an immediate full fill at `price`.
 *   { type:'fill', price?, filled? }        fill (or partial fill if filled < size; remainder cancelled)
 *   { type:'reject' }                       definitive 4xx rejection
 *   { type:'auth' }                         401 invalid_api_key
 *   { type:'nofill' }                       accepted/open, never fills; cancel -> cancelled
 *   { type:'timeout', fills:true|false }    request "times out"; exchange did (true) / did not (false) accept it
 */
class FakeExchange {
  constructor({ productId = 27, symbol = 'BTCUSD', contractValue = '0.001', price = 63000 } = {}) {
    this.productId = productId; this.symbol = symbol; this.contractValue = contractValue; this.price = price;
    this.orders = new Map(); this.byClientId = new Map();
    this.positionContracts = 0; this.positionSide = null;
    this.script = { place: [], bracket: [] };
    this.calls = { placeOrder: [], bracket: [], cancel: [] };
    this.authBroken = false;
    this.stopLegs = [];
  }

  isConfigured() { return true; }
  async getProductBySymbol() { return { id: this.productId, symbol: this.symbol, contract_value: this.contractValue }; }

  _record(args, fill, state, filledOverride) {
    const id = (seq += 1);
    const size = Number(args.size);
    const filled = filledOverride !== undefined ? filledOverride : (fill ? size : 0);
    const order = {
      id, product_id: this.productId, product_symbol: this.symbol, size, unfilled_size: size - filled,
      side: args.side, order_type: 'market_order', reduce_only: Boolean(args.reduceOnly),
      client_order_id: args.clientOrderId, state,
      average_fill_price: filled > 0 ? String(fill && fill.price ? fill.price : this.price) : null,
      paid_commission: filled > 0 ? '0.05' : '0', stop_order_type: null,
    };
    this.orders.set(id, order); this.byClientId.set(args.clientOrderId, order);
    if (filled > 0) this._applyFill(args, filled);
    return order;
  }

  _applyFill(args, filled) {
    if (args.reduceOnly) this.positionContracts = Math.max(0, this.positionContracts - filled);
    else { this.positionContracts += filled; this.positionSide = args.side === 'buy' ? 'LONG' : 'SHORT'; }
  }

  async placeOrder(args) {
    this.calls.placeOrder.push(args);
    if (this.authBroken) throw httpError(401, 'Delta API error: invalid_api_key', { isAuthError: true });
    if (!Number.isInteger(args.size)) throw httpError(400, 'size must be an integer number of contracts');
    const b = this.script.place.shift() || { type: 'fill' };
    switch (b.type) {
      case 'reject': throw httpError(400, 'Delta API error (POST /orders): insufficient_margin');
      case 'auth': throw httpError(401, 'Delta API error: invalid_api_key', { isAuthError: true });
      case 'nofill': return this._record(args, null, 'open', 0);
      case 'timeout':
        if (b.fills) this._record(args, { price: b.price }, 'closed');
        throw httpError(502, 'timeout of 10000ms exceeded', { ambiguous: true });
      default: {
        const size = Number(args.size);
        const filled = b.filled !== undefined ? b.filled : size;
        return this._record(args, { price: b.price }, filled === size ? 'closed' : 'cancelled', filled);
      }
    }
  }

  async getOrderById(id) { const o = this.orders.get(Number(id)); if (!o) throw httpError(404, 'not found'); return { ...o }; }
  async getOrderByClientOrderId(cid) { const o = this.byClientId.get(cid); if (!o) throw httpError(404, 'not found'); return { ...o }; }

  async cancelOrder({ id }) {
    this.calls.cancel.push(id);
    const o = this.orders.get(Number(id)) || this.stopLegs.find((l) => l.id === Number(id));
    if (o && (o.state === 'open' || o.state === 'pending')) o.state = 'cancelled';
    return o;
  }

  async getActiveOrders() {
    return [...this.stopLegs.filter((l) => l.state === 'open' || l.state === 'pending'),
      ...[...this.orders.values()].filter((o) => o.state === 'open')].map((o) => ({ ...o }));
  }

  async placeBracketOrder({ stopLoss }) {
    this.calls.bracket.push({ stopLoss });
    if (this.authBroken) throw httpError(401, 'Delta API error: invalid_api_key', { isAuthError: true });
    const b = this.script.bracket.shift() || { type: 'ok' };
    if (b.type === 'reject') throw httpError(400, 'Delta API error (POST /orders/bracket): invalid_stop_price');
    if (b.type === 'silent') return { success: true }; // accepted but no leg appears
    this.stopLegs.push({
      id: (seq += 1), product_id: this.productId, stop_order_type: 'stop_loss_order',
      side: this.positionSide === 'LONG' ? 'sell' : 'buy', state: 'open',
      stop_price: String(stopLoss.stopPrice), size: this.positionContracts, unfilled_size: this.positionContracts,
    });
    return { success: true };
  }

  async getPosition() {
    if (this.authBroken) throw httpError(401, 'auth', { isAuthError: true });
    return { size: this.positionContracts, product_id: this.productId };
  }

  async getPositions() {
    if (this.authBroken) throw httpError(401, 'auth', { isAuthError: true });
    return this.positionContracts > 0
      ? [{ size: this.positionSide === 'LONG' ? this.positionContracts : -this.positionContracts, product_symbol: this.symbol, product_id: this.productId, margin: '12.5' }]
      : [];
  }
}

const silentLogger = () => {
  const lines = [];
  const mk = (level) => async (cat, msg, meta) => { lines.push({ level, cat, msg, meta }); };
  return { lines, info: mk('info'), warn: mk('warn'), error: mk('error') };
};

const testEnv = (extra = {}) => ({
  LIVE_TRADING_DEFAULT_ENABLED: true, LIVE_FILL_POLL_INTERVAL_MS: 1, LIVE_FILL_TIMEOUT_MS: 25,
  LIVE_CLOSE_MAX_ATTEMPTS: 3, LIVE_RECONCILE_INTERVAL_MS: 0,
  DELTA_BRACKET_SL_ORDER_TYPE: 'market_order', DELTA_BRACKET_TRIGGER_METHOD: 'last_traded_price', ...extra,
});

/** Fresh engine + reconciler + exchange + store wired together. */
function build({ exchangeOpts, envExtra } = {}) {
  const { LiveEngine } = require('../../services/liveEngine/LiveEngine');
  const { LiveReconciler } = require('../../services/liveEngine/LiveReconciler');
  const store = makeStore();
  const ex = new FakeExchange(exchangeOpts);
  const logger = silentLogger();
  const engine = new LiveEngine().setDependencies({
    ...store, adapter: ex, env: testEnv(envExtra), logger, sleep: async () => {},
    newId: (() => { let n = 0; return () => `cid_${n += 1}_${Math.random().toString(36).slice(2, 8)}`; })(),
  });
  const reconciler = new LiveReconciler().setDependencies({ ...store, adapter: ex, engine, env: testEnv(envExtra), logger });
  return { engine, reconciler, ex, store, logger };
}

const entryParams = (over = {}) => ({
  userId: 'u1', symbol: 'BTCUSD', productId: 27, contractValue: 0.001, side: 'LONG', quantity: 0.01, leverage: 10,
  stopLoss: 62900, source: 'BOT', modelId: 'MODEL_002', instanceId: 'inst1', commandId: 'cmd_1', ...over,
});

module.exports = { FakeExchange, makeStore, build, entryParams, httpError };
