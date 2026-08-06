'use strict';

const mongoose = require('mongoose');

/**
 * Generic strategy/bot event stream. Model 001 (Part 3) will emit events such as
 * "target detected", "setup captured", "confirmation passed", "signal generated".
 * Part 1 only provides the plumbing; no strategy-specific event types are hardcoded.
 */
const strategyEventSchema = new mongoose.Schema(
  {
    instanceId: { type: String, required: true, index: true },
    modelId: { type: String, required: true, index: true },
    symbol: { type: String, required: true },
    eventType: { type: String, required: true }, // free-form, defined by the Bot Model
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('StrategyEvent', strategyEventSchema);
