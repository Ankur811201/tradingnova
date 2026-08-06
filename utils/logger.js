'use strict';

/**
 * Structured logger. Writes to console always, and persists to SystemLog
 * (MongoDB) best-effort so failures to log never crash a request.
 * Lazily requires the model to avoid circular init issues before DB connects.
 */

let SystemLog = null;
function getModel() {
  if (!SystemLog) SystemLog = require('../models/SystemLog');
  return SystemLog;
}

let ioRef = null;
function attachSocketServer(io) {
  ioRef = io;
}

async function write(level, category, message, meta = {}) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${category}] ${message}`;
  if (level === 'error') console.error(line, meta && Object.keys(meta).length ? meta : '');
  else if (level === 'warn') console.warn(line, meta && Object.keys(meta).length ? meta : '');
  else console.log(line, meta && Object.keys(meta).length ? meta : '');

  try {
    const Model = getModel();
    const doc = await Model.create({ level, category, message, meta });
    if (ioRef) {
      ioRef.to('room:logs').emit('log:new', {
        level, category, message, meta, at: doc.at,
      });
    }
  } catch (err) {
    // Never let logging failures break the app. Fall back to console only.
    console.error('[logger] failed to persist log entry:', err.message);
  }
}

module.exports = {
  attachSocketServer,
  debug: (category, message, meta) => write('debug', category, message, meta),
  info: (category, message, meta) => write('info', category, message, meta),
  warn: (category, message, meta) => write('warn', category, message, meta),
  error: (category, message, meta) => write('error', category, message, meta),
};
