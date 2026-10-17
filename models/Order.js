'use strict';

const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    internalOrderId: { type: String, required: true, unique: true, index: true },
    externalOrderId: { type: String, default: null, index: true }, // Delta order id, null for paper

    environment: { type: String, enum: ['PAPER', 'LIVE'], required: true, index: true },
    source: { type: String, enum: ['MANUAL', 'BOT'], required: true, index: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    modelId: { type: String, default: null },
    instanceId: { type: String, default: null, index: true },
    commandId: { type: String, default: null, index: true }, // originating TradeCommand id, for idempotency

    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    type: { type: String, enum: ['market', 'limit'], required: true, default: 'market' },

    quantity: { type: Number, required: true },
    requestedPrice: { type: Number, default: null },
    executedPrice: { type: Number, default: null },

    leverage: { type: Number, default: 1 },
    stopLoss: { type: Number, default: null },
    takeProfit: { type: Number, default: null },

    fees: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'CANCELLED', 'ERROR', 'UNKNOWN'],
      required: true,
      default: 'PENDING',
      index: true,
    },
    rejectionReason: { type: String, default: null },

    // LIVE-only lifecycle fields (all optional/defaulted; PAPER never sets them).
    clientOrderId: { type: String, default: null, index: true }, // sent to Delta as client_order_id
    reduceOnly: { type: Boolean, default: false },
    purpose: { type: String, default: null }, // ENTRY | CLOSE | TARGET | STOP | EMERGENCY
    deltaState: { type: String, default: null }, // last exchange-reported state: open|pending|closed|cancelled
    requestedContracts: { type: Number, default: null },
    filledContracts: { type: Number, default: 0 },
    filledQuantity: { type: Number, default: 0 }, // base-asset units actually filled on the exchange
    fillVerified: { type: Boolean, default: false }, // true only when fill data came from the exchange order object

    relatedPosition: { type: mongoose.Schema.Types.ObjectId, ref: 'Position', default: null },

    submittedAt: { type: Date, default: null },
    filledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

orderSchema.index({ environment: 1, source: 1, symbol: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);
