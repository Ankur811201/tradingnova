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
    'Client-driven custom-pattern strategy: user supplies trend (BULLISH/BEARISH) and up to 3 ' +
    'support + 3 resistance levels; no automatic trend/market analysis (no Daily BOS, no 1H ' +
    'confirmation, no EMA). Implements the confirmed counter-trend entry (BEARISH+SUPPORT=BUY, ' +
    'BULLISH+RESISTANCE=SELL) with the 1.5x body confirmation rule; the direct-entry cases ' +
    '(BULLISH+SUPPORT, BEARISH+RESISTANCE) are pending client confirmation and never trade. ' +
    'Auto-pauses after 3 consecutive losses.',
  author: 'Nova Trade',
  supportedSymbols: [], // empty = no model-level restriction; RiskEngine's allowed-symbol list still applies
  defaultParameters: DEFAULT_PARAMETERS,
  // No higher-timeframe dependency — see config.js.
  requiredTimeframes: REQUIRED_TIMEFRAMES,
  create: (ctx) => new Model002(ctx),
};
