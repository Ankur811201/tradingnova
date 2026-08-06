'use strict';

const mongoose = require('mongoose');

const systemLogSchema = new mongoose.Schema(
  {
    level: { type: String, enum: ['debug', 'info', 'warn', 'error'], required: true, default: 'info', index: true },
    category: {
      type: String,
      required: true,
      index: true,
      // e.g. SYSTEM, MARKET_DATA, DELTA, TRADING, BOT, RISK, SAFETY, AUTH
    },
    message: { type: String, required: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

module.exports = mongoose.model('SystemLog', systemLogSchema);
