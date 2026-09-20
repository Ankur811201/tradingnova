'use strict';

const mongoose = require('mongoose');

const positionSchema = new mongoose.Schema(
  {
    environment: { type: String, enum: ['PAPER', 'LIVE'], required: true, index: true },
    source: { type: String, enum: ['MANUAL', 'BOT'], required: true, index: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    modelId: { type: String, default: null },
    instanceId: { type: String, default: null, index: true },
    // MODEL_002: the Support/Resistance level that created this position.
    // Immutable by workflow; used for level-specific loss accounting.
    entryLevelKey: { type: String, enum: ['S1','S2','S3','R1','R2','R3'], default: null, index: true },

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

    // User-defined 4-target exit plan. This is attached AFTER a position opens.
    // T1-T3 each have an independent 3-candle confirmation flow; T4 is immediate.
    targetExit: { type: mongoose.Schema.Types.Mixed, default: null },
    targets: { type: Array, default: [] },

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
