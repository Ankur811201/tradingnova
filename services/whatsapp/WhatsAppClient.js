'use strict';
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');

const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(process.cwd(), 'data', 'whatsapp-auth');
const state = { connection: 'starting', qr: null, user: null, lastError: null };
let baileys = null;
let sock = null;
let reconnectTimer = null;
let retries = 0;
let connecting = false;
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

class NotConnectedError extends Error { constructor() { super('WhatsApp is not connected.'); this.code = 'NOT_CONNECTED'; } }

async function loadBaileys() {
  if (baileys) return baileys;
  const mod = await import('@whiskeysockets/baileys');
  const pick = (key) => mod[key] ?? mod.default?.[key];
  baileys = {
    makeWASocket: typeof mod.default === 'function' ? mod.default : pick('makeWASocket') ?? mod.default?.default,
    useMultiFileAuthState: pick('useMultiFileAuthState'),
    fetchLatestBaileysVersion: pick('fetchLatestBaileysVersion'),
    DisconnectReason: pick('DisconnectReason'),
    Browsers: pick('Browsers'),
  };
  return baileys;
}

function wipeAuth() { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); }
function scheduleReconnect(delay = 1500) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect().catch((e) => { state.lastError = e.message; }), delay);
}

async function connect() {
  if (connecting) return;
  connecting = true;
  try {
    clearTimeout(reconnectTimer);
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const b = await loadBaileys();
    const { state: authState, saveCreds } = await b.useMultiFileAuthState(AUTH_DIR);
    let version;
    try { ({ version } = await b.fetchLatestBaileysVersion()); } catch (_) {}
    state.connection = 'connecting';
    const s = b.makeWASocket({
      ...(version ? { version } : {}),
      auth: authState,
      logger,
      browser: b.Browsers?.macOS?.('Nova Trade') ?? ['Nova Trade', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    sock = s;
    s.ev.on('creds.update', saveCreds);
    s.ev.on('connection.update', async (update) => {
      if (s !== sock) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        state.connection = 'qr';
        state.qr = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
        state.lastError = null;
      }
      if (connection === 'open') {
        retries = 0;
        state.connection = 'open';
        state.qr = null;
        state.lastError = null;
        const id = s.user?.id || '';
        state.user = { name: s.user?.name || '', phone: id.split(':')[0].split('@')[0] };
      }
      if (connection === 'close') {
        state.qr = null; state.user = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === b.DisconnectReason.loggedOut) {
          state.connection = 'logged_out';
          wipeAuth();
          scheduleReconnect(500);
        } else if (code === b.DisconnectReason.restartRequired) {
          scheduleReconnect(0);
        } else {
          state.connection = 'closed';
          scheduleReconnect(Math.min(30000, 1000 * 2 ** retries++));
        }
      }
    });
  } finally { connecting = false; }
}

async function sendText(phone, text) {
  if (!sock || state.connection !== 'open') throw new NotConnectedError();
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) throw new Error('WhatsApp recipient is not configured.');
  const plainJid = `${digits}@s.whatsapp.net`;
  let jid = plainJid;
  try {
    const [result] = (await sock.onWhatsApp(plainJid)) || [];
    if (result && result.exists === false) throw Object.assign(new Error('This number is not on WhatsApp.'), { code: 'NOT_ON_WHATSAPP' });
    if (result?.jid) jid = result.jid;
  } catch (err) {
    if (err.code === 'NOT_ON_WHATSAPP') throw err;
  }
  await sock.sendMessage(jid, { text });
}

async function logout() {
  try { if (sock) await sock.logout(); } catch (_) { wipeAuth(); state.connection = 'logged_out'; state.user = null; state.qr = null; scheduleReconnect(300); }
}

module.exports = { connect, sendText, logout, getStatus: () => ({ ...state }) };
