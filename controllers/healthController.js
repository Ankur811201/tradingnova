'use strict';

const { getDbStatus } = require('../config/database');
const { getMarketDataProvider } = require('../services/marketData');
const deltaAdapter = require('../services/delta/DeltaAdapter');
const SystemSetting = require('../models/SystemSetting');
const botManager = require('../services/botManager/BotManager');
const { env } = require('../config/env');
const { success } = require('../utils/apiResponse');

async function getHealth(req, res, next) {
  try {
    const db = getDbStatus();
    const provider = getMarketDataProvider();
    const marketStatus = provider.getConnectionStatus();
    let liveTradingEnabled = false;
    try {
      const settings = await SystemSetting.getSingleton(env.LIVE_TRADING_DEFAULT_ENABLED);
      liveTradingEnabled = settings.liveTradingEnabled;
    } catch (_e) { /* db may be down */ }

    let deltaAuth = { authenticated: false, checkedAt: null, error: null };
    if (deltaAdapter.isConfigured()) {
      try {
        deltaAuth = await deltaAdapter.checkAuthenticated();
      } catch (_e) { /* keep default (not authenticated) */ }
    }

    return success(res, {
      server: { status: 'ok', env: env.NODE_ENV, uptimeSeconds: process.uptime() },
      database: db,
      marketData: marketStatus,
      delta: {
        configured: deltaAdapter.isConfigured(),
        authenticated: deltaAuth.authenticated,
        lastCheckedAt: deltaAuth.checkedAt,
      },
      liveTradingEnabled,
      botManager: {
        registeredModels: botManager.registeredModels ? Array.from(botManager.registeredModels.keys()) : [],
        liveInstanceCount: botManager.liveInstances ? botManager.liveInstances.size : 0,
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getHealth };
