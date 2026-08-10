'use strict';

const paperEngine = require('../paperEngine/PaperEngine');
const liveEngine = require('../liveEngine/LiveEngine');
const deltaAdapter = require('../delta/DeltaAdapter');
const Position = require('../../models/Position');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/apiResponse');

/**
 * ExecutionRouter — the only place that decides PaperEngine vs LiveEngine,
 * strictly based on command.environment. Never infers, never falls back.
 */
class ExecutionRouter {
  /**
   * Pure decision function (no I/O): given an environment string, returns
   * which engine key handles it. Never infers/falls back — unknown values throw.
   */
  decideEngine(environment) {
    if (environment === 'PAPER') return 'PAPER';
    if (environment === 'LIVE') return 'LIVE';
    throw new AppError(`Unknown environment: ${environment}`, 400);
  }

  /**
   * @param {object} command - normalized TradeCommand (post RiskEngine approval)
   * @param {object} instance - BotInstance mongoose document
   */
  async route(command, instance) {
    await logger.info('TRADING', `Routing command ${command.commandId}: ${command.action} ${command.symbol} -> ${command.environment}`, {
      instanceId: command.instanceId,
    });

    const engine = this.decideEngine(command.environment);
    if (engine === 'PAPER') return this._routePaper(command, instance);
    return this._routeLive(command, instance);
  }

  async _routePaper(command, instance) {
    if (command.action === 'LONG' || command.action === 'SHORT') {
      return paperEngine.openPosition({
        userId: instance.user,
        symbol: command.symbol,
        side: command.action,
        quantity: command.quantity,
        leverage: instance.leverage,
        stopLoss: command.stopLoss,
        takeProfit: command.takeProfit,
        source: 'BOT',
        modelId: command.modelId,
        instanceId: command.instanceId,
        commandId: command.commandId,
      });
    }
    if (command.action === 'CLOSE') {
      const position = await Position.findOne({
        instanceId: command.instanceId, symbol: command.symbol, environment: 'PAPER', status: 'OPEN',
      });
      if (!position) throw new AppError('No open paper position to close', 404);
      return paperEngine.closePosition({ positionId: position._id, reason: 'BOT_SIGNAL' });
    }
    if (command.action === 'MODIFY_STOP') {
      const position = await Position.findOne({
        instanceId: command.instanceId, symbol: command.symbol, environment: 'PAPER', status: 'OPEN',
      });
      if (!position) throw new AppError('No open paper position to modify', 404);
      return paperEngine.updateStopLoss({ positionId: position._id, stopLoss: command.stopLoss });
    }
    throw new AppError(`Unsupported action for PAPER routing: ${command.action}`, 400);
  }

  async _routeLive(command, instance) {
    const product = await deltaAdapter.getProductBySymbol(command.symbol);
    if (!product || !product.id) {
      throw new AppError(`Unable to resolve Delta product id for symbol ${command.symbol}`, 502);
    }

    if (command.action === 'LONG' || command.action === 'SHORT') {
      return liveEngine.openPosition({
        userId: instance.user,
        symbol: command.symbol,
        productId: product.id,
        side: command.action,
        quantity: command.quantity,
        leverage: instance.leverage,
        stopLoss: command.stopLoss,
        takeProfit: command.takeProfit,
        source: 'BOT',
        modelId: command.modelId,
        instanceId: command.instanceId,
        commandId: command.commandId,
      });
    }
    if (command.action === 'CLOSE') {
      const position = await Position.findOne({
        instanceId: command.instanceId, symbol: command.symbol, environment: 'LIVE', status: 'OPEN',
      });
      if (!position) throw new AppError('No open live position to close', 404);
      return liveEngine.closePosition({ positionId: position._id, productId: product.id, reason: 'BOT_SIGNAL' });
    }
    if (command.action === 'MODIFY_STOP') {
      // Deliberately NOT implemented: LIVE stop-loss is placed as an
      // exchange-side conditional order at entry (see LiveEngine.openPosition
      // -> DeltaAdapter.placeOrder's stopLossOrder). Trailing it live means
      // calling a real Delta order-amend/replace endpoint, which has not
      // been verified against official Delta documentation in this build
      // (same "never invent external message formats" rule the Part 4
      // Delta WebSocket integration already follows — see README). Failing
      // loudly here is intentional: silently no-op'ing would leave a bot
      // believing its live stop trailed when it did not.
      throw new AppError(
        'MODIFY_STOP is not yet implemented for LIVE trading: no verified Delta order-amend endpoint exists in DeltaAdapter. '
        + 'Trailing stops are currently PAPER-only.',
        501
      );
    }
    throw new AppError(`Unsupported action for LIVE routing: ${command.action}`, 400);
  }
}

module.exports = new ExecutionRouter();
