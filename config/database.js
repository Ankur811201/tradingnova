'use strict';

const mongoose = require('mongoose');
const { env } = require('./env');

let connectionPromise = null;
let isConnected = false;


mongoose.set('strictQuery', true);

async function connectDatabase() {
  if (connectionPromise) return connectionPromise;

  mongoose.connection.on('connected', () => {
    isConnected = true;
    console.log('[db] MongoDB connected');
  });
  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    console.warn('[db] MongoDB disconnected');
  });
  mongoose.connection.on('error', (err) => {
    console.error('[db] MongoDB connection error:', err.message);
  });

  connectionPromise = mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  return connectionPromise;
}

function getDbStatus() {
  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  const stateMap = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return {
    connected: mongoose.connection.readyState === 1,
    state: stateMap[mongoose.connection.readyState] || 'unknown',
  };
}

module.exports = { connectDatabase, getDbStatus, isConnected: () => isConnected };
