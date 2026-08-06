/**
 * Master Chart Controller encapsulating Lightweight Charts initialization
 */
class ChartManager {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    
    this.chart = LightweightCharts.createChart(this.container, {
      layout: {
        background: { type: 'solid', color: '#131722' },
        textColor: '#d1d4dc',
        fontSize: 11,
        fontFamily: 'JetBrains Mono, monospace',
      },
      grid: {
        vertLines: { color: '#1e222d' },
        horzLines: { color: '#1e222d' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: '#2a2e39',
        autoScale: true,
      },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    this.candleSeries = new CandleSeriesManager(this.chart);
    this.markerManager = new MarkerManager(this.candleSeries.candlestickSeries);
    this.overlayManager = new OverlayManager(this.chart, this.candleSeries.candlestickSeries);

    this.initResizeObserver();
  }

  initResizeObserver() {
    const observer = new ResizeObserver(entries => {
      if (entries.length === 0 || !entries[0].contentRect) return;
      const { width, height } = entries[0].contentRect;
      this.chart.applyOptions({ width, height });
    });
    observer.observe(this.container);
  }

  loadHistoricalData(candles, indicators = {}) {
    this.candleSeries.setData(candles);
    if (indicators.ema20 && indicators.ema50) {
      this.overlayManager.setIndicators(indicators.ema20, indicators.ema50);
    }
    this.chart.timeScale().fitContent();
  }

  onLiveCandle(candle, indicators = {}) {
    this.candleSeries.updateSingle(candle);
    if (indicators.ema20 || indicators.ema50) {
      this.overlayManager.updateIndicators(candle.time, indicators.ema20, indicators.ema50);
    }
  }

  // NOVA TRADE -- PART 10: real executed BUY/SELL/EXIT markers. Both methods
  // just delegate to MarkerManager (which owns dedup/merge state) -- no raw
  // Lightweight Charts marker API is exposed outside this class.

  /** Historical execution markers, loaded once alongside loadHistoricalData(). */
  loadExecutionMarkers(markers) {
    this.markerManager.loadExecutionMarkers(markers);
  }

  /** A single live execution marker (real entry or exit), added without disturbing existing ones. */
  addExecutionMarker(marker) {
    this.markerManager.addExecutionMarker(marker);
  }
}
window.ChartManager = ChartManager;