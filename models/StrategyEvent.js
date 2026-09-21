'use strict';

const mongoose = require('mongoose');

/**
 * Generic strategy/bot event stream. Decision events are compacted by
 * BotManager when the same decision/reason state repeats consecutively.
 */
const strategyEventSchema = new mongoose.Schema(
  {
    instanceId: { type: String, required: true, index: true },
    modelId: { type: String, required: true, index: true },
    symbol: { type: String, required: true },
    eventType: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now, index: true },
    firstSeenAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    occurrences: { type: Number, default: 1, min: 1 },
    historyKey: { type: String, default: null, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('StrategyEvent', strategyEventSchema);
