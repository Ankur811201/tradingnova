'use strict';

const SystemLog = require('../models/SystemLog');
const StrategyEvent = require('../models/StrategyEvent');
const RiskEvent = require('../models/RiskEvent');
const { success } = require('../utils/apiResponse');

async function listSystemLogs(req, res, next) {
  try {
    const { level, category, limit = 100 } = req.query;
    const query = {};
    if (level) query.level = level;
    if (category) query.category = category;
    const logs = await SystemLog.find(query).sort({ at: -1 }).limit(Math.min(Number(limit) || 100, 500)).lean();
    return success(res, logs);
  } catch (err) {
    return next(err);
  }
}

async function listStrategyEvents(req, res, next) {
  try {
    const { instanceId, modelId, symbol, limit = 100 } = req.query;
    const query = {};
    if (instanceId) query.instanceId = instanceId;
    if (modelId) query.modelId = modelId;
    if (symbol) query.symbol = symbol;
    const events = await StrategyEvent.find(query).sort({ at: -1 }).limit(Math.min(Number(limit) || 100, 500)).lean();
    return success(res, events);
  } catch (err) {
    return next(err);
  }
}

async function listRiskEvents(req, res, next) {
  try {
    const { instanceId, approved, limit = 100 } = req.query;
    const query = {};
    if (instanceId) query.instanceId = instanceId;
    if (approved !== undefined) query.approved = approved === 'true';
    const events = await RiskEvent.find(query).sort({ at: -1 }).limit(Math.min(Number(limit) || 100, 500)).lean();
    return success(res, events);
  } catch (err) {
    return next(err);
  }
}

module.exports = { listSystemLogs, listStrategyEvents, listRiskEvents };
