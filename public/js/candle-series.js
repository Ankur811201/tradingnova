/**
 * Modular Series Handler for Candles and Volume
 */
class CandleSeriesManager {
  constructor(chart) {
    this.chart = chart;
    
    this.candlestickSeries = this.chart.addCandlestickSeries({
      upColor: '#089981',
      downColor: '#f23645',
      borderVisible: false,
      wickUpColor: '#089981',
      wickDownColor: '#f23645',
    });

    this.volumeSeries = this.chart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: { type: 'volume' },
      priceScaleId: '', 
      scaleMargins: { top: 0.8, bottom: 0 },
    });
  }

  setData(candles) {
    const formattedCandles = candles.map(c => ({
      time: Number(c.time),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }));

    const formattedVolume = candles.map(c => ({
      time: Number(c.time),
      value: Number(c.volume),
      color: Number(c.close) >= Number(c.open) ? 'rgba(8, 153, 129, 0.4)' : 'rgba(242, 54, 69, 0.4)'
    }));

    this.candlestickSeries.setData(formattedCandles);
    this.volumeSeries.setData(formattedVolume);
  }

  updateSingle(candle) {
    const time = Number(candle.time);
    this.candlestickSeries.update({
      time,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close)
    });

    this.volumeSeries.update({
      time,
      value: Number(candle.volume),
      color: Number(candle.close) >= Number(candle.open) ? 'rgba(8, 153, 129, 0.4)' : 'rgba(242, 54, 69, 0.4)'
    });
  }
}
window.CandleSeriesManager = CandleSeriesManager;