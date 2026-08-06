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
   * Universal Strategy Evaluator Registry
   * Evaluates current price action against assigned Bot Model logic
   */
  evaluateModelStrategy(modelId, config, currentPrice, candles = []) {
    switch (modelId) {
      case 'Model001':
        return this._evaluateModel001(config, currentPrice, candles);
      case 'Model002':
        return this._evaluateModel002(config, currentPrice, candles);
      default:
        return this._evaluateModel001(config, currentPrice, candles);
    }
  }

  /**
   * Strategy Logic for Model001 (Breakout & Trend Following)
   */
  _evaluateModel001(config, currentPrice, candles) {
    // Default or mock checks if candle history array isn't fully hydrated
    const emaVal = config.mockEma || currentPrice * 0.98;
    const supportVal = config.mockSupport || currentPrice * 0.95;
    const resistanceVal = config.mockResistance || currentPrice * 1.05;

    const factors = {
      trend: currentPrice > emaVal ? 'BULLISH' : 'BEARISH',
      emaPass: currentPrice > emaVal,
      supportPass: currentPrice > supportVal,
      resistancePass: currentPrice < resistanceVal,
      bodyRatioPass: true,
      volumePass: config.mockVolumePass ?? true
    };

    // Decision Logic
    let decision = 'WAIT';
    let humanReason = 'Waiting for valid breakout confirmation.';

    if (factors.emaPass && factors.supportPass && factors.volumePass) {
      if (currentPrice >= resistanceVal) {
        decision = 'BUY';
        humanReason = `Bullish breakout confirmed above resistance level $${resistanceVal}.`;
      }
    } else if (!factors.emaPass && currentPrice <= supportVal) {
      decision = 'SELL';
      humanReason = `Bearish breakdown confirmed below support level $${supportVal}.`;
    } else if (!factors.volumePass) {
      decision = 'REJECTED';
      humanReason = 'Signal rejected due to insufficient volume confirmation.';
    }

    // Default Take-Profit and Stop-Loss calculations (2% SL / 4% TP)
    const sl = decision === 'BUY' ? currentPrice * 0.98 : currentPrice * 1.02;
    const tp = decision === 'BUY' ? currentPrice * 1.04 : currentPrice * 0.96;

    return {
      decision,
      humanReason,
      factors,
      sl: Number(sl.toFixed(2)),
      tp: Number(tp.toFixed(2))
    };
  }

  /**
   * Strategy Logic Placeholder for Model002 (e.g. Mean Reversion)
   */
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