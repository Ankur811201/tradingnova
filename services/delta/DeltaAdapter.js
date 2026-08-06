'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { env } = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * DeltaAdapter — the ONLY module in Nova Trade allowed to talk to Delta Exchange.
 *
 * Auth scheme verified against official docs.delta.exchange (as of this build):
 *   Headers: api-key, signature, timestamp, User-Agent, Content-Type: application/json
 *   signature = HMAC_SHA256(secret, method + timestamp + requestPath + queryString + body) as hex
 *   timestamp = unix seconds (string); signature must arrive within 5s of generation.
 *
 * Base URL is configurable via DELTA_BASE_URL because Delta operates region-specific
 * endpoints (Global vs India) and separate testnet endpoints — verify the correct
 * one for your account before going live. See README "Delta Exchange setup".
 *
 * NEVER logs api secret. NEVER returns secret to callers. Never called by Bot Models.
 */
class DeltaAdapter {
  constructor() {
    this.baseUrl = env.DELTA_BASE_URL.replace(/\/+$/, '');
    this.apiPrefix = '/v2';
    this.apiKey = env.DELTA_API_KEY;
    this.apiSecret = env.DELTA_API_SECRET;
    this.timeoutMs = env.DELTA_REQUEST_TIMEOUT_MS;
    this.configured = Boolean(this.apiKey && this.apiSecret);

    this.http = axios.create({ baseURL: this.baseUrl, timeout: this.timeoutMs });
  }

  isConfigured() {
    return this.configured;
  }

  _sign(method, path, queryString, body) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = body ? JSON.stringify(body) : '';
    const prehash = `${method}${timestamp}${path}${queryString}${payload}`;
    const signature = crypto.createHmac('sha256', this.apiSecret).update(prehash).digest('hex');
    return { timestamp, signature, payload };
  }

  async _request(method, path, { query = {}, body = null } = {}) {
    if (!this.configured) {
      const err = new Error('Delta Exchange is not configured (missing DELTA_API_KEY/DELTA_API_SECRET)');
      err.code = 'DELTA_NOT_CONFIGURED';
      err.status = 503;
      throw err;
    }

    const queryString = Object.keys(query).length
      ? `?${new URLSearchParams(query).toString()}`
      : '';
const requestPath = this.apiPrefix + path;

const { timestamp, signature, payload } =
  this._sign(method, requestPath, queryString, body);
    const headers = {
      'api-key': this.apiKey,
      signature,
      timestamp,
      'User-Agent': 'nova-trade-node-client',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    try {
      const response = await this.http.request({
        method,
        url: requestPath + queryString,
        data: payload || undefined,
        headers,
      });
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      const errBody = err.response?.data;
      await logger.error('DELTA', `Delta API ${method} ${path} failed`, {
        status, error: errBody?.error || err.message,
      });
      const normalized = new Error(
        `Delta API error (${method} ${path}): ${errBody?.error?.code || err.message}`
      );
      normalized.status = status || 502;
      normalized.deltaError = errBody?.error || null;
      throw normalized;
    }
  }

  // --- Account ---
  async getWalletBalances() {
    const data = await this._request('GET', '/wallet/balances');
    return data.result;
  }

  async getUser() {
    const data = await this._request('GET', '/profile');
    return data.result;
  }

  /**
   * Lightweight, cached check that private credentials actually authenticate
   * against Delta (distinct from merely being "configured" — a wrong/expired
   * key would still be "configured"). Uses only GET /profile (never an
   * order/trading endpoint) and caches the result for cacheMs to avoid
   * hammering Delta every time System Status is polled.
   */
  async checkAuthenticated(cacheMs = 30000) {
    if (!this.configured) return { authenticated: false, checkedAt: Date.now(), error: 'not configured' };
    const now = Date.now();
    if (this._authCache && now - this._authCache.checkedAt < cacheMs) {
      return this._authCache;
    }
    try {
      await this.getUser();
      this._authCache = { authenticated: true, checkedAt: now, error: null };
    } catch (err) {
      this._authCache = { authenticated: false, checkedAt: now, error: err.message };
    }
    return this._authCache;
  }

  // --- Products (public, but proxied through here to keep Delta access isolated) ---
  async getProductBySymbol(symbol) {
    const data = await this._request('GET', `/products/${symbol}`);
    return data.result;
  }

  async getTicker(symbol) {
    const data = await this._request('GET', `/tickers/${symbol}`);
    return data.result;
  }

  // --- Orders ---
  async placeOrder({ productId, side, orderType, size, limitPrice = null, clientOrderId = null, reduceOnly = false, stopLossOrder = null, takeProfitOrder = null }) {
    const body = {
      product_id: productId,
      side,
      order_type: orderType, // 'market_order' | 'limit_order'
      size,
      reduce_only: reduceOnly,
    };
    if (limitPrice != null) body.limit_price = String(limitPrice);
    if (clientOrderId) body.client_order_id = clientOrderId;
    if (stopLossOrder) {
      body.bracket_stop_loss_price = String(stopLossOrder.stopPrice);
      if (stopLossOrder.limitPrice) body.bracket_stop_loss_limit_price = String(stopLossOrder.limitPrice);
    }
    if (takeProfitOrder) {
      body.bracket_take_profit_price = String(takeProfitOrder.stopPrice);
      if (takeProfitOrder.limitPrice) body.bracket_take_profit_limit_price = String(takeProfitOrder.limitPrice);
    }
    const data = await this._request('POST', '/orders', { body });
    return data.result;
  }

  async cancelOrder({ id, productId, clientOrderId = null }) {
    const body = { id, product_id: productId };
    if (clientOrderId) body.client_order_id = clientOrderId;
    const data = await this._request('DELETE', '/orders', { body });
    return data.result;
  }

  async cancelAllOrders({ productId = null, contractTypes = null } = {}) {
    const body = {};
    if (productId) body.product_id = productId;
    if (contractTypes) body.contract_types = contractTypes;
    const data = await this._request('DELETE', '/orders/all', { body });
    return data;
  }

  async getActiveOrders({ productIds = null, states = 'open,pending' } = {}) {
    const query = { states };
    if (productIds) query.product_ids = productIds;
    const data = await this._request('GET', '/orders', { query });
    return data.result;
  }

  async getOrderById(orderId) {
    const data = await this._request('GET', `/orders/${orderId}`);
    return data.result;
  }

  async getOrderByClientOrderId(clientOrderId) {
    const data = await this._request('GET', `/orders/client_order_id/${clientOrderId}`);
    return data.result;
  }

  // --- Positions ---
  async getPositions({ productIds = null } = {}) {
    const query = {};
    if (productIds) query.product_id = productIds;
    const data = await this._request('GET', '/positions/margined', { query });
    return data.result;
  }

  async getPosition(productId) {
    const data = await this._request('GET', '/positions', { query: { product_id: productId } });
    return data.result;
  }

  // VERIFY BEFORE LIVE USE: the "Close all positions" endpoint's exact path/method
  // was listed in the Delta docs table of contents but its request/response detail
  // was not confirmed during this build. Confirm at https://docs.delta.exchange/
  // (Positions -> Close all positions) before relying on this in production. As a
  // safer verified alternative, LiveEngine.closeAllPositions() iterates open
  // positions from getPositions() and closes each with a reduce-only market order
  // via placeOrder(), which uses fully verified endpoints.
  async closeAllPositions() {
    const data = await this._request('POST', '/positions/close_all');
    return data;
  }

}

module.exports = new DeltaAdapter();
