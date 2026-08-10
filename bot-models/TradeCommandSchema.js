'use strict';

// MODIFY_STOP added additively (never removes/renames an existing action)
// to support trailing stops — a bot model that wants to ratchet an open
// position's stop-loss toward the market without closing/reopening it
// submits a MODIFY_STOP command carrying the new stopLoss value. See
// RiskEngine (ownership + open-position checks) and ExecutionRouter
// (routes to PaperEngine.updateStopLoss / LiveEngine — LIVE intentionally
// not yet implemented, see LiveEngine.js).
const VALID_ACTIONS = ['LONG', 'SHORT', 'CLOSE', 'NO_ACTION', 'MODIFY_STOP'];

/**
 * Validates a raw TradeCommand emitted by a Bot Model before it is allowed
 * anywhere near BotManager/RiskEngine. Returns { valid, errors, normalized }.
 */
function validateTradeCommand(cmd) {
  const errors = [];
  if (!cmd || typeof cmd !== 'object') {
    return { valid: false, errors: ['command must be an object'], normalized: null };
  }

  if (!cmd.commandId || typeof cmd.commandId !== 'string') errors.push('commandId is required (string)');
  if (!cmd.modelId || typeof cmd.modelId !== 'string') errors.push('modelId is required (string)');
  if (!cmd.instanceId || typeof cmd.instanceId !== 'string') errors.push('instanceId is required (string)');
  if (!cmd.symbol || typeof cmd.symbol !== 'string') errors.push('symbol is required (string)');
  if (!['PAPER', 'LIVE'].includes(cmd.environment)) errors.push('environment must be PAPER or LIVE');
  if (!VALID_ACTIONS.includes(cmd.action)) errors.push(`action must be one of ${VALID_ACTIONS.join(', ')}`);

  if (cmd.action === 'LONG' || cmd.action === 'SHORT') {
    if (cmd.quantity === undefined || cmd.quantity === null || Number.isNaN(Number(cmd.quantity)) || Number(cmd.quantity) <= 0) {
      errors.push('quantity must be a positive number for LONG/SHORT actions');
    }
  }

  if (cmd.action === 'MODIFY_STOP') {
    if (cmd.stopLoss === undefined || cmd.stopLoss === null || Number.isNaN(Number(cmd.stopLoss)) || Number(cmd.stopLoss) <= 0) {
      errors.push('stopLoss must be a positive number for MODIFY_STOP actions');
    }
  }

  if (cmd.stopLoss !== undefined && cmd.stopLoss !== null && Number.isNaN(Number(cmd.stopLoss))) {
    errors.push('stopLoss must be numeric if provided');
  }
  if (cmd.takeProfit !== undefined && cmd.takeProfit !== null && Number.isNaN(Number(cmd.takeProfit))) {
    errors.push('takeProfit must be numeric if provided');
  }

  if (errors.length) return { valid: false, errors, normalized: null };

  const normalized = {
    commandId: cmd.commandId,
    modelId: cmd.modelId,
    modelVersion: cmd.modelVersion || null,
    instanceId: cmd.instanceId,
    symbol: cmd.symbol,
    environment: cmd.environment,
    action: cmd.action,
    quantity: cmd.quantity !== undefined ? Number(cmd.quantity) : null,
    stopLoss: cmd.stopLoss !== undefined && cmd.stopLoss !== null ? Number(cmd.stopLoss) : null,
    takeProfit: cmd.takeProfit !== undefined && cmd.takeProfit !== null ? Number(cmd.takeProfit) : null,
    timestamp: cmd.timestamp || Date.now(),
    reason: cmd.reason || '',
    metadata: cmd.metadata || {},
  };

  return { valid: true, errors: [], normalized };
}

module.exports = { validateTradeCommand, VALID_ACTIONS };
