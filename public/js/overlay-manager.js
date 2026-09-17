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

  /**
   * A single horizontal SEGMENT bounded between two timestamps (as opposed
   * to setPriceLine's full-width line, which spans the entire chart).
   * Used only by the MODEL_002 C1 body-reference line, which must be
   * visually confined to C1->C2 rather than drawn across the whole chart.
   * Implemented as its own tiny 2-point line series (same primitive as
   * ema20Series/ema50Series above) rather than reusing createPriceLine,
   * which has no notion of a time range. One fixed key
   * ('bodyReferenceSegment') means re-syncing replaces rather than
   * duplicates, exactly like setPriceLine's dedup above.
   */
  setLineSegment(key, fromTime, toTime, price, color, title) {
    this.removeLineSegment(key);
    const p = Number(price);
    const from = Number(fromTime);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(from)) return;
    // toTime can legitimately be unknown yet (Candle 2 hasn't touched); a
    // series needs two distinct ascending points, so extend by a minimal
    // 1-unit stub that the next re-sync (once Candle 2 is known, or the
    // pattern resolves) immediately replaces with the real endpoint.
    let to = Number(toTime);
    if (!Number.isFinite(to) || to <= from) to = from + 1;

    this.lineSegments = this.lineSegments || {};
    this.lineSegments[key] = this.chart.addLineSeries({
      color,
      lineWidth: 1,
      lineStyle: 1, // Dotted
      title,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    this.lineSegments[key].setData([
      { time: from, value: p },
      { time: to, value: p },
    ]);
  }

  removeLineSegment(key) {
    if (this.lineSegments && this.lineSegments[key]) {
      this.chart.removeSeries(this.lineSegments[key]);
      delete this.lineSegments[key];
    }
  }

  setTargetExitLines(position) {
    const plan = position && position.targetExitPlan && position.targetExitPlan.enabled
      ? position.targetExitPlan : null;
    const targets = plan && Array.isArray(plan.targets) ? plan.targets : [];
    for (let i = 1; i <= 4; i++) {
      const t = targets.find(x => Number(x.index) === i);
      this.setPriceLine(
        `target-${i}`,
        t && t.price,
        i === 4 ? '#f43f5e' : '#f59e0b',
        `T${i}${t && t.exitPercent != null ? ` ${Number(t.exitPercent).toFixed(2)}%` : ''}`,
        0
      );
    }
  }

  clearTargetExitLines() {
    for (let i = 1; i <= 4; i++) this.removePriceLine(`target-${i}`);
  }

  syncPositionOverlays(position) {
    if (!position || position.status === 'CLOSED' || position.status === 'LIQUIDATED' || position.side === 'NONE') {
      this.removePriceLine('entry');
      this.removePriceLine('sl');
      this.removePriceLine('tp');
      this.removePriceLine('trailing');
      this.clearTargetExitLines();
      return;
    }

    this.setPriceLine('entry', position.entryPrice, '#2962ff', 'ENTRY', 0);
    this.setPriceLine('sl', position.stopLoss, '#f23645', 'STOP LOSS', 2);
    this.setPriceLine('tp', position.takeProfit, '#089981', 'TAKE PROFIT', 2);
    if (position.trailingStop) {
      this.setPriceLine('trailing', position.trailingStop, '#f5c037', 'TRAILING SL', 1);
    }
    this.setTargetExitLines(position);
  }
}
window.OverlayManager = OverlayManager;