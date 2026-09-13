'use strict';

const mongoose = require('mongoose');

const tradeRecordingSchema = new mongoose.Schema(
  {
    recordingId: { type: String, required: true, unique: true, index: true },
    instanceId: { type: String, required: true, index: true },
    botName: { type: String, default: '' },
    symbol: { type: String, required: true },
    timeframe: { type: String, required: true },
    environment: { type: String, enum: ['PAPER', 'LIVE'], required: true },
    direction: { type: String, enum: ['BUY', 'SELL', 'MANUAL'], required: true },
    level: { type: mongoose.Schema.Types.Mixed, default: null },
    triggerTime: { type: Date, required: true, index: true },
    chunkIndex: { type: Number, required: true, default: 1, index: true },
    chunkStartedAt: { type: Date, default: null },
    chunkEndedAt: { type: Date, default: null },
    durationSeconds: { type: Number, required: true },
    frameRate: { type: Number, required: true, default: 1 },
    status: { type: String, enum: ['READY', 'FAILED'], required: true, default: 'READY' },
    fileName: { type: String, default: null },
    filePath: { type: String, default: null },
    triggerReason: { type: String, default: null },
  },
  { timestamps: true }
);

tradeRecordingSchema.index({ instanceId: 1, triggerTime: -1 });

module.exports = mongoose.model('TradeRecording', tradeRecordingSchema);
