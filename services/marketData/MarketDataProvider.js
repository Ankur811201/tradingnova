'use strict';

/**
 * Abstract base class / interface for market data providers.
 *
 * The rest of Nova Trade (PaperEngine, RiskEngine, Bot Models via BotManager)
 * must only ever talk to this interface — never to a concrete provider or
 * exchange SDK directly. This is what allows the data source to be swapped
 * (e.g. to an authorized TradingView-compatible feed) without touching any
 * downstream code.
 *
 * Concrete providers MUST:
 *  - never fabricate/interpolate/random-walk prices
 *  - stamp every update with a real receive timestamp
 *  - report freshness truthfully via isDataFresh()/getConnectionStatus()
 */
class MarketDataProvider {
  /** @returns {Promise<{symbol:string,price:number,timestamp:number}>} */
  async getPrice(_symbol) {
    throw new Error('MarketDataProvider.getPrice not implemented');
  }

  /** @returns {Promise<Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>>} */
  async getCandles(_symbol, _timeframe, _options = {}) {
    throw new Error('MarketDataProvider.getCandles not implemented');
  }

  /** @returns {() => void} unsubscribe function */
  subscribePrice(_symbol, _callback) {
    throw new Error('MarketDataProvider.subscribePrice not implemented');
  }

  /** @returns {() => void} unsubscribe function */
  subscribeCandles(_symbol, _timeframe, _callback) {
    throw new Error('MarketDataProvider.subscribeCandles not implemented');
  }

  /** @returns {{configured:boolean, connected:boolean, providerName:string, lastError:string|null}} */
  getConnectionStatus() {
    throw new Error('MarketDataProvider.getConnectionStatus not implemented');
  }

  /** @returns {boolean} */
  isDataFresh(_symbol) {
    throw new Error('MarketDataProvider.isDataFresh not implemented');
  }
}

module.exports = MarketDataProvider;
