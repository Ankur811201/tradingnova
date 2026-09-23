'use strict';
const WhatsAppSetting = require('../models/WhatsAppSetting');
const client = require('../services/whatsapp/WhatsAppClient');
const { success } = require('../utils/apiResponse');

function cleanPhone(raw) { return String(raw || '').replace(/\D/g, '').replace(/^0+/, ''); }

async function status(req, res, next) { try { const setting = await WhatsAppSetting.getSingleton(); return success(res, { whatsapp: client.getStatus(), settings: setting }); } catch (e) { return next(e); } }
async function saveSettings(req, res, next) {
  try {
    const body = req.body || {};
    const recipient = cleanPhone(body.recipient);
    if (recipient && (recipient.length < 8 || recipient.length > 15)) throw new Error('Enter a valid WhatsApp number with country code.');
    const allowed = ['layerTouch','tradeOpen','target1Exit','target2Exit','target3Exit','stopLoss','tradeClosed'];
    const enabled = {}; for (const key of allowed) enabled[key] = Boolean(body.enabled?.[key]);
    const doc = await WhatsAppSetting.findOneAndUpdate({ key: 'GLOBAL' }, { $set: { recipient, enabled } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    return success(res, doc, 'WhatsApp settings saved');
  } catch (e) { return next(e); }
}
async function logout(req, res, next) { try { await client.logout(); return success(res, {}, 'WhatsApp logged out'); } catch (e) { return next(e); } }
module.exports = { status, saveSettings, logout };
