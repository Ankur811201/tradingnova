/**
 * Consumes EXISTING backend WebSockets without changing event signatures.
 */
class ChartSync {
  constructor(chartManager, eventHandlers = {}) {
    this.cm = chartManager;
    this.handlers = eventHandlers;
    this.socket = null;
  }

  connect(wsUrl) {
    this.socket = new WebSocket(wsUrl);

    this.socket.onopen = () => {
      if (this.handlers.onHealthChange) this.handlers.onHealthChange('wsConnected', true);
    };

    this.socket.onclose = () => {
      if (this.handlers.onHealthChange) this.handlers.onHealthChange('wsConnected', false);
      setTimeout(() => this.connect(wsUrl), 3000);
    };

    this.socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        this.routeEvent(payload.event, payload.data);
      } catch (err) {
        console.error("WS Parse Error", err);
      }
    };
  }

  routeEvent(eventName, data) {
    switch (eventName) {
      case 'candle_update':
      case 'kline':
        this.cm.onLiveCandle(data.candle, data.indicators);
        if (this.handlers.onCandle) this.handlers.onCandle(data);
        break;

      case 'decision_update':
      case 'strategy_decision':
        if (this.handlers.onDecision) this.handlers.onDecision(data);
        break;

      case 'position_update':
      case 'trade_execution':
        this.cm.overlayManager.syncPositionOverlays(data.position);
        if (data.execution) this.cm.markerManager.addMarker(data.execution);
        if (this.handlers.onPosition) this.handlers.onPosition(data);
        break;

      case 'log_event':
        if (this.handlers.onLog) this.handlers.onLog(data);
        break;

      default:
        break;
    }
  }
}
window.ChartSync = ChartSync;