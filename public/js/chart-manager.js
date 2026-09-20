/**
 * Master Chart Controller encapsulating Lightweight Charts initialization
 */
class ChartManager {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    
    this.chart = LightweightCharts.createChart(this.container, {
      layout: {
        background: { type: 'solid', color: '#ffffff' },
        textColor: '#131722',
        fontSize: 11,
        fontFamily: 'JetBrains Mono, monospace',
      },
      grid: {
        vertLines: { color: '#e0e3eb' },
        horzLines: { color: '#e0e3eb' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: '#d1d4dc',
        autoScale: true,
      },
      timeScale: {
        borderColor: '#d1d4dc',
        timeVisible: true,
        secondsVisible: false,
        // Keep the latest candle visually separated from the right chart edge.
        // This is shared by the live chart and the server-side recording so
        // their candle placement remains visually consistent.
        rightOffset: 3,
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

  // Replace the complete canonical candle snapshot without creating a new
  // chart or series. The server-side recorder uses this to keep every frame
  // deterministic: the frame always contains the same full candle history
  // that was supplied in the recording snapshot, followed by the live candle.
  // This is intentionally separate from onLiveCandle(), which remains the
  // normal browser live-update path.
  replaceCandleSnapshot(candles) {
    if (!Array.isArray(candles) || !candles.length) return;
    this.candleSeries.setData(candles);
    this.chart.timeScale().scrollToRealTime();
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

  /**
   * MODEL_002 pattern-role markers. These are purely visual and are kept
   * separate inside MarkerManager so they can never erase execution markers.
   */
  setPatternMarkers(markers) {
    this.markerManager.setPatternMarkers(markers);
  }

  clearPatternMarkers() {
    this.markerManager.clearPatternMarkers();
  }

  loadTargetMarkers(markers) {
    this.markerManager.setTargetMarkers(markers);
  }

  addTargetMarker(marker) {
    this.markerManager.addTargetMarker(marker);
  }
}
window.ChartManager = ChartManager;