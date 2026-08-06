'use strict';

const Model001 = require('./Model001');
const { DEFAULT_PARAMETERS } = require('./config');

/**
 * Registration entry point. BotManager.discoverModels() scans
 * bot-models/<folder>/index.js at startup and registers whatever this
 * exports into BotModelMetadata — no other wiring is required for Model 001
 * to appear in GET /api/bot-models and the Part 2 Bot Management page.
 */
module.exports = {
  modelId: 'MODEL_001',
  modelVersion: '1.0.0',
  name: 'Model 001',
  description:
    'Configurable rule-based candle-pattern trading model. Ships with DEFAULT_RULESET_V1, ' +
    'an illustrative example rule set only — NOT the final client strategy. See ' +
    'bot-models/model-001/README.md.',
  author: 'Nova Trade',
  supportedSymbols: [], // empty = no model-level restriction; RiskEngine's allowed-symbol list still applies
  defaultParameters: DEFAULT_PARAMETERS,
  create: (ctx) => new Model001(ctx),
};
