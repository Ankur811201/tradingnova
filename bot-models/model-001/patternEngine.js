'use strict';

/**
 * Strategy Execution Core for Model001:
 *  - Dynamic lot sizing based on candle height in points
 *  - 1.5x Body Expansion Momentum Validation
 *  - 50-period EMA Trend Identification
 *  - Liquidity Sweep / Stop Hunt Rejections
 *  - Top/Bottom Level Touches & 3-Candle Cycle Swings
 */
function evaluateStrategy(candles, params, levelCounts) {
  const minRequired = 50;
  if (!candles || candles.length < minRequired) {
    // NOVA TRADE -- PART 8: observability only. `reason`/`analysis` are new,
    // additive fields for the real Decision Engine UI (see Model001.js) —
    // this branch's action outcome (NO_ACTION) is unchanged.
    return { action: 'NO_ACTION', reason: 'insufficient_history', analysis: null };
  }

  const currentIdx = candles.length - 1;
  const curr = candles[currentIdx];
  const prev = candles[currentIdx - 1];

  // Boundaries: Use explicitly provided parameters or fallback to lookback highs/lows
  const topLevel = params.topLevel || Math.max(...candles.slice(currentIdx - 20, currentIdx).map(c => c.high));
  const bottomLevel = params.bottomLevel || Math.min(...candles.slice(currentIdx - 20, currentIdx).map(c => c.low));

  // --- 1. Dynamic Lot Sizing (Candle Height in Points) ---
  const mintick = params.mintick || 0.01;
  const candlePoints = (curr.high - curr.low) / mintick;

  let dynamicLot = 1;
  if (candlePoints >= params.hiPoints) dynamicLot = params.lotHi;
  else if (candlePoints >= params.miPoints) dynamicLot = params.lotMi;
  else if (candlePoints >= params.loPoints) dynamicLot = params.lotLo;
  else if (candlePoints <= params.soatPoints) dynamicLot = params.lotSoat;

  // --- 2. 1.5x Body Expansion Rule ---
  const bodySize = Math.abs(curr.close - curr.open);
  const prevBodySize = Math.abs(prev.close - prev.open);
  const isValidBody15x = bodySize >= (prevBodySize * 1.5);

  // --- 3. 50 EMA Trend & 15-Bar Liquidity Sweep ---
  const ema50 = calculateEMA(candles, 50);
  const isUptrend = curr.close > ema50;
  const isDowntrend = curr.close < ema50;

  const recent15 = candles.slice(currentIdx - 15, currentIdx);
  const highest15 = Math.max(...recent15.map(c => c.high));
  const liquiditySweepHigh = curr.high > highest15 && curr.close < curr.open;

  // --- 4. Level Touch Detection ---
  const touchTop = curr.high >= topLevel;
  const touchBottom = curr.low <= bottomLevel;
  const touchL1 = touchTop || touchBottom;

  // --- 5. 3-Candle Cycle Swings ---
  const c1 = candles[currentIdx - 2];
  const c2 = candles[currentIdx - 1];
  const c3 = curr;

  const cycle3CandleBuy = (c3.close > c2.high) && (c2.high > c1.high);
  const cycle3CandleSell = (c3.close < c2.low) && (c2.low < c1.low);

  const maxTrades = params.maxTradesPerLevel || 2;

  // --- Trade Signal Resolution ---
  const l1AgainstSell = touchTop && isDowntrend && liquiditySweepHigh && isValidBody15x;
  const l1WithBuy = touchBottom && isUptrend && cycle3CandleBuy;

  // NOVA TRADE -- PART 8: real, already-computed values above, exposed for
  // the Decision Engine UI (see Model001.js -> BotManager -> bot:decision).
  // This is purely observability -- nothing below this point changes what
  // action gets returned or on what condition; every field here is one of
  // the variables already calculated earlier in this function. Volume is
  // intentionally NOT included: canonical candles carry no volume data
  // (see Candle.js / config.js volumeConfirmationEnabled), so there is
  // nothing real to report and the caller must show it as unavailable
  // rather than inventing a pass/fail.
  const analysis = {
    trend: isUptrend ? 'BULLISH' : isDowntrend ? 'BEARISH' : 'NEUTRAL',
    ema50,
    topLevel,
    bottomLevel,
    touchTop,
    touchBottom,
    bodySize,
    prevBodySize,
    isValidBody15x,
    liquiditySweepHigh,
    cycle3CandleBuy,
    cycle3CandleSell,
    candlePoints,
    dynamicLot,
  };

  if (touchL1 && levelCounts.l1 < maxTrades) {
    if (l1AgainstSell) {
      return {
        action: 'SHORT',
        ruleId: 'L1_AGAINST_SELL',
        reason: `Rejection Sweep at Resistance (${topLevel})`,
        lot: dynamicLot,
        slBufferPips: params.slBufferPips,
        levelUpdated: 'l1',
        analysis,
      };
    }
    if (l1WithBuy) {
      return {
        action: 'LONG',
        ruleId: 'L1_WITH_BUY',
        reason: `3-Candle Buy Cycle at Support (${bottomLevel})`,
        lot: dynamicLot,
        slBufferPips: params.slBufferPips,
        levelUpdated: 'l1',
        analysis,
      };
    }
  }

  return {
    action: 'NO_ACTION',
    reason: touchL1 ? 'level_touched_no_confirmation' : 'no_level_touch',
    analysis,
  };
}

function calculateEMA(candles, period) {
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 1; i < candles.length; i++) {
    ema = (candles[i].close * k) + (ema * (1 - k));
  }
  return ema;
}

module.exports = { evaluateStrategy };