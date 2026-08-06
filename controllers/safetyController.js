'use strict';

const safetyService = require('../services/safety/SafetyService');
const Position = require('../models/Position');
const { success } = require('../utils/apiResponse');
const socketBus = require('../utils/socketBus');
const portfolioService = require('../services/portfolio/PortfolioService');

async function broadcastAfterClose(userId, environment) {
  try {
    if (environment === 'PAPER' && userId) {
      const portfolio = await portfolioService.getPaperPortfolio(userId);
      socketBus.emitTo(`room:paper:${userId}`, 'paper:portfolio', portfolio);
    } else if (environment === 'LIVE') {
      const portfolio = await portfolioService.getLivePortfolio();
      socketBus.emitTo('room:live', 'live:portfolio', portfolio);
    }
  } catch (_err) {
    // best-effort broadcast only
  }
}

async function getStatus(req, res, next) {
  try {
    const status = await safetyService.getStatus();
    return success(res, status);
  } catch (err) {
    return next(err);
  }
}

async function stopOneBot(req, res, next) {
  try {
    const result = await safetyService.stopOneBot(req.params.instanceId);
    return success(res, result, 'Bot stopped');
  } catch (err) {
    return next(err);
  }
}

async function stopAllBots(req, res, next) {
  try {
    const result = await safetyService.stopAllBots();
    return success(res, result, 'All bots stopped (positions are NOT affected)');
  } catch (err) {
    return next(err);
  }
}

async function disableLiveTrading(req, res, next) {
  try {
    const result = await safetyService.disableLiveTrading();
    return success(res, result, 'Live trading disabled');
  } catch (err) {
    return next(err);
  }
}

async function enableLiveTrading(req, res, next) {
  try {
    const result = await safetyService.enableLiveTrading(req.body.confirm);
    return success(res, result, 'Live trading enabled');
  } catch (err) {
    return next(err);
  }
}

async function closeOnePosition(req, res, next) {
  try {
    const position = await Position.findById(req.params.positionId);
    const result = await safetyService.closeOnePosition(req.params.positionId, req.body.confirm);
    if (position) {
      const room = position.environment === 'PAPER' ? `room:paper:${position.user}` : 'room:live';
      socketBus.emitTo(room, 'position:update', result.position || position);
      await broadcastAfterClose(position.environment === 'PAPER' ? String(position.user) : null, position.environment);
    }
    return success(res, result, 'Position closed');
  } catch (err) {
    return next(err);
  }
}

async function closeAllPositions(req, res, next) {
  try {
    const result = await safetyService.closeAllPositions(req.body.confirm);
    // Broadcast to every paper user whose positions were touched, plus the shared live room.
    const closedPaperIds = (result.paper || []).filter((r) => r.ok).map((r) => r.positionId);
    if (closedPaperIds.length) {
      const closedPositions = await Position.find({ _id: { $in: closedPaperIds } }).select('user').lean();
      const userIds = [...new Set(closedPositions.map((p) => String(p.user)))];
      await Promise.all(userIds.map((uid) => broadcastAfterClose(uid, 'PAPER')));
    }
    if ((result.live || []).length) {
      await broadcastAfterClose(null, 'LIVE');
    }
    socketBus.emitTo('room:bots', 'bot:event', { kind: 'StatusUpdate', status: 'ALL_POSITIONS_CLOSED', detail: '', at: Date.now() });
    return success(res, result, 'All positions closed');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getStatus, stopOneBot, stopAllBots, disableLiveTrading, enableLiveTrading,
  closeOnePosition, closeAllPositions,
};
