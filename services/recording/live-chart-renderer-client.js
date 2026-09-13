'use strict';

/**
 * Server-side recording page bridge.
 *
 * IMPORTANT: this file deliberately does NOT implement a second chart.
 * The production bot-detail chart (`public/js/bot-detail-chart.js`) is loaded
 * below and is initialized through its normal ChartManager/CandleSeries/
 * OverlayManager pipeline. This bridge only supplies the server snapshot and
 * forwards subsequent state updates to the already-created production chart.
 */
(function () {
  function fmt(value) {
    const n = Number(value);
    return Number.isFinite(n)
      ? n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 })
      : '--';
  }

  function timeframeSeconds(tf) {
    const m = String(tf || '1m').match(/^(\d+)(m|h|d)$/i);
    if (!m) return 60;
    const n = Number(m[1]);
    return n * ({ m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()] || 60);
  }

  function applyRecordingState(state) {
    const level = state.level || {};
    const isManual = !state.level || state.direction === 'MANUAL';
    const side = level.side === 'SUPPORT' ? 'S' : 'R';
    const index = level.index || 1;

    const rec = document.getElementById('rec');
    if (rec) rec.textContent = isManual ? '● RECORDING 1 FPS • MANUAL' : `● RECORDING 1 FPS • ${side}${index}`;

    const subtitle = document.getElementById('subtitle');
    if (subtitle) subtitle.textContent = `${state.symbol || '--'} • ${state.timeframe || '--'} • MODEL_002`;

    const trend = document.getElementById('trend');
    if (trend) trend.textContent = state.trend || '--';

    const support = document.getElementById('support');
    if (support) support.textContent = (state.support || []).map((p, i) => `S${i + 1} ${fmt(p)}`).join(' • ') || '--';

    const resistance = document.getElementById('resistance');
    if (resistance) resistance.textContent = (state.resistance || []).map((p, i) => `R${i + 1} ${fmt(p)}`).join(' • ') || '--';

    const decision = state.decision || {};
    const pattern = document.getElementById('pattern');
    if (pattern) pattern.textContent = decision.patternState || 'IDLE';

    const decisionEl = document.getElementById('decision');
    if (decisionEl) {
      const value = decision.decision || 'WAIT';
      decisionEl.textContent = value;
      decisionEl.style.color = value === 'SELL' ? '#fb7185' : value === 'BUY' ? '#34d399' : '#60a5fa';
    }

    const reason = document.getElementById('reason');
    if (reason) reason.textContent = decision.reason || (isManual ? 'Manual recording' : `${side}${index} touched`);

    const touched = document.getElementById('level');
    if (touched) touched.textContent = level.side ? `${level.side} ${level.index} • ${fmt(level.price)}` : '--';

    const price = Number(state.currentPrice);
    const priceLabel = document.getElementById('chart-price-label');
    const priceText = document.getElementById('chart-current-price');
    const countdownText = document.getElementById('chart-next-candle');
    const elapsed = document.getElementById('elapsed');

    if (Number.isFinite(price) && window.NovaChartPriceLabel) {
      window.NovaChartPriceLabel.setPrice(price);
      if (priceText) priceText.textContent = fmt(price);
    } else if (priceLabel) {
      priceLabel.classList.add('hidden');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const tf = timeframeSeconds(state.timeframe);
    const next = Math.max(0, tf - (nowSec % tf));
    if (countdownText) countdownText.textContent = `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`;

    const startedAt = Number(state.startedAt);
    if (elapsed) elapsed.textContent = `● ${Number.isFinite(startedAt) ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0}s • 1 FPS`;

    // These are the same public overlay helpers created by the production
    // bot-detail chart. We only forward backend state; we never derive a new
    // pattern or redraw candles here.
    const checks = decision.checks || null;
    if (window.NovaChartPatternMarkers && typeof window.NovaChartPatternMarkers.setFromChecks === 'function') {
      window.NovaChartPatternMarkers.setFromChecks(checks);
    }

    const group = checks && checks.patternVisual;
    const boundaries = checks && checks.boundaries;
    if (window.NovaChartPatternOverlay) {
      if (group && boundaries && boundaries.upper != null && boundaries.lower != null &&
          typeof window.NovaChartPatternOverlay.setBoundaries === 'function') {
        window.NovaChartPatternOverlay.setBoundaries(boundaries.upper, boundaries.lower, group.direction);
      } else if (typeof window.NovaChartPatternOverlay.clearBoundaries === 'function') {
        window.NovaChartPatternOverlay.clearBoundaries();
      }

      if (typeof window.NovaChartPatternOverlay.setBodyReference === 'function' &&
          typeof window.NovaChartPatternOverlay.clearBodyReference === 'function') {
        const ref = checks && checks.bodyReference;
        if (ref) window.NovaChartPatternOverlay.setBodyReference(ref);
        else window.NovaChartPatternOverlay.clearBodyReference();
      }
    }
  }

  function setCandleSnapshot(state) {
    const chart = window.NovaBotChartManager;
    if (!chart) return false;

    const candles = Array.isArray(state.candles) ? state.candles : [];
    if (!candles.length) return false;

    // The recording state is authoritative. Do not rely on the recorder page
    // having retained a private copy of the history after initialization.
    // Every update supplies the complete validated snapshot, so the chart can
    // never degrade into a single-candle/zero-scale frame.
    if (typeof chart.replaceCandleSnapshot === 'function') {
      chart.replaceCandleSnapshot(candles);
    } else {
      // Defensive fallback for an older ChartManager.
      const series = chart.candleSeries && chart.candleSeries.candlestickSeries;
      if (!series || typeof series.setData !== 'function') return false;
      series.setData(candles.map(c => ({
        time: Number(c.time),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      })));
      if (chart.chart && chart.chart.timeScale) chart.chart.timeScale().scrollToRealTime();
    }

    return true;
  }

  window.NovaRecordingInit = function (state) {
    window.__novaRecordingState = state || {};
    // bot-detail-chart.js owns chart initialization. The renderer page sets
    // BOT_CONFIG + a local fetch shim before that script is loaded.
    applyRecordingState(window.__novaRecordingState);
    window.__novaRecordingReady = !!window.NovaBotChartManager;
    return window.__novaRecordingReady;
  };

  window.NovaRecordingUpdate = function (state) {
    window.__novaRecordingState = state || {};
    setCandleSnapshot(window.__novaRecordingState);
    applyRecordingState(window.__novaRecordingState);
    return true;
  };
})();
