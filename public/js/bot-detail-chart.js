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

    // PRICE-AXIS LABEL: Lightweight Charts' own single-line last-value label
    // is hidden so our two-line price + countdown label (#chart-price-label)
    // owns that exact spot on the right price axis instead of sitting next
    // to a duplicate. Applied to THIS page's chart instance only — the
    // shared CandleSeriesManager (and the terminal page's chart) is
    // untouched, as are the series data, the price scale itself, and the
    // dashboard's own CURRENT PRICE metric.
    try {
      chartManager.candleSeries.candlestickSeries.applyOptions({ lastValueVisible: false });
    } catch (err) {
      console.warn('[CHART] could not hide last-value price label:', err);
    }

    // Attach the price-axis label to this chart instance. It positions
    // itself from series.priceToCoordinate() and is fed by the EXISTING
    // market:price handler (bot-detail-ws.js) — it opens no socket, starts
    // no timer, and does no countdown maths of its own.
    if (window.NovaChartPriceLabel) {
      window.NovaChartPriceLabel.attach({
        chartManager: chartManager,
        container: document.getElementById(CHART_CONTAINER_ID).parentElement,
        label: document.getElementById('chart-price-label'),
      });
    }

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
      var isModel002 = cfg.modelId === 'MODEL_002';

      // NOVA TRADE -- CHART CLEANUP: Top/Bottom Level and Target Levels are
      // obsolete MODEL_001-only overlays. The underlying infrastructure
      // (OverlayManager.setPriceLine, window.BOT_CONFIG.levels/targets) is
      // left in place — other models/tests still depend on it — but the
      // active MODEL_002 chart must never draw these lines, regardless of
      // whether levels/targets happen to be populated on the instance.
      if (!isModel002) {
        var levels = cfg.levels || {};
        if (levels.top != null) om.setPriceLine('cfgTopLevel', levels.top, '#f23645', 'TOP LEVEL', 1);
        if (levels.bottom != null) om.setPriceLine('cfgBottomLevel', levels.bottom, '#089981', 'BOTTOM LEVEL', 1);
        (cfg.targets || []).forEach(function (price, idx) {
          om.setPriceLine('cfgTarget' + idx, price, '#2962ff', 'TARGET ' + (idx + 1), 1);
        });
      }

      // MODEL_002 — user-configured Support/Resistance (exactly 3 each,
      // never auto-detected: no swing detection, no Daily/1H levels).
      // Same setPriceLine key/dedup mechanism as Top/Bottom Level above —
      // re-syncing with the same keys (cfgSupport0/1/2, cfgResistance0/1/2)
      // overwrites rather than duplicates the lines.
      (cfg.support || []).forEach(function (price, idx) {
        if (price == null) return;
        om.setPriceLine('cfgSupport' + idx, price, '#089981', 'S' + (idx + 1), 1);
      });
      (cfg.resistance || []).forEach(function (price, idx) {
        if (price == null) return;
        om.setPriceLine('cfgResistance' + idx, price, '#f23645', 'R' + (idx + 1), 1);
      });
    })();

    // -----------------------------------------------------------------
    // MODEL_002 same-side pattern overlay: Candle 2's fixed upper/lower
    // confirmation boundaries. Uses the SAME setPriceLine key/dedup
    // mechanism as the static Support/Resistance lines above — re-syncing
    // with the same keys overwrites rather than duplicates, and clearing
    // simply removes the price line (no fabricated line when there is no
    // active pattern). Called live from bot-detail-ws.js's real
    // bot:decision handler with the actual checks.boundaries the strategy
    // computed — never invented here.
    // -----------------------------------------------------------------
    window.NovaChartPatternOverlay = {
      setBoundaries: function (upper, lower) {
        var om = chartManager.overlayManager;
        if (!om || typeof om.setPriceLine !== 'function') return;
        if (upper != null) om.setPriceLine('patternUpperBoundary', upper, '#22c55e', 'UPPER (BUY>)', 2);
        if (lower != null) om.setPriceLine('patternLowerBoundary', lower, '#f43f5e', 'LOWER (INVALID<)', 2);
      },
      clearBoundaries: function () {
        var om = chartManager.overlayManager;
        if (!om || typeof om.removePriceLine !== 'function') return;
        om.removePriceLine('patternUpperBoundary');
        om.removePriceLine('patternLowerBoundary');
      },
    };


    // -----------------------------------------------------------------
    // MODEL_002 pattern-role markers: visually label the actual candles
    // used by the NEW A/B/C pattern as 1, 2 and 3. These are chart-only
    // markers derived from the backend decision payload; they do not affect
    // strategy state or execution. MarkerManager merges them with existing
    // BUY/SELL/EXIT execution markers so one never erases the other.
    // -----------------------------------------------------------------
    function patternCandleTime(candle) {
      if (!candle) return null;
      var raw = Number(candle.timestamp != null ? candle.timestamp : candle.time);
      if (!Number.isFinite(raw) || raw <= 0) return null;
      // Backend candle timestamps are milliseconds; Lightweight Charts uses
      // Unix seconds. Also accept seconds defensively for older payloads.
      return raw > 100000000000 ? Math.floor(raw / 1000) : Math.floor(raw);
    }

    function buildPatternRoleMarkers(checks) {
      if (!checks || !checks.candle1 || !checks.candle2) return [];
      var direction = checks.direction === 'SELL' ? 'SELL' : 'BUY';
      var position = direction === 'SELL' ? 'aboveBar' : 'belowBar';
      var color1 = '#64748b';
      var color2 = '#3b82f6';
      var color3 = direction === 'SELL' ? '#f43f5e' : '#22c55e';
      var specs = [
        { key: 'c1', text: '1', candle: checks.candle1, color: color1 },
        { key: 'c2', text: '2', candle: checks.candle2, color: color2 },
        { key: 'c3', text: '3', candle: checks.candle3, color: color3 },
      ];

      return specs.map(function (spec) {
        var time = patternCandleTime(spec.candle);
        if (time == null) return null;
        return {
          id: 'model002-pattern-' + spec.key,
          time: time,
          position: position,
          color: spec.color,
          shape: 'circle',
          text: spec.text,
        };
      }).filter(Boolean);
    }

    window.NovaChartPatternMarkers = {
      setFromChecks: function (checks) {
        if (!chartManager || typeof chartManager.setPatternMarkers !== 'function') return;
        chartManager.setPatternMarkers(buildPatternRoleMarkers(checks));
      },
      clear: function () {
        if (!chartManager || typeof chartManager.clearPatternMarkers !== 'function') return;
        chartManager.clearPatternMarkers();
      },
    };

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
    // ACTIVE analysis timeframe (one-time opposite-market switch): equals
    // BOT_CONFIG.timeframe unless this bot switched to 1m.
    var timeframe = window.BOT_CONFIG && (window.BOT_CONFIG.activeTimeframe || window.BOT_CONFIG.timeframe);
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

      // A new/updated candle can rescale the price axis — re-derive the
      // label's Y from the same price it is already showing.
      if (window.NovaChartPriceLabel) window.NovaChartPriceLabel.position();
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

      // Same baseline the historical candles API and Model002 hydration
      // already apply (candle.timestamp >= bot.createdAt) — a live candle
      // cannot realistically predate the bot's own creation under normal
      // operation (candles only ever arrive in real time), but this keeps
      // both the historical and live paths using the exact same rule
      // rather than two different, potentially-diverging ones.
      var createdAtMs = window.BOT_CONFIG && window.BOT_CONFIG.createdAtMs;
      if (typeof createdAtMs === 'number' && candle.time < Math.floor(createdAtMs / 1000)) return;

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

        // If the server-rendered initial decision already contains a live
        // MODEL_002 A/B/C pattern, draw its role markers now that the chart
        // and historical candles are ready. bot-detail-ws.js also handles
        // subsequent live decisions through the same public helper.
        if (window.BOT_CONFIG && window.BOT_CONFIG.modelId === 'MODEL_002') {
          var initialChecks = window.NovaPendingPatternChecks || (window.BOT_INITIAL_DECISION && window.BOT_INITIAL_DECISION.checks);
          if (initialChecks && initialChecks.candle1 && initialChecks.candle2) {
            window.NovaChartPatternMarkers.setFromChecks(initialChecks);
          }
          window.NovaPendingPatternChecks = null;
        }
      }
    } catch (err) {
      console.error('[CHART] Failed to load candle history:', err);
      setChartState('Unable to load candle history.');
    } finally {
      historyLoaded = true;

      if (pendingLiveCandles.length) {
        var createdAtMsDrain = window.BOT_CONFIG && window.BOT_CONFIG.createdAtMs;
        var createdAtSecDrain = typeof createdAtMsDrain === 'number' ? Math.floor(createdAtMsDrain / 1000) : null;
        pendingLiveCandles
          .sort(function (a, b) { return a.time - b.time; })
          .filter(function (c) { return lastHistoricalTime === null || c.time >= lastHistoricalTime; })
          .filter(function (c) { return createdAtSecDrain === null || c.time >= createdAtSecDrain; })
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
