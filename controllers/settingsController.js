'use strict';

const SystemSetting = require('../models/SystemSetting');
const { env } = require('../config/env');
const { success } = require('../utils/apiResponse');

async function getSettings(req, res, next) {
  try {
    const settings = await SystemSetting.getSingleton(env.LIVE_TRADING_DEFAULT_ENABLED);
    return success(res, {
      liveTradingEnabled: settings.liveTradingEnabled,
      liveTradingEnabledAt: settings.liveTradingEnabledAt,
      liveTradingDisabledAt: settings.liveTradingDisabledAt,
      allBotsStoppedAt: settings.allBotsStoppedAt,
      // Non-sensitive trading parameters the UI needs to build trade forms.
      allowedSymbols: env.RISK_ALLOWED_SYMBOLS,
      paperMaxLeverage: env.PAPER_MAX_LEVERAGE,
      riskMaxLeverage: env.RISK_MAX_LEVERAGE,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getSettings };
