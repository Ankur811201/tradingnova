/**
 * Modular Series Handler for Candlesticks
 *
 * Price candles only. Volume histogram rendering has been removed.
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
  }

  setData(candles) {
    const formattedCandles = candles.map(c => ({
      time: Number(c.time),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }));

    this.candlestickSeries.setData(formattedCandles);
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
  }
}
window.CandleSeriesManager = CandleSeriesManager;
