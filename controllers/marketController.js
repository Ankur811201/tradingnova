'use strict';

const { getMarketDataProvider } = require('../services/marketData');
const { success, failure } = require('../utils/apiResponse');

async function getPrice(req, res, next) {
  try {
    const { symbol } = req.params;
    const provider = getMarketDataProvider();
    const priceInfo = await provider.getPrice(symbol);
    return success(res, { ...priceInfo, fresh: provider.isDataFresh(symbol) });
  } catch (err) {
    return next(err);
  }
}

async function getCandles(req, res, next) {
  try {
    const { symbol } = req.params;
    const { timeframe = '1m', limit } = req.query;
    const provider = getMarketDataProvider();
    const candles = await provider.getCandles(symbol, timeframe, { limit: limit ? Number(limit) : undefined });
    return success(res, { symbol, timeframe, candles });
  } catch (err) {
    return next(err);
  }
}

async function getStatus(req, res, next) {
  try {
    const provider = getMarketDataProvider();
    return success(res, provider.getConnectionStatus());
  } catch (err) {
    return next(err);
  }
}

async function getFreshness(req, res, next) {
  try {
    const { symbol } = req.params;
    const provider = getMarketDataProvider();
    return success(res, { symbol, fresh: provider.isDataFresh(symbol) });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getPrice, getCandles, getStatus, getFreshness };
