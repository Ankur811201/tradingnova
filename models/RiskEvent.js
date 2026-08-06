'use strict';

const mongoose = require('mongoose');

const riskEventSchema = new mongoose.Schema(
  {
    commandId: { type: String, required: true, index: true },
    instanceId: { type: String, default: null, index: true },
    modelId: { type: String, default: null },
    symbol: { type: String, required: true },
    environment: { type: String, enum: ['PAPER', 'LIVE'], required: true },
    action: { type: String, required: true },

    approved: { type: Boolean, required: true, index: true },
    reason: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

module.exports = mongoose.model('RiskEvent', riskEventSchema);
