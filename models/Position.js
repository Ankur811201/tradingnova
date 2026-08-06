'use strict';

const mongoose = require('mongoose');

const positionSchema = new mongoose.Schema(
  {
    environment: { type: String, enum: ['PAPER', 'LIVE'], required: true, index: true },
    source: { type: String, enum: ['MANUAL', 'BOT'], required: true, index: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    modelId: { type: String, default: null },
    instanceId: { type: String, default: null, index: true },

    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ['LONG', 'SHORT'], required: true },

    entryPrice: { type: Number, required: true },
    currentPrice: { type: Number, required: true },
    quantity: { type: Number, required: true },
    leverage: { type: Number, required: true, default: 1 },

    margin: { type: Number, required: true }, // locked margin (paper) or exchange margin (live, informational)

    stopLoss: { type: Number, default: null },
    takeProfit: { type: Number, default: null },

    unrealizedPnl: { type: Number, default: 0 },
    realizedPnl: { type: Number, default: 0 },
    feesPaid: { type: Number, default: 0 },

    status: { type: String, enum: ['OPEN', 'CLOSED', 'LIQUIDATED'], required: true, default: 'OPEN', index: true },

    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date, default: null },
    closeReason: { type: String, default: null }, // MANUAL, STOP_LOSS, TAKE_PROFIT, BOT_SIGNAL, SAFETY_CLOSE_ALL, LIQUIDATION
  },
  { timestamps: true }
);

positionSchema.index({ environment: 1, source: 1, status: 1, symbol: 1 });

module.exports = mongoose.model('Position', positionSchema);
