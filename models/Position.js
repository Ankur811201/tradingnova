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
    quantity: { type: Number, required: true }, // REMAINING quantity — reduced by each partial target fill
    originalQuantity: { type: Number, default: null }, // fixed at entry, only set for positions with multi-target exits (stopLoss present at open)
    leverage: { type: Number, required: true, default: 1 },

    margin: { type: Number, required: true }, // REMAINING locked margin — reduced proportionally by each partial fill

    stopLoss: { type: Number, default: null }, // NEVER changes for a multi-target position — no breakeven, no trailing
    takeProfit: { type: Number, default: null }, // left null for multi-target positions — see `targets` instead

    // Multi-target exit plan (confirmed rules): up to 4 R-multiple targets,
    // each closing 25% of originalQuantity. Empty array = no multi-target
    // plan (stopLoss was not provided at open) — existing single-TP
    // behavior applies unchanged for such positions.
    targets: {
      type: [{
        rMultiple: { type: Number, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, required: true },
        hit: { type: Boolean, default: false },
        hitAt: { type: Date, default: null },
      }],
      default: [],
    },

    unrealizedPnl: { type: Number, default: 0 },
    realizedPnl: { type: Number, default: 0 }, // accumulates partial-fill PnL as targets hit; the final close adds the last slice on top
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
