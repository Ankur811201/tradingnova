const mongoose = require('mongoose');

const signalSchema = new mongoose.Schema(
  {
    instanceId: {
      type: String,
      required: true,
      index: true // Indexed for quick lookups per bot instance
    },
    botModel: {
      type: String,
      required: true,
      default: 'Model001'
    },
    symbol: {
      type: String,
      required: true,
      trim: true // e.g., "BTC/USDT"
    },
    type: {
      type: String,
      enum: ['BUY', 'SELL', 'WAIT', 'HOLD'],
      required: true
    },
    status: {
      type: String,
      enum: ['EXECUTED', 'REJECTED', 'WAITING', 'EXPIRED'],
      default: 'WAITING'
    },
    price: {
      type: Number,
      required: true
    },
    reason: {
      type: String,
      required: true // e.g., "Waiting for breakout confirmation"
    },
    // Captures strategy check flags (EMA, Support/Resistance, Volume, etc.)
    factors: {
      trend: { type: String }, // e.g., "BULLISH" / "BEARISH"
      emaPass: { type: Boolean },
      supportPass: { type: Boolean },
      resistancePass: { type: Boolean },
      bodyRatioPass: { type: Boolean },
      volumePass: { type: Boolean },
      riskCheckPass: { type: Boolean }
    },
    // Reference to executed order/trade if the signal resulted in a position
    tradeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trade',
      default: null
    }
  },
  {
    timestamps: true // Automatically adds createdAt and updatedAt fields
  }
);

// Compound index for querying recent signals for a specific bot instance
signalSchema.index({ instanceId: 1, createdAt: -1 });

module.exports = mongoose.model('Signal', signalSchema);