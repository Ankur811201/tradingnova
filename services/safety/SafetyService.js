'use strict';

const SystemSetting = require('../../models/SystemSetting');
const Position = require('../../models/Position');
const botManager = require('../botManager/BotManager');
const paperEngine = require('../paperEngine/PaperEngine');
const liveEngine = require('../liveEngine/LiveEngine');
const deltaAdapter = require('../delta/DeltaAdapter');
const { env } = require('../../config/env');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/apiResponse');

const REQUIRED_CONFIRMATION_PHRASE = 'CONFIRM';

function assertConfirmed(confirm) {
  if (confirm !== REQUIRED_CONFIRMATION_PHRASE) {
    throw new AppError(
      `This is a dangerous action. Re-submit with { "confirm": "${REQUIRED_CONFIRMATION_PHRASE}" } to proceed.`,
      400,
      'CONFIRMATION_REQUIRED'
    );
  }
}

class SafetyService {
  async getStatus() {
    const settings = await SystemSetting.getSingleton(env.LIVE_TRADING_DEFAULT_ENABLED);
    return {
      liveTradingEnabled: settings.liveTradingEnabled,
      liveTradingEnabledAt: settings.liveTradingEnabledAt,
      liveTradingDisabledAt: settings.liveTradingDisabledAt,
      allBotsStoppedAt: settings.allBotsStoppedAt,
    };
  }

  async stopOneBot(instanceId) {
    const result = await botManager.stopInstance(instanceId);
    await logger.warn('SAFETY', `Safety action: stopped bot instance ${instanceId}`);
    return result;
  }

  /** Stops all running bots. Does NOT close positions. */
  async stopAllBots() {
    const results = await botManager.stopAllInstances();
    const settings = await SystemSetting.getSingleton(env.LIVE_TRADING_DEFAULT_ENABLED);
    settings.allBotsStoppedAt = new Date();
    await settings.save();
    await logger.warn('SAFETY', 'Safety action: STOP ALL BOTS executed', { results });
    return results;
  }

  async disableLiveTrading() {
    const settings = await SystemSetting.getSingleton(env.LIVE_TRADING_DEFAULT_ENABLED);
    settings.liveTradingEnabled = false;
    settings.liveTradingDisabledAt = new Date();
    await settings.save();
    await logger.warn('SAFETY', 'Safety action: LIVE TRADING DISABLED');
    return settings;
  }

  async enableLiveTrading(confirm) {
    assertConfirmed(confirm);
    if (!deltaAdapter.isConfigured()) {
      throw new AppError('Cannot enable live trading: Delta Exchange is not configured.', 503, 'DELTA_NOT_CONFIGURED');
    }
    const settings = await SystemSetting.getSingleton(env.LIVE_TRADING_DEFAULT_ENABLED);
    settings.liveTradingEnabled = true;
    settings.liveTradingEnabledAt = new Date();
    await settings.save();
    await logger.warn('SAFETY', 'Safety action: LIVE TRADING ENABLED');
    return settings;
  }

  async closeOnePosition(positionId, confirm) {
    assertConfirmed(confirm);
    const position = await Position.findById(positionId);
    if (!position) throw new AppError('Position not found', 404);

    if (position.environment === 'PAPER') {
      return paperEngine.closePosition({ positionId, reason: 'SAFETY_CLOSE' });
    }
    const product = await deltaAdapter.getProductBySymbol(position.symbol);
    return liveEngine.closePosition({ positionId, productId: product.id, reason: 'SAFETY_CLOSE' });
  }

  /** Dangerous: closes every open position across BOTH environments. Requires explicit confirmation. */
  async closeAllPositions(confirm) {
    assertConfirmed(confirm);
    const openPaper = await Position.find({ environment: 'PAPER', status: 'OPEN' });
    const paperResults = [];
    for (const p of openPaper) {
      try {
        await paperEngine.closePosition({ positionId: p._id, reason: 'SAFETY_CLOSE_ALL' });
        paperResults.push({ positionId: p._id, ok: true });
      } catch (err) {
        paperResults.push({ positionId: p._id, ok: false, error: err.message });
      }
    }

    let liveResults = [];
    if (deltaAdapter.isConfigured()) {
      liveResults = await liveEngine.closeAllPositions((symbol) =>
        deltaAdapter.getProductBySymbol(symbol).then((p) => p.id)
      );
    }

    await logger.warn('SAFETY', 'Safety action: CLOSE ALL POSITIONS executed', { paperResults, liveResults });
    return { paper: paperResults, live: liveResults };
  }
}

module.exports = new SafetyService();
