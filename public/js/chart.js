/* global window, document, NovaApi */
(function () {
  'use strict';

  /**
   * Loads an official, read-only TradingView "Advanced Chart" embed for the
   * first configured allowed symbol, purely for visualization. This iframe is
   * NEVER used as a data source for the backend — Bot Models, RiskEngine, and
   * order execution only ever use the Part 1 MarketDataProvider. If no symbol
   * is configured or the embed can't be built, an accurate empty state is shown.
   */
  function tradingViewSymbolFor(symbol) {
    if (!symbol) return null;
    // Best-effort mapping of Nova Trade symbols (e.g. BTCUSD) to a
    // TradingView exchange:symbol pair. Adjust this mapping if your
    // configured symbols differ from common USD/USDT crypto pairs.
    const upper = symbol.toUpperCase();
    if (upper.endsWith('USDT')) return 'BINANCE:' + upper;
    if (upper.endsWith('USD')) return 'BINANCE:' + upper.replace('USD', 'USDT');
    return 'BINANCE:' + upper;
  }

  async function init() {
    const container = document.getElementById('chartContainer');
    if (!container) return;

    let symbol = null;
    try {
      const settings = await NovaApi.get('/api/settings');
      symbol = (settings.allowedSymbols && settings.allowedSymbols[0]) || null;
    } catch (_err) {
      symbol = null;
    }

    const tvSymbol = tradingViewSymbolFor(symbol);
    if (!tvSymbol) {
      container.innerHTML = '<div class="chart-empty">Market data unavailable — no symbol configured</div>';
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.title = 'TradingView chart (read-only)';
    iframe.src = 'https://s.tradingview.com/widgetembed/?symbol=' + encodeURIComponent(tvSymbol) +
      '&interval=15&theme=dark&style=1&hide_top_toolbar=0&hide_legend=0&saveimage=0';

    iframe.addEventListener('error', () => {
      container.innerHTML = '<div class="chart-empty">Chart unavailable</div>';
    });

    container.innerHTML = '';
    container.appendChild(iframe);
  }

  document.addEventListener('DOMContentLoaded', init);
})();

/**
 * Helper to dynamically create chart overlay markers for WebSocket signals
 * without modifying underlying candle renderers.
 */
window.addChartMarkerOverlay = function(botId, marker) {
  const container = document.getElementById(`chart-markers-${botId}`);
  if (!container) return;

  const markerEl = document.createElement('div');
  markerEl.className = `chart-marker-badge chart-marker-${marker.type.toLowerCase()}`;
  markerEl.style.left = `${marker.xPercent || 50}%`;
  markerEl.style.top = `${marker.yPercent || 50}%`;
  markerEl.innerHTML = `<span>${marker.label}</span>`;

  container.appendChild(markerEl);
};
