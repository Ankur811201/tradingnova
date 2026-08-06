'use strict';

const Position = require('../models/Position');
const { success } = require('../utils/apiResponse');

async function listPositions(req, res, next) {
  try {
    const { environment, source, modelId, instanceId, symbol, status, limit = 100, page = 1 } = req.query;
    const query = { user: req.session.userId };
    if (environment) query.environment = environment;
    if (source) query.source = source;
    if (modelId) query.modelId = modelId;
    if (instanceId) query.instanceId = instanceId;
    if (symbol) query.symbol = symbol;
    if (status) query.status = status;

    const lim = Math.min(Number(limit) || 100, 500);
    const skip = (Math.max(Number(page), 1) - 1) * lim;

    const [positions, total] = await Promise.all([
      Position.find(query).sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
      Position.countDocuments(query),
    ]);

    return success(res, { positions, total, page: Number(page), limit: lim });
  } catch (err) {
    return next(err);
  }
}

async function getPosition(req, res, next) {
  try {
    const position = await Position.findOne({ _id: req.params.id, user: req.session.userId }).lean();
    if (!position) return next(Object.assign(new Error('Position not found'), { status: 404 }));
    return success(res, position);
  } catch (err) {
    return next(err);
  }
}

module.exports = { listPositions, getPosition };
