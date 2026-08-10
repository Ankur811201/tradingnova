'use strict';

const mongoose = require('mongoose');

/**
 * Registry entry for a Bot Model implementation discovered under /bot-models.
 * Part 1 ships with no strategy models; Part 3 will register Model 001 here
 * (registration happens automatically via BotManager.discoverModels()).
 */
const botModelMetadataSchema = new mongoose.Schema(
  {
    modelId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    version: { type: String, required: true },
    description: { type: String, default: '' },
    author: { type: String, default: '' },
    supportedSymbols: [{ type: String }],
    defaultParameters: { type: mongoose.Schema.Types.Mixed, default: {} },

    // PART A (multi-timeframe infra): optional declaration of ADDITIONAL
    // timeframes a model needs beyond its own BotInstance.parameters.timeframe
    // (the model's entry/dispatch timeframe, unchanged). Each entry names how
    // much closed-candle history that timeframe needs hydrated. Empty for any
    // model that doesn't set it (e.g. MODEL_001) — zero behavior change for
    // existing single-timeframe models.
    requiredTimeframes: {
      type: [{
        timeframe: { type: String, required: true },
        history: { type: Number, required: true },
        _id: false,
      }],
      default: [],
    },

    isEnabled: { type: Boolean, default: true },
    registeredAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BotModelMetadata', botModelMetadataSchema);
