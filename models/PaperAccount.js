'use strict';

const mongoose = require('mongoose');

/**
 * PaperAccount holds the virtual balance ledger for a user.
 * Initialized ONCE with the configured starting balance; never reset on restart.
 */
const paperAccountSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    // Cash balance not currently locked in margin for open positions.
    availableBalance: { type: Number, required: true },

    // Sum of margin currently locked by open paper positions.
    lockedMargin: { type: Number, required: true, default: 0 },

    // Running total of realized P&L (net of fees) since account creation.
    totalRealizedPnl: { type: Number, required: true, default: 0 },

    // Running total of fees paid.
    totalFeesPaid: { type: Number, required: true, default: 0 },

    // History of manual fund additions (deposits). Withdrawals not modeled in Part 1.
    fundingHistory: [
      {
        amount: Number,
        reason: String,
        at: { type: Date, default: Date.now },
      },
    ],

    initializedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

paperAccountSchema.methods.equity = function equity(sumUnrealizedPnl = 0) {
  return this.availableBalance + this.lockedMargin + sumUnrealizedPnl;
};

module.exports = mongoose.model('PaperAccount', paperAccountSchema);
