'use strict';

const mongoose = require('mongoose');

/**
 * A Trade represents a completed round-trip (open->close) or a partial close event,
 * used for history, reporting, and future Strategy Playback.
 */
const tradeSchema = new mongoose.Schema(
  {
    environment: { type: String, enum: ['PAPER', 'LIVE'], required: true, index: true },
    source: { type: String, enum: ['MANUAL', 'BOT'], required: true, index: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    modelId: { type: String, default: null },
    instanceId: { type: String, default: null, index: true },

    position: { type: mongoose.Schema.Types.ObjectId, ref: 'Position', required: true },
    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ['LONG', 'SHORT'], required: true },

    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, required: true },
    quantity: { type: Number, required: true },
    leverage: { type: Number, required: true },

    realizedPnl: { type: Number, required: true },
    fees: { type: Number, required: true },

    reason: { type: String, default: null },
    openedAt: { type: Date, required: true },
    closedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Trade', tradeSchema);
