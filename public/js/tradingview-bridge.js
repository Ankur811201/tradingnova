/**
 * TradingView Bridge for Nova Trade Interactive Overlays
 */
class NovaChartBridge {
  constructor(containerId, symbol) {
    this.containerId = containerId;
    this.symbol = symbol;
    this.widget = null;
    this.shapes = new Map(); // Stores shape IDs for interactive overlays
    this.initChart();
  }

  initChart() {
    this.widget = new TradingView.widget({
      container_id: this.containerId,
      symbol: this.symbol,
      interval: '5',
      fullscreen: false,
      autosize: true,
      theme: 'Dark',
      style: '1',
      toolbar_bg: '#111827',
      enable_publishing: false,
      hide_side_toolbar: false,
      allow_symbol_change: false,
      disabled_features: ["header_symbol_search"]
    });

    this.widget.onChartReady(() => {
      console.log("[TV-Bridge] Chart Ready. Subscribing to shape interaction events.");
      this.widget.chart().onSelectedShapeChanged((shapeId) => {
        if (this.shapes.has(shapeId)) {
          const shapeData = this.shapes.get(shapeId);
          window.showOverlayModal(shapeData);
        }
      });
    });
  }

  /**
   * Universal Overlay Draw Method
   */
  addOrUpdateOverlay(id, type, points, options, metaData) {
    if (!this.widget) return;

    this.widget.onChartReady(() => {
      const chart = this.widget.chart();
      
      // Remove existing shape if updating
      if (this.shapes.has(id)) {
        chart.removeEntity(this.shapes.get(id).entityId);
      }

      // Draw Shape based on Overlay Classification
      let entityId = null;
      if (type === 'LINE') {
        entityId = chart.createMultipointShape(points, {
          shape: 'trend_line',
          lock: true,
          disableSelection: false,
          overrides: { lineColor: options.color, lineWidth: options.width || 1 }
        });
      } else if (type === 'MARKER') {
        entityId = chart.createShape(points[0], {
          shape: options.shape || 'arrow_up',
          lock: true,
          text: options.label || '',
          overrides: { color: options.color }
        });
      }

      if (entityId) {
        this.shapes.set(entityId, { entityId, ...metaData });
      }
    });
  }

  /**
   * High Level Utility to Synchronize Position Overlays
   */
  syncPositionLayers(position) {
    if (!position) return;

    // Draw Entry Line
    this.addOrUpdateOverlay('pos_entry', 'LINE', 
      [{ time: position.openTime, price: position.entryPrice }, { price: position.entryPrice }], 
      { color: '#3B82F6', width: 2 },
      { title: 'Position Entry', ...position }
    );

    // Draw Stop Loss Line
    this.addOrUpdateOverlay('pos_sl', 'LINE', 
      [{ time: position.openTime, price: position.stopLoss }, { price: position.stopLoss }], 
      { color: '#EF4444', width: 1 },
      { title: 'Stop Loss Target', ...position }
    );

    // Draw Take Profit Line
    this.addOrUpdateOverlay('pos_tp', 'LINE', 
      [{ time: position.openTime, price: position.takeProfit }, { price: position.takeProfit }], 
      { color: '#10B981', width: 1 },
      { title: 'Take Profit Target', ...position }
    );
  }
}

window.NovaChartBridge = NovaChartBridge;