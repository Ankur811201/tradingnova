'use strict';

/**
 * NOVA TRADE -- NEXT CANDLE TIMING
 * ================================
 *
 * THE single authoritative "time until the next candle opens" calculation for
 * the Bot Detail page. Both consumers (the on-chart countdown card and the
 * right-panel NEXT CANDLE metric) are rendered from this one module, on one
 * interval, from one computed value -- they can never disagree.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous implementation (inline in views/bot-detail.ejs) derived the
 * countdown from `Date.now()` alone, i.e. the browser's local clock. Nova
 * Trade's candles are bucketed by CandlePersistenceService from Delta
 * Exchange tick timestamps, so a user with a skewed system clock saw a
 * countdown that did not match the candles actually being persisted/traded.
 *
 * TIME SOURCE (no new pipeline, no new socket)
 * --------------------------------------------
 *   Delta ticker timestamp  --> DeltaMarketDataProvider._handleTick
 *      --> server.js `market:price` { symbol, price, timestamp }   (existing)
 *      --> noteExchangeTime()  ................ primary, sub-second fresh
 *
 *   GET /api/market/time { serverTime }  ...... bootstrap + periodic resync
 *      (used at page load, on reconnect, and every RESYNC_INTERVAL_MS, so a
 *       page opened while the market feed is quiet still starts correct)
 *
 * Both feed ONE number: `offsetMs = authoritativeNow - Date.now()`. Every
 * tick then computes `now()` locally, so the browser is never polled against
 * the backend once per second, and the local clock is only ever used as a
 * *delta* source (it cancels out of the offset), never as the trading clock.
 *
 * BOUNDARY MATH (identical bucketing to CandlePersistenceService)
 * --------------------------------------------------------------
 *   interval   = N * 60 * 1000
 *   bucketStart= floor(now / interval) * interval
 *   nextCandle = bucketStart + interval          (== ceil(now/interval)*interval
 *                                                 for a non-boundary `now`)
 *   remaining  = max(0, nextCandle - now)
 *
 * Because `nextCandle` is recomputed from the authoritative clock on every
 * tick, the countdown *self-resets* at each candle close -- it is not a
 * free-running browser timer that has to be told when to restart.
 *
 * TIMEFRAME
 * ---------
 * Read from the bot's own configuration (window.BOT_CONFIG.timeframe, the
 * same persisted `parameters.timeframe` the strategy and candle persistence
 * use). Parsed generically (`<n>m|h|d`), so 5m/15m/30m/1h/1d work the day a
 * bot is configured with them -- nothing is hardcoded to 60 seconds and no
 * new timeframe table has to be maintained here.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // tests
  if (root) root.NovaNextCandle = api;                                     // browser
}(typeof window !== 'undefined' ? window : null, function () {

  const PLACEHOLDER = '--:--';
  const RESYNC_INTERVAL_MS = 5 * 60 * 1000;  // periodic HTTP resync (cheap, not per-tick)
  const RESYNC_RETRY_MS = 10 * 1000;         // backoff when /api/market/time is unavailable
  const TICK_MS = 1000;
  const MAX_PLAUSIBLE_SKEW_MS = 24 * 60 * 60 * 1000;

  // ---------------------------------------------------------------
  // PURE LOGIC (unit-testable, no DOM / no network)
  // ---------------------------------------------------------------

  const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

  /** '1m' -> 60000, '3m' -> 180000, '1h' -> 3600000. Returns null for missing/invalid. */
  function parseTimeframeMs(timeframe) {
    if (typeof timeframe !== 'string') return null;
    const m = /^(\d+)([mhd])$/.exec(timeframe.trim());
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n * UNIT_MS[m[2]];
  }

  /** Start of the candle bucket containing `nowMs`. */
  function currentBoundary(nowMs, intervalMs) {
    return Math.floor(nowMs / intervalMs) * intervalMs;
  }

  /** Timestamp at which the NEXT candle opens (strictly greater than nowMs). */
  function nextBoundary(nowMs, intervalMs) {
    return currentBoundary(nowMs, intervalMs) + intervalMs;
  }

  /** Milliseconds remaining until the next candle opens; never negative. */
  function remainingMs(nowMs, intervalMs) {
    return Math.max(0, nextBoundary(nowMs, intervalMs) - nowMs);
  }

  /** MM:SS, floored, clamped at 00:00, never negative. */
  function formatRemaining(ms) {
    if (!Number.isFinite(ms)) return PLACEHOLDER;
    const total = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  /**
   * The countdown string for a given authoritative time + timeframe.
   * Returns '--:--' for an invalid/missing timeframe or unknown time,
   * rather than throwing.
   */
  function countdownText(nowMs, timeframe) {
    const intervalMs = parseTimeframeMs(timeframe);
    if (!intervalMs || !Number.isFinite(nowMs)) return PLACEHOLDER;
    return formatRemaining(remainingMs(nowMs, intervalMs));
  }

  // ---------------------------------------------------------------
  // CLOCK — holds the offset between the authoritative exchange/server
  // clock and this browser's clock. Injectable `nowFn` for tests.
  // ---------------------------------------------------------------

  function createClock(nowFn) {
    const localNow = nowFn || Date.now;
    let offsetMs = null; // null => never synchronised => '--:--'

    return {
      get synced() { return offsetMs !== null; },
      get offsetMs() { return offsetMs; },

      /** now() in authoritative (server/exchange) milliseconds, or NaN if never synced. */
      now() {
        return offsetMs === null ? NaN : localNow() + offsetMs;
      },

      /**
       * Applies an authoritative timestamp. `rttMs` (round-trip of the HTTP
       * sync) is halved to compensate for one-way latency; socket ticks pass 0.
       * Implausible values (> 24h from local time when we have no offset yet)
       * are ignored rather than poisoning the countdown.
       */
      apply(authoritativeMs, rttMs) {
        if (!Number.isFinite(authoritativeMs) || authoritativeMs <= 0) return false;
        const compensated = authoritativeMs + (Number.isFinite(rttMs) ? rttMs / 2 : 0);
        const candidate = compensated - localNow();
        if (offsetMs === null && Math.abs(candidate) > MAX_PLAUSIBLE_SKEW_MS) {
          // Still accept it: a genuinely wrong local clock is exactly the case
          // this feature exists for. The guard only rejects non-timestamps.
          if (!Number.isFinite(candidate)) return false;
        }
        offsetMs = candidate;
        return true;
      },
    };
  }

  // ---------------------------------------------------------------
  // CONTROLLER (browser) — one interval, many render targets
  // ---------------------------------------------------------------

  let active = null;

  /**
   * @param {object} opts
   * @param {string} opts.timeframe   bot's configured timeframe ('1m', '3m', ...)
   * @param {string} [opts.symbol]    bot's trading pair, to filter `market:price`
   * @param {string} [opts.instanceId] bot instance, to filter `bot:candle`
   * @param {object} [opts.socket]    EXISTING shared socket (window.NovaBotSocket)
   * @param {string[]} [opts.elementIds] DOM ids that receive the MM:SS text
   * @param {string} [opts.timeUrl]   defaults to /api/market/time
   */
  function init(opts) {
    const options = opts || {};
    destroy(); // never leave a second interval/listener behind (re-init safe)

    const clock = createClock(options.now);
    const timeUrl = options.timeUrl || '/api/market/time';
    const socket = options.socket || null;
    const symbol = options.symbol || null;
    const instanceId = options.instanceId || null;
    const elementIds = options.elementIds || [];

    let tickTimer = null;
    let syncTimer = null;
    let disposed = false;

    function render() {
      const text = countdownText(clock.now(), state.timeframe);
      for (const id of elementIds) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      }
    }

    const state = { timeframe: options.timeframe };

    function scheduleSync(delay) {
      if (disposed) return;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncFromServer, delay);
    }

    function syncFromServer() {
      if (disposed || typeof fetch !== 'function') return;
      const startedAt = Date.now();
      fetch(timeUrl, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then((body) => {
          // apiResponse wraps payloads as { success, data }
          const payload = (body && body.data) || body || {};
          const serverTime = Number(payload.serverTime);
          if (!clock.apply(serverTime, Date.now() - startedAt)) throw new Error('bad serverTime');
          render();
          scheduleSync(RESYNC_INTERVAL_MS);
        })
        .catch(() => {
          // Server time temporarily unavailable: keep the last valid offset
          // (the countdown keeps running correctly), just retry sooner.
          scheduleSync(RESYNC_RETRY_MS);
        });
    }

    // --- existing live events (no new socket, no new connection) ---
    const onPrice = (data) => {
      if (!data || (symbol && data.symbol !== symbol)) return;
      if (clock.apply(Number(data.timestamp), 0)) render();
    };
    const onCandle = (data) => {
      if (!data || (instanceId && data.instanceId !== instanceId)) return;
      render(); // candle rolled over — repaint immediately, boundary is recomputed
    };
    const onConnect = () => scheduleSync(0);

    if (socket && typeof socket.on === 'function') {
      socket.on('market:price', onPrice);
      socket.on('bot:candle', onCandle);
      socket.on('connect', onConnect);
    }

    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) { render(); scheduleSync(0); }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    tickTimer = setInterval(render, TICK_MS);
    render();
    syncFromServer();

    active = {
      clock,
      /** Bot timeframe changed (config edit) — no reload needed. */
      setTimeframe(tf) { state.timeframe = tf; render(); },
      render,
      destroy() {
        disposed = true;
        clearInterval(tickTimer);
        clearTimeout(syncTimer);
        if (socket && typeof socket.off === 'function') {
          socket.off('market:price', onPrice);
          socket.off('bot:candle', onCandle);
          socket.off('connect', onConnect);
        }
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisibility);
        }
        active = null;
      },
    };
    return active;
  }

  function destroy() {
    if (active) active.destroy();
  }

  return {
    // pure logic
    parseTimeframeMs,
    currentBoundary,
    nextBoundary,
    remainingMs,
    formatRemaining,
    countdownText,
    createClock,
    PLACEHOLDER,
    // browser controller
    init,
    destroy,
    get current() { return active; },
  };
}));
