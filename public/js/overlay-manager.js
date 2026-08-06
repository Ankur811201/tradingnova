/**
 * Line series and price levels (EMA, SL, TP, Trailing Stop, S/R)
 */
class OverlayManager {
  constructor(chart, candlestickSeries) {
    this.chart = chart;
    this.series = candlestickSeries;
    
    // EMA Technical Line Series
    this.ema20Series = this.chart.addLineSeries({ color: '#2962ff', lineWidth: 1, title: 'EMA 20' });
    this.ema50Series = this.chart.addLineSeries({ color: '#ff9800', lineWidth: 1, title: 'EMA 50' });

    // Active Level Lines
    this.priceLines = {};
  }

  setIndicators(ema20Data, ema50Data) {
    if (ema20Data && ema20Data.length) this.ema20Series.setData(ema20Data);
    if (ema50Data && ema50Data.length) this.ema50Series.setData(ema50Data);
  }

  updateIndicators(time, ema20, ema50) {
    if (ema20) this.ema20Series.update({ time: Number(time), value: Number(ema20) });
    if (ema50) this.ema50Series.update({ time: Number(time), value: Number(ema50) });
  }

  setPriceLine(key, price, color, title, lineStyle = 2) {
    this.removePriceLine(key);
    if (!price || price <= 0) return;

    this.priceLines[key] = this.series.createPriceLine({
      price: Number(price),
      color: color,
      lineWidth: 1,
      lineStyle: lineStyle, // 0: Solid, 1: Dotted, 2: Dashed
      axisLabelVisible: true,
      title: title,
    });
  }

  removePriceLine(key) {
    if (this.priceLines[key]) {
      this.series.removePriceLine(this.priceLines[key]);
      delete this.priceLines[key];
    }
  }

  syncPositionOverlays(position) {
    if (!position || position.side === 'NONE') {
      this.removePriceLine('entry');
      this.removePriceLine('sl');
      this.removePriceLine('tp');
      this.removePriceLine('trailing');
      return;
    }

    this.setPriceLine('entry', position.entryPrice, '#2962ff', 'ENTRY', 0);
    this.setPriceLine('sl', position.stopLoss, '#f23645', 'STOP LOSS', 2);
    this.setPriceLine('tp', position.takeProfit, '#089981', 'TAKE PROFIT', 2);
    if (position.trailingStop) {
      this.setPriceLine('trailing', position.trailingStop, '#f5c037', 'TRAILING SL', 1);
    }
  }
}
window.OverlayManager = OverlayManager;