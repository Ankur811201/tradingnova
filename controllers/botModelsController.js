'use strict';

const botManager = require('../services/botManager/BotManager');
const { success } = require('../utils/apiResponse');

async function listModels(req, res, next) {
  try {
    const models = await botManager.listAvailableModels();
    return success(res, models);
  } catch (err) {
    return next(err);
  }
}

async function rescanModels(req, res, next) {
  try {
    const found = await botManager.discoverModels();
    return success(res, { discovered: found }, 'Bot model discovery re-run');
  } catch (err) {
    return next(err);
  }
}

module.exports = { listModels, rescanModels };
