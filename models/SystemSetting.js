'use strict';

const mongoose = require('mongoose');

/**
 * Singleton document holding global runtime safety state.
 * There should only ever be one document; use SystemSetting.getSingleton().
 */
const systemSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'GLOBAL' },
    liveTradingEnabled: { type: Boolean, required: true, default: false },
    liveTradingEnabledAt: { type: Date, default: null },
    liveTradingDisabledAt: { type: Date, default: null },
    allBotsStoppedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

systemSettingSchema.statics.getSingleton = async function getSingleton(defaultLiveEnabled = false) {
  let doc = await this.findOne({ key: 'GLOBAL' });
  if (!doc) {
    doc = await this.create({ key: 'GLOBAL', liveTradingEnabled: Boolean(defaultLiveEnabled) });
  }
  return doc;
};

module.exports = mongoose.model('SystemSetting', systemSettingSchema);
