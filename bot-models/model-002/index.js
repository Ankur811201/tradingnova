'use strict';

const Model002 = require('./Model002');
const { DEFAULT_PARAMETERS, REQUIRED_TIMEFRAMES } = require('./config');

/**
 * Registration entry point. BotManager.discoverModels() scans
 * bot-models/<folder>/index.js at startup and registers whatever this
 * exports into BotModelMetadata — identical, unmodified Part A/Part 1
 * discovery mechanism already used by MODEL_001 (see
 * bot-models/model-001/index.js). No BotManager changes were required.
 *
 * CURRENT CONFIRMED SCOPE — client-driven custom-pattern model. Trend and
 * support/resistance levels are supplied by the user at bot-configuration
 * time (see defaultParameters below and the Bot Management UI's dynamic
 * model-parameter form, which reads this object). No Daily BOS, no 1H
 * confirmation, no EMA — requiredTimeframes is intentionally empty.
 */
module.exports = {
  modelId: 'MODEL_002',
  modelVersion: '2.0.0',
  name: 'Model 002 — Custom Pattern',
  description:
    'Client-driven custom-pattern strategy: user supplies trend (BULLISH/BEARISH) and exactly 3 ' +
    'support + 3 resistance levels; no automatic trend/market analysis (no Daily BOS, no 1H ' +
    'confirmation, no EMA). One active NEW A/B/C engine is used for all four combinations: ' +
    'BULLISH+SUPPORT=BUY, BEARISH+SUPPORT=BUY, BULLISH+RESISTANCE=SELL, and ' +
    'BEARISH+RESISTANCE=SELL. The level-touch candle is Candle 2 and the candle before it is ' +
    'Candle 1, validated by BODY only (BUY: C2 body-high > C1 body-high; SELL: C2 body-low < ' +
    'C1 body-low) plus BodyP/candle-nature checks -> boundaries fixed at Candle2.high+5 / ' +
    'Candle2.low-5 -> Candle 3 and every later candle evaluated against those same fixed ' +
    'boundaries. A wick touch of the trigger boundary fires immediately on the running candle ' +
    'with no close required, a wrong-boundary touch is INVALID, and touching neither is WAIT. ' +
    'The first S1 setup for BEARISH+SUPPORT and first R1 setup for BULLISH+RESISTANCE are ' +
    'one-time stop-hunt calibration patterns and never trade; after calibration, S1/S2/S3 and ' +
    'R1/R2/R3 all use the same normal NEW pattern. Level selection is first-match-wins. ' +
    'Auto-pauses after 3 consecutive losses; layer/success safety limits apply per bot.',
  author: 'Nova Trade',
  supportedSymbols: [], // empty = no model-level restriction; RiskEngine's allowed-symbol list still applies
  defaultParameters: DEFAULT_PARAMETERS,
  // No higher-timeframe dependency — see config.js.
  requiredTimeframes: REQUIRED_TIMEFRAMES,
  create: (ctx) => new Model002(ctx),
};
