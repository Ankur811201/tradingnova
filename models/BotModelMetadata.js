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
    isEnabled: { type: Boolean, default: true },
    registeredAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BotModelMetadata', botModelMetadataSchema);
