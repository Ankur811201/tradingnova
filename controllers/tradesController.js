'use strict';

const Trade = require('../models/Trade');
const { success } = require('../utils/apiResponse');

async function listTrades(req, res, next) {
  try {
    const { environment, source, modelId, instanceId, symbol, limit = 100, page = 1 } = req.query;
    const query = { user: req.session.userId };
    if (environment) query.environment = environment;
    if (source) query.source = source;
    if (modelId) query.modelId = modelId;
    if (instanceId) query.instanceId = instanceId;
    if (symbol) query.symbol = symbol;

    const lim = Math.min(Number(limit) || 100, 500);
    const skip = (Math.max(Number(page), 1) - 1) * lim;

    const [trades, total] = await Promise.all([
      Trade.find(query).sort({ closedAt: -1 }).skip(skip).limit(lim).lean(),
      Trade.countDocuments(query),
    ]);

    return success(res, { trades, total, page: Number(page), limit: lim });
  } catch (err) {
    return next(err);
  }
}

module.exports = { listTrades };
