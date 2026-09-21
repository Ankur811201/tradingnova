'use strict';

const BotInstance = require('../models/BotInstance');
const { getMarketDataProvider } = require('../services/marketData');
const { env } = require('../config/env');
const { success, AppError } = require('../utils/apiResponse');
const { getActiveTimeframe } = require('../utils/activeTimeframe');

async function pushCandle(req, res, next) {
  try {
    if (!env.FAKE_CANDLE || env.IS_PRODUCTION) {
      throw new AppError('Fake candle mode is disabled.', 404, 'FAKE_CANDLE_DISABLED');
    }

    const instance = await BotInstance.findOne({
      instanceId: req.body.instanceId,
      user: req.session.userId,
    }).lean();
    if (!instance) throw new AppError('Bot instance not found.', 404);
    if (instance.status !== 'RUNNING') {
      throw new AppError('Start the PAPER bot before pushing fake candles.', 409);
    }
    if (instance.environment !== 'PAPER') {
      throw new AppError('Fake candles are PAPER-only. LIVE bot instances are blocked.', 403, 'FAKE_CANDLE_PAPER_ONLY');
    }

    const timeframe = getActiveTimeframe(instance);
    const requestedTf = req.body.timeframe || timeframe;
    if (requestedTf !== timeframe) {
      throw new AppError(`Fake candle timeframe must match this bot's active timeframe (${timeframe}).`, 400);
    }

    const provider = getMarketDataProvider();
    if (!env.FAKE_CANDLE || typeof provider.pushCandle !== 'function') {
      throw new AppError('Fake candle provider is not active.', 503, 'FAKE_PROVIDER_NOT_ACTIVE');
    }

    const result = await provider.pushCandle({
      symbol: instance.symbol,
      timeframe,
      open: req.body.open,
      high: req.body.high,
      low: req.body.low,
      close: req.body.close,
      timestamp: req.body.timestamp,
    });

    return success(res, result);
  } catch (err) {
    return next(err);
  }
}

async function reset(req, res, next) {
  try {
    if (!env.FAKE_CANDLE || env.IS_PRODUCTION) {
      throw new AppError('Fake candle mode is disabled.', 404, 'FAKE_CANDLE_DISABLED');
    }
    const provider = getMarketDataProvider();
    if (typeof provider.reset !== 'function') throw new AppError('Fake candle provider is not active.', 503);
    provider.reset();
    return success(res, { reset: true });
  } catch (err) {
    return next(err);
  }
}

module.exports = { pushCandle, reset };
