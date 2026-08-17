'use strict';

/**
 * NOVA TRADE — CHART PRICE-AXIS LABEL
 * ===================================
 *
 * A single compact TradingView-style label pinned to the RIGHT PRICE AXIS,
 * carrying two values and nothing else:
 *
 *      ┌───────────┐
 *      │ 63,636.5  │   <- live price (larger)
 *      │   00:31   │   <- next-candle countdown (smaller)
 *      └───────────┘
 *
 * WHY A DOM OVERLAY
 * -----------------
 * Lightweight Charts 4.1.3 (the version already loaded by this page) has no
 * API for putting arbitrary multi-line content into a price-axis label:
 * `lastValueVisible` / `createPriceLine` render a single formatted number
 * drawn on the library's own canvas, with no hook for a second line. So the
 * label is a DOM element — but, unlike the floating card it replaces, its Y
 * position is NOT decorative: it is computed every update from
 * `series.priceToCoordinate(price)`, the chart's own price->pixel
 * conversion. It therefore tracks the price level exactly as the built-in
 * label would, through zoom, scroll, autoscale and resize.
 *
 * OWNERSHIP / NON-DUPLICATION
 * ---------------------------
 *   price      <- the EXISTING market:price handler in bot-detail-ws.js
 *                 (one listener, one socket) calls setPrice()
 *   countdown  <- the EXISTING next-candle-countdown.js render pass writes
 *                 #chart-next-candle, which lives INSIDE this label
 *                 (one interval, same value as #stat-next-candle)
 *
 * This module owns no socket, no interval, and no countdown maths.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // tests
  if (root) root.NovaChartPriceLabel = api;
}(typeof window !== 'undefined' ? window : null, function () {

  const EDGE_PADDING = 2; // px kept between the label and the chart's top/bottom

  /**
   * Y position (px, label CENTER) for `price`, clamped so the label is never
   * clipped at the top or bottom of the chart. Pure — unit-testable without
   * a DOM or a chart.
   *
   * @param {number|null} coordinate  series.priceToCoordinate(price)
   * @param {number} chartHeight
   * @param {number} labelHeight
   * @returns {number|null} null when the price has no coordinate (off-scale
   *   or no data yet) — the caller hides the label rather than guessing.
   */
  function clampCoordinate(coordinate, chartHeight, labelHeight) {
    if (!Number.isFinite(coordinate)) return null;
    if (!Number.isFinite(chartHeight) || chartHeight <= 0) return coordinate;
    const half = (Number.isFinite(labelHeight) ? labelHeight : 0) / 2;
    const min = half + EDGE_PADDING;
    const max = chartHeight - half - EDGE_PADDING;
    if (max < min) return chartHeight / 2; // chart smaller than the label
    return Math.min(Math.max(coordinate, min), max);
  }

  /**
   * The project's existing chart price convention — the same
   * `toLocaleString('en-US')`-based grouping the dashboard/chart already
   * used, with the market's own decimals preserved (no new precision rule,
   * no invented rounding).
   */
  function formatPrice(price) {
    if (!Number.isFinite(price)) return '--';
    return price.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  }

  let active = null;

  /**
   * @param {object} opts
   * @param {object} opts.chartManager  the EXISTING ChartManager instance
   * @param {HTMLElement} opts.container the chart's positioned wrapper
   * @param {HTMLElement} opts.label     the label element to position
   */
  function attach(opts) {
    const options = opts || {};
    const chartManager = options.chartManager;
    const container = options.container;
    const label = options.label;
    if (!chartManager || !container || !label) return null;

    const series = chartManager.candleSeries && chartManager.candleSeries.candlestickSeries;
    const chart = chartManager.chart;
    if (!series || !chart) return null;

    detach(); // re-attach safe: never leave two labels or two subscriptions

    let lastPrice = null;
    let resizeObserver = null;

    function hide() {
      label.classList.add('hidden');
    }

    function position() {
      if (!Number.isFinite(lastPrice)) { hide(); return; }

      let coordinate = null;
      try {
        coordinate = series.priceToCoordinate(lastPrice);
      } catch (err) {
        coordinate = null; // no data on the series yet
      }

      const y = clampCoordinate(coordinate, container.clientHeight, label.offsetHeight);
      if (y === null) { hide(); return; }

      label.classList.remove('hidden');
      label.style.top = y + 'px';
    }

    /** Called by the EXISTING market:price handler — no listener of our own. */
    function setPrice(price) {
      if (!Number.isFinite(price)) return;
      lastPrice = price;
      const priceEl = label.querySelector('#chart-current-price');
      if (priceEl) priceEl.textContent = formatPrice(price);
      position();
    }

    // Re-position on everything that can move the price->pixel mapping:
    // pan/zoom (visible range), autoscale after a new candle, and any
    // container/browser resize or chart-height change.
    const onRangeChange = () => position();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => position());
      resizeObserver.observe(container);
    }

    active = {
      setPrice,
      position,
      get lastPrice() { return lastPrice; },
      detach() {
        try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange); } catch (err) { /* chart already disposed */ }
        if (resizeObserver) resizeObserver.disconnect();
        active = null;
      },
    };
    return active;
  }

  function detach() {
    if (active) active.detach();
  }

  /** Convenience used by the market:price handler; no-op before the chart exists. */
  function setPrice(price) {
    if (active) active.setPrice(price);
  }

  return {
    attach,
    detach,
    setPrice,
    position() { if (active) active.position(); },
    clampCoordinate,
    formatPrice,
    EDGE_PADDING,
    get current() { return active; },
  };
}));
