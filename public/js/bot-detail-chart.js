'use strict';

/**
 * Bot Detail — candle chart (Part 4: historical snapshot, Part 5: live updates).
 *
 * Canonical pipeline (real data only, single source):
 *   Delta real price
 *     -> CandlePersistenceService
 *     -> MongoDB Candle collection  ---------------------\
 *                                                          >  same canonical candle
 *     -> Socket.IO 'bot:candle' (bot:<instanceId> room)  -/
 *   -> Lightweight Charts (via ChartManager / CandleSeriesManager)
 *
 * Historical load: GET /api/bot-instances/:instanceId/candles?limit=300
 * Live updates:    'bot:candle' on the SAME shared socket as bot-detail-ws.js
 *                  (see bot-socket.js) — never a second connection, never a
 *                  second candle builder in the browser.
 *
 * Scope: candle rendering only. No BUY/SELL markers, no position/SL/TP
 * overlays, no MODEL_001 integration — those are later parts.
 */
(function () {
  var CANDLE_LIMIT = 300;
  var CHART_CONTAINER_ID = 'bot-chart-container';

  function setChartState(message) {
    var stateEl = document.getElementById('bot-chart-state');
    if (!stateEl) return;
    if (!message) {
      stateEl.textContent = '';
      stateEl.classList.add('hidden');
      return;
    }
    stateEl.textContent = message;
    stateEl.classList.remove('hidden');
  }

  /**
   * Validates a single raw candle (from either the REST snapshot or a
   * socket event). Returns a cleaned candle (numeric fields only) or null
   * if malformed. Never fabricates/interpolates a value — a bad record is
   * dropped, not repaired.
   */
  function sanitizeCandle(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var time = Number(raw.time);
    var open = Number(raw.open);
    var high = Number(raw.high);
    var low = Number(raw.low);
    var close = Number(raw.close);
    if (![time, open, high, low, close].every(Number.isFinite)) return null;

    var volume = null;
    if (raw.volume !== null && raw.volume !== undefined && Number.isFinite(Number(raw.volume))) {
      volume = Number(raw.volume);
    }

    return { time: time, open: open, high: high, low: low, close: close, volume: volume, closed: !!raw.closed };
  }

  async function fetchCandles(instanceId) {
    var url = '/api/bot-instances/' + encodeURIComponent(instanceId) + '/candles?limit=' + CANDLE_LIMIT;
    var res = await fetch(url, { credentials: 'include' });
    var body = null;
    try {
      body = await res.json();
    } catch (_err) {
      body = null;
    }

    if (!res.ok || !body || body.success !== true) {
      var message = (body && (body.message || body.error)) || ('HTTP ' + res.status);
      throw new Error(message);
    }

    return body.data;
  }

  async function init() {
    var container = document.getElementById(CHART_CONTAINER_ID);
    var instanceId = window.BOT_CONFIG && window.BOT_CONFIG.instanceId;

    if (!container) {
      console.error('[CHART] #' + CHART_CONTAINER_ID + ' not found in DOM');
      return;
    }

    if (!instanceId) {
      console.error('[CHART] window.BOT_CONFIG.instanceId is missing — cannot load candles');
      setChartState('Unable to load candle history.');
      return;
    }

    if (typeof window.LightweightCharts === 'undefined') {
      console.error('[CHART] LightweightCharts library did not load');
      setChartState('Unable to load candle history.');
      return;
    }

    if (typeof window.ChartManager === 'undefined') {
      console.error('[CHART] ChartManager (chart-manager.js) did not load');
      setChartState('Unable to load candle history.');
      return;
    }

    setChartState('Loading market candles...');

    var chartManager;
    try {
      chartManager = new window.ChartManager(CHART_CONTAINER_ID);
    } catch (err) {
      console.error('[CHART] ChartManager initialization failed:', err);
      setChartState('Unable to load candle history.');
      return;
    }

    // Exposed so this instance can be reused elsewhere later (e.g. a future
    // trade-marker part) instead of re-initializing the chart.
    window.NovaBotChartManager = chartManager;

    // -----------------------------------------------------------------
    // PART 13 -- PHASE T: configured Top/Bottom/Target Level overlays.
    // These are CONFIGURATION reference lines (horizontal price lines from
    // window.BOT_CONFIG.levels/targets, set in bot-detail.ejs from the
    // authoritative BotInstance), not execution markers — no BUY/SELL/EXIT
    // marker is created here, and no marker is created just because a
    // level exists. Uses OverlayManager.setPriceLine, already-existing
    // generic infrastructure from the position-overlay work; no chart
    // redesign needed.
    // -----------------------------------------------------------------
    (function syncConfiguredLevelOverlays() {
      var om = chartManager.overlayManager;
      if (!om || typeof om.setPriceLine !== 'function') return;
      var cfg = window.BOT_CONFIG || {};
      var levels = cfg.levels || {};
      if (levels.top != null) om.setPriceLine('cfgTopLevel', levels.top, '#f23645', 'TOP LEVEL', 1);
      if (levels.bottom != null) om.setPriceLine('cfgBottomLevel', levels.bottom, '#089981', 'BOTTOM LEVEL', 1);
      (cfg.targets || []).forEach(function (price, idx) {
        om.setPriceLine('cfgTarget' + idx, price, '#2962ff', 'TARGET ' + (idx + 1), 1);
      });
    })();

    // -----------------------------------------------------------------
    // LIVE UPDATES (Part 5)
    //
    // The socket may already be connected and emitting bot:candle before
    // the historical REST snapshot resolves. To avoid a late setData()
    // stomping a newer live candle (or a stale live candle rewinding a bar
    // that's already loaded), every live event is queued until the
    // historical load settles (success, empty, or error — all count as
    // "settled"), then replayed once, in ascending time order.
    // -----------------------------------------------------------------

    var expectedSymbol = null;
    var expectedTimeframe = null;
    var historyLoaded = false;
    var chartHasData = false;
    var lastHistoricalTime = null;
    var pendingLiveCandles = [];

    // -----------------------------------------------------------------
  // HISTORICAL EXECUTION MARKERS (Part 10)
  //
  // window.BOT_INITIAL_TRADES (closed Trade docs, already scoped
  // instanceId+environment server-side -- see controllers/botController.js)
  // and window.BOT_INITIAL_POSITION (the current OPEN Position, or null --
  // Part 9) are reused as-is; no new endpoint. Normalization to the chart
  // marker contract lives in execution-markers.js, not here.
  //
  // Per Phase F ("historical edge case"), a marker whose bucketed time
  // falls before the earliest loaded candle is dropped rather than
  // expanding the candle fetch just to show it.
  // -----------------------------------------------------------------
  function loadInitialExecutionMarkers(candles) {
    if (typeof window.NovaExecutionMarkers === 'undefined') {
      console.error('[CHART] execution-markers.js did not load — skipping execution markers');
      return;
    }
    if (!candles.length) return;

    // PART 13.1 -- PHASE D: no '5m' fallback. window.BOT_CONFIG.timeframe is
    // now only ever '' for a bot with no real configured timeframe, and
    // such a bot cannot have real candles to bucket markers against anyway.
    var timeframe = window.BOT_CONFIG && window.BOT_CONFIG.timeframe;
    if (!timeframe) return;
    var trades = Array.isArray(window.BOT_INITIAL_TRADES) ? window.BOT_INITIAL_TRADES : [];
    var openPosition = window.BOT_INITIAL_POSITION || null;

    var markers = window.NovaExecutionMarkers.buildHistoricalMarkers(trades, openPosition, timeframe);

    var earliest = candles[0].time;
    markers = markers.filter(function (m) { return m.time >= earliest; });

    chartManager.loadExecutionMarkers(markers);
  }

  function isRelevantEvent(evt) {
      if (!evt || typeof evt !== 'object') return false;
      if (evt.instanceId !== instanceId) return false;
      if (expectedSymbol && evt.symbol !== expectedSymbol) return false;
      if (expectedTimeframe && evt.timeframe !== expectedTimeframe) return false;
      return true;
    }

    function applyLiveCandle(candle) {
      if (!chartHasData) {
        // First candle this page has ever rendered (e.g. history was empty
        // or failed to load) — bootstrap the series with just this one
        // candle. setData() is only ever called this once for that reason,
        // never per-tick afterward.
        chartManager.loadHistoricalData([candle]);
        chartHasData = true;
        setChartState(null);
        return;
      }

      chartManager.onLiveCandle(candle);
    }

    function handleBotCandleEvent(evt) {
      if (!isRelevantEvent(evt)) return;

      var candle = sanitizeCandle(evt.candle);
      if (!candle) {
        console.warn('[CHART] Ignored malformed bot:candle payload:', evt);
        return;
      }

      if (!historyLoaded) {
        pendingLiveCandles.push(candle);
        return;
      }

      // Never let a live event rewind the chart behind what history already loaded.
      if (lastHistoricalTime !== null && candle.time < lastHistoricalTime) return;

      applyLiveCandle(candle);
    }

    var socket = window.NovaBotSocket;
    if (socket) {
      socket.on('bot:candle', handleBotCandleEvent);
    } else {
      console.error('[CHART] window.NovaBotSocket is missing — live candle updates disabled (was bot-socket.js loaded?)');
    }

    // -----------------------------------------------------------------
    // HISTORICAL LOAD (Part 4, unchanged)
    // -----------------------------------------------------------------

    try {
      var data = await fetchCandles(instanceId);

      console.log('[CHART] Historical candle snapshot loaded:', {
        instanceId: data.instanceId,
        symbol: data.symbol,
        timeframe: data.timeframe,
        count: data.count,
      });

      expectedSymbol = data.symbol || null;
      expectedTimeframe = data.timeframe || null;

      var rawCandles = Array.isArray(data.candles) ? data.candles : [];
      var candles = rawCandles.map(sanitizeCandle).filter(Boolean);

      var droppedCount = rawCandles.length - candles.length;
      if (droppedCount > 0) {
        console.warn('[CHART] Dropped ' + droppedCount + ' malformed candle(s) from API response');
      }

      if (candles.length === 0) {
        setChartState('No candle history available yet.');
      } else {
        // API already returns oldest -> newest; sanitation only filters, it
        // never reorders or mutates OHLC values.
        chartManager.loadHistoricalData(candles);
        chartHasData = true;
        lastHistoricalTime = candles[candles.length - 1].time;
        setChartState(null);
        loadInitialExecutionMarkers(candles);
      }
    } catch (err) {
      console.error('[CHART] Failed to load candle history:', err);
      setChartState('Unable to load candle history.');
    } finally {
      historyLoaded = true;

      if (pendingLiveCandles.length) {
        pendingLiveCandles
          .sort(function (a, b) { return a.time - b.time; })
          .filter(function (c) { return lastHistoricalTime === null || c.time >= lastHistoricalTime; })
          .forEach(applyLiveCandle);
        pendingLiveCandles = [];
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
