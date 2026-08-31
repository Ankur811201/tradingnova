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
    'confirmation, no EMA). Two active, separate engines. NEW engine (same-side: ' +
    'BULLISH+SUPPORT=BUY, BEARISH+RESISTANCE=SELL): the level-touch candle is Candle 2 and the ' +
    'candle before it is Candle 1, validated by BODY only (BUY: C2 body-high > C1 body-high; ' +
    'SELL: C2 body-low < C1 body-low) plus the existing BodyP/candle-nature checks -> boundaries ' +
    'fixed at Candle2.high+5 / Candle2.low-5 -> Candle 3 and every later candle evaluated against ' +
    'those same fixed boundaries; a wick touch of the trigger boundary fires immediately with no ' +
    'close required, a wrong-boundary touch is INVALID, and touching neither is WAIT. OLD engine ' +
    '(opposite-side: BULLISH+RESISTANCE=SELL, BEARISH+SUPPORT=BUY) is unchanged and does trade: ' +
    'Candle 1 (level touch, replaced by any newer touch until Candle 2 is found) -> Candle 2 ' +
    '(body-high/body-low touch, UpperP/LowerP/BodyP=2.5x body validation, correct candle nature) ' +
    '-> fixed Candle2.high/low boundaries monitored across future candles until a strict ' +
    'close-through triggers BUY/SELL or INVALID. Level selection is first-match-wins in both ' +
    'engines. Auto-pauses after 3 consecutive losses; layer/success safety limits apply per bot.',
  author: 'Nova Trade',
  supportedSymbols: [], // empty = no model-level restriction; RiskEngine's allowed-symbol list still applies
  defaultParameters: DEFAULT_PARAMETERS,
  // No higher-timeframe dependency — see config.js.
  requiredTimeframes: REQUIRED_TIMEFRAMES,
  create: (ctx) => new Model002(ctx),
};
