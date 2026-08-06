'use strict';

const Order = require('../models/Order');
const { success } = require('../utils/apiResponse');

async function listOrders(req, res, next) {
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

    const [orders, total] = await Promise.all([
      Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
      Order.countDocuments(query),
    ]);

    return success(res, { orders, total, page: Number(page), limit: lim });
  } catch (err) {
    return next(err);
  }
}

async function getOrder(req, res, next) {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.session.userId }).lean();
    if (!order) return next(Object.assign(new Error('Order not found'), { status: 404 }));
    return success(res, order);
  } catch (err) {
    return next(err);
  }
}

module.exports = { listOrders, getOrder };
