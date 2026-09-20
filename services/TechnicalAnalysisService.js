/**
 * Technical Analysis Service
 * Calculates technical indicators and evaluates strategy models
 *
 * NOVA TRADE -- PART 7 NOTE:
 * This service has ZERO trading authority. It is only ever called from
 * BotEngineManager (legacy telemetry) for the bot-detail "Decision Engine"
 * UI panel. Its `evaluateModelStrategy` output (including the mock
 * `currentPrice * 0.98` / `* 0.95` / `* 1.05` style checks below) must
 * NEVER be wired into RiskEngine, ExecutionRouter, PaperEngine, LiveEngine,
 * or any Trade/Position/authoritative-Signal write. Real trading decisions
 * come exclusively from MODEL_001 (bot-models/model-001) via
 * BotManager._handleTradeCommand(). Do not "improve" the mock math here to
 * make it more realistic -- that is a separate, later migration.
 */
class TechnicalAnalysisService {
  /**
   * Calculate Exponential Moving Average (EMA)
   * @param {Array<number>} prices Array of historical close prices
   * @param {number} period Lookback period (e.g., 20, 50)
   */
  calculateEMA(prices, period) {
    if (!prices || prices.length < period) return null;

    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return Number(ema.toFixed(4));
  }

  /**
   * Calculate Average True Range (ATR)
   * @param {Array<{high: number, low: number, close: number}>} candles
   * @param {number} period Lookback period (default 14)
   */
  calculateATR(candles, period = 14) {
    if (!candles || candles.length <= period) return null;

    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trs.push(tr);
    }

    const atr = trs.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    return Number(atr.toFixed(4));
  }

  /**
   * Detect Support and Resistance Key Levels
   * @param {Array<{high: number, low: number}>} candles
   * @param {number} lookback Lookback candles range
   */
  detectSupportResistance(candles, lookback = 20) {
    if (!candles || candles.length < lookback) {
      return { support: null, resistance: null };
    }

    const recent = candles.slice(-lookback);
    const highs = recent.map((c) => c.high);
    const lows = recent.map((c) => c.low);

    return {
      resistance: Math.max(...highs),
      support: Math.min(...lows)
    };
  }

  /**
   * Universal Strategy Evaluator Registry. MODEL_002 is the only active
   * strategy model. This service remains telemetry/UI-only; authoritative
   * trading decisions come from the registered bot model through BotManager.
   */
  evaluateModelStrategy(modelId, config, currentPrice, candles = []) {
    if (modelId === 'MODEL_002' || modelId === 'Model002') {
      return this._evaluateModel002(config, currentPrice, candles);
    }
    return {
      decision: 'WAIT',
      humanReason: 'No active technical-analysis evaluator is registered for this model.',
      factors: {},
    };
  }

  _evaluateModel002(config, currentPrice) {
    return {
      decision: 'WAIT',
      humanReason: 'Model002 strategy engine evaluating mean-reversion channels.',
      factors: { rsiDivergence: 'NONE', orderbookSpread: 'NORMAL' },
      sl: currentPrice * 0.99,
      tp: currentPrice * 1.02
    };
  }
}

module.exports = new TechnicalAnalysisService();