'use strict';

const WebSocket = require('ws');

/**
 * Minimal, isolated Delta Exchange WebSocket client.
 *
 * VERIFIED against official Delta documentation + Delta's own published
 * client examples:
 *   - WebSocket URL: wss://socket.india.delta.exchange (production India;
 *     configurable via constructor for Global if needed).
 *   - Subscribe envelope: { "type": "subscribe", "payload": { "channels":
 *     [{ "name": "v2/ticker", "symbols": [...] }] } }
 *   - Unsubscribe: same envelope with "type": "unsubscribe".
 *   - Ticker push messages carry the same fields as the REST Ticker object
 *     (close / mark_price / spot_price / symbol / timestamp).
 *
 * NOT implemented here: the `candlestick_<resolution>` channel. Its exact
 * push-message field layout could not be independently verified against
 * official documentation during this build, and per Nova Trade's policy of
 * never inventing external message formats, this client deliberately stays
 * on the verified `v2/ticker` channel only. Model 001 already builds its own
 * candles from price ticks (see bot-models/model-001/candleAggregator.js),
 * so ticker-only WebSocket data is sufficient — historical candles are
 * fetched via the verified REST /v2/history/candles endpoint instead.
 *
 * Reconnect uses capped exponential backoff (1s, 2s, 4s, ... up to 30s) to
 * avoid an aggressive reconnect loop.
 */
class DeltaWebSocketClient {
  constructor(options) {
    this.wsUrl = options.wsUrl;
    this.onTicker = options.onTicker || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.ws = null;
    this.connected = false;
    this.subscribedSymbols = new Set();
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.closedByCaller = false;
  }

  connect() {
    this.closedByCaller = false;
    this._open();
  }

  _open() {
    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.onStatusChange({ connected: true });
      if (this.subscribedSymbols.size) {
        this._send('subscribe', Array.from(this.subscribedSymbols));
      }
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return; // ignore unparseable frames, never crash the process
      }
      this._handleMessage(msg);
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.onStatusChange({ connected: false });
      if (!this.closedByCaller) this._scheduleReconnect();
    });

    this.ws.on('error', () => {
      // 'close' will follow; avoid double-handling here.
    });

    this.ws.on('ping', () => {
      try { this.ws.pong(); } catch (_e) { /* noop */ }
    });
  }

  _handleMessage(msg) {
    // Ticker push messages mirror the verified REST Ticker schema.
    if (!msg || (msg.type && !String(msg.type).includes('ticker'))) return;
    const symbol = msg.symbol;
    const priceCandidates = [msg.close, msg.mark_price, msg.spot_price, msg.last_price];
    let price = null;
    for (const c of priceCandidates) {
      const n = typeof c === 'string' ? parseFloat(c) : c;
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) { price = n; break; }
    }
    if (!symbol || price === null) return;
    const timestamp = typeof msg.timestamp === 'number'
      ? (msg.timestamp > 1e12 ? msg.timestamp : msg.timestamp * 1000) // accept sec or ms
      : Date.now();
    this.onTicker({ symbol, price, timestamp });
  }

  subscribeSymbol(deltaSymbol) {
    if (this.subscribedSymbols.has(deltaSymbol)) return;
    this.subscribedSymbols.add(deltaSymbol);
    if (this.connected) this._send('subscribe', [deltaSymbol]);
  }

  unsubscribeSymbol(deltaSymbol) {
    if (!this.subscribedSymbols.has(deltaSymbol)) return;
    this.subscribedSymbols.delete(deltaSymbol);
    if (this.connected) this._send('unsubscribe', [deltaSymbol]);
  }

  _send(type, symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = { type: type, payload: { channels: [{ name: 'v2/ticker', symbols: symbols }] } };
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (_err) {
      // connection likely closing; the 'close' handler will trigger reconnect
    }
  }

  _scheduleReconnect() {
    if (this.closedByCaller) return;
    const delayMs = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._open(), delayMs);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  close() {
    this.closedByCaller = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (_e) { /* noop */ }
    }
  }
}

module.exports = DeltaWebSocketClient;
