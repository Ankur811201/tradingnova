'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'GLOBAL' },
  recipient: { type: String, default: '' },
  enabled: {
    layerTouch: { type: Boolean, default: false },
    tradeOpen: { type: Boolean, default: false },
    target1Exit: { type: Boolean, default: false },
    target2Exit: { type: Boolean, default: false },
    target3Exit: { type: Boolean, default: false },
    stopLoss: { type: Boolean, default: false },
    tradeClosed: { type: Boolean, default: false },
  }
}, { timestamps: true });

schema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'GLOBAL' });
  if (!doc) doc = await this.create({ key: 'GLOBAL' });
  return doc;
};

module.exports = mongoose.model('WhatsAppSetting', schema);
