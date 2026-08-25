'use strict';

const { env } = require('../../config/env');
const BotInstance = require('../../models/BotInstance');
const Position = require('../../models/Position');
const PaperAccount = require('../../models/PaperAccount');
const RiskEvent = require('../../models/RiskEvent');
const SystemSetting = require('../../models/SystemSetting');
const { getMarketDataProvider } = require('../marketData');
const logger = require('../../utils/logger');
const DuplicateSignalDetector = require('../../utils/duplicateSignalDetector');
const { computeFee } = require('../../utils/pnl');

/**
 * RiskEngine — the single mandatory gate every BOT-generated TradeCommand must
 * pass through before execution. Contains NO strategy-specific logic.
 *
 * Returns { approved: boolean, reason: string, metadata: object }
 */
class RiskEngine {
  constructor() {
    this._duplicateDetector = new DuplicateSignalDetector(env.RISK_DUPLICATE_SIGNAL_WINDOW_MS);
  }

  async evaluate(command) {
    const meta = {};
    const reject = async (reason) => {
      const result = { approved: false, reason, metadata: meta };
      await this._logDecision(command, result);
      return result;
    };

    // 1. Duplicate command id dedup (idempotency)
    if (this._isDuplicate(command.commandId)) {
      return reject('Duplicate command id rejected (idempotency window)');
    }

    // 2. Bot instance exists & running
    const instance = await BotInstance.findOne({ instanceId: command.instanceId });
    if (!instance) return reject('Bot instance not found');
    meta.instanceStatus = instance.status;
    if (instance.status !== 'RUNNING') {
      return reject(`Bot instance is not RUNNING (status=${instance.status})`);
    }

    // 3. Environment match
    if (instance.environment !== command.environment) {
      return reject(`Command environment (${command.environment}) does not match instance environment (${instance.environment})`);
    }

    // 4. Symbol allow-list
    if (!env.RISK_ALLOWED_SYMBOLS.includes(command.symbol)) {
      return reject(`Symbol ${command.symbol} is not in the allowed symbol list`);
    }
    if (instance.symbol !== command.symbol) {
      return reject(`Command symbol (${command.symbol}) does not match instance symbol (${instance.symbol})`);
    }

    // 5. Action validity (already schema-validated upstream, but re-check NO_ACTION short-circuit)
    if (command.action === 'NO_ACTION') {
      return reject('NO_ACTION requires no execution');
    }

    // 5b. MODIFY_STOP (trailing stop) — a lighter-weight path than
    // LONG/SHORT/CLOSE: it never changes notional/margin/capital exposure,
    // it only tightens an existing, already-approved position's stop, so
    // it doesn't re-run the capital/margin/daily-loss checks below (those
    // were already satisfied when the position was opened). It still must
    // pass every identity/ownership check above (duplicate id, instance
    // running, environment match, symbol match) plus confirm a real open
    // position for this instance/symbol actually exists — never trust the
    // caller's claim that one does.
    if (command.action === 'MODIFY_STOP') {
      const existing = await Position.findOne({
        instanceId: instance.instanceId, symbol: command.symbol, status: 'OPEN',
      });
      if (!existing) {
        return reject('MODIFY_STOP requested but no open position exists for this instance/symbol');
      }
      meta.positionId = existing._id;
      this._recordCommandId(command.commandId);
      const result = { approved: true, reason: 'Approved', metadata: meta };
      await this._logDecision(command, result);
      return result;
    }

    // 6. Market data availability + freshness
    const provider = getMarketDataProvider();
    const status = provider.getConnectionStatus();
    meta.marketDataConnected = status.connected;
    if (!status.configured) {
      return reject('Market data provider is not configured; automated trades blocked');
    }
    const fresh = provider.isDataFresh(command.symbol);
    meta.marketDataFresh = fresh;
    if (!fresh) {
      return reject('Market data is stale; new automated trades are blocked');
    }

    // 7. Quantity validity
    if (command.action === 'LONG' || command.action === 'SHORT') {
      if (!command.quantity || command.quantity <= 0) {
        return reject('Invalid quantity');
      }
    }

    // 8. Leverage limit
    if (instance.leverage > env.RISK_MAX_LEVERAGE) {
      return reject(`Instance leverage (${instance.leverage}x) exceeds global max (${env.RISK_MAX_LEVERAGE}x)`);
    }

    // 9. Live trading global switch (only relevant for LIVE)
    if (command.environment === 'LIVE') {
      const settings = await SystemSetting.getSingleton(env.LIVE_TRADING_DEFAULT_ENABLED);
      meta.liveTradingEnabled = settings.liveTradingEnabled;
      if (!settings.liveTradingEnabled) {
        return reject('Live trading is globally disabled');
      }
    }

    // 10. Capital allocation / position size / balance checks (only for opening trades)
    if (command.action === 'LONG' || command.action === 'SHORT') {
      let refPrice;
      try {
        const priceInfo = await provider.getPrice(command.symbol);
        refPrice = priceInfo.price;
      } catch (err) {
        return reject(`Unable to obtain reference price: ${err.message}`);
      }
      meta.referencePrice = refPrice;

      const notional = refPrice * command.quantity;
      meta.notional = notional;

      if (notional > env.RISK_MAX_POSITION_SIZE_USD) {
        return reject(`Notional (${notional.toFixed(2)}) exceeds global max position size (${env.RISK_MAX_POSITION_SIZE_USD})`);
      }

      // Maximum-capital x leverage position-size cap removed (confirmed
      // requirement): this used to reject whenever
      // allocatedNotional + notional > instance.capitalAllocation — a
      // capital-based notional ceiling that didn't even factor in
      // leverage, making it the strictest form of the removed cap. It is
      // gone; instance.capitalAllocation is no longer read anywhere in
      // RiskEngine to reduce or reject a trade. The remaining checks
      // below (PAPER account availableBalance can cover margin+fee, daily
      // loss limit) are separate, legitimate protections and are
      // unaffected by this removal.
      const requiredMargin = notional / instance.leverage;
      meta.requiredMargin = requiredMargin;

      if (command.environment === 'PAPER') {
        const account = await PaperAccount.findOne({ user: instance.user });
        if (!account) return reject('Paper account not found for instance owner');
        // PART 14 -- PHASE B/C: PaperEngine.openPosition actually requires
        // margin + open fee (see `requiredFunds` in PaperEngine.js), not
        // margin alone. RiskEngine was previously approving commands that
        // PaperEngine then silently rejected one step later -- visible only
        // as a server log line ("Execution failed for command ..."), never
        // as a RiskEvent, and never surfaced to the UI. That is exactly the
        // "BUY decision logged, Trade=0/Position=none, no rejection reason
        // anywhere" symptom this part is fixing. Checking the same total
        // PaperEngine will actually require means an unaffordable command
        // is now rejected HERE, with a persisted, human-readable reason,
        // instead of failing invisibly downstream.
        const estimatedFee = computeFee(notional, env.PAPER_TAKER_FEE_RATE);
        const requiredFunds = requiredMargin + estimatedFee;
        meta.estimatedFee = estimatedFee;
        meta.requiredFunds = requiredFunds;
        if (account.availableBalance < requiredFunds) {
          return reject(
            `Insufficient paper balance: available=${account.availableBalance.toFixed(2)}, ` +
            `required=${requiredFunds.toFixed(2)} (margin=${requiredMargin.toFixed(2)} + est. fee=${estimatedFee.toFixed(2)})`
          );
        }
      }
      // LIVE balance sufficiency is re-validated inside LiveEngine against real
      // exchange balance/margin data at execution time (RiskEngine cannot know
      // exact exchange margin math in advance without live account state).

      // 11. Daily loss limit check
      const dailyLoss = await this._computeInstanceDailyLoss(instance.instanceId);
      meta.dailyLoss = dailyLoss;
      const dailyLossLimit = instance.riskSettings?.maxDailyLossUsd || env.RISK_MAX_DAILY_LOSS_USD;
      if (dailyLoss >= dailyLossLimit) {
        return reject(`Daily loss limit reached (${dailyLoss.toFixed(2)} >= ${dailyLossLimit})`);
      }
    }

    // 12. Duplicate order/position guard: block opening a new same-direction
    // position for this instance+symbol if one is already open (prevents
    // duplicate bot signals from creating duplicate orders).
    if (command.action === 'LONG' || command.action === 'SHORT') {
      const existing = await Position.findOne({
        instanceId: instance.instanceId,
        symbol: command.symbol,
        status: 'OPEN',
      });
      if (existing && existing.side === command.action) {
        return reject(`An open ${existing.side} position already exists for this instance/symbol`);
      }
    }

    if (command.action === 'CLOSE') {
      const existing = await Position.findOne({
        instanceId: instance.instanceId,
        symbol: command.symbol,
        status: 'OPEN',
      });
      if (!existing) {
        return reject('CLOSE requested but no open position exists for this instance/symbol');
      }
    }

    this._recordCommandId(command.commandId);
    const result = { approved: true, reason: 'Approved', metadata: meta };
    await this._logDecision(command, result);
    return result;
  }

  _isDuplicate(commandId) {
    return this._duplicateDetector.isDuplicate(commandId);
  }

  _recordCommandId(commandId) {
    this._duplicateDetector.record(commandId);
  }

  async _computeInstanceDailyLoss(instanceId) {
    const Trade = require('../../models/Trade');
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const trades = await Trade.find({ instanceId, closedAt: { $gte: startOfDay } });
    const netPnl = trades.reduce((sum, t) => sum + t.realizedPnl, 0);
    return netPnl < 0 ? Math.abs(netPnl) : 0;
  }

  async _logDecision(command, result) {
    try {
      await RiskEvent.create({
        commandId: command.commandId,
        instanceId: command.instanceId,
        modelId: command.modelId,
        symbol: command.symbol,
        environment: command.environment,
        action: command.action,
        approved: result.approved,
        reason: result.reason,
        metadata: result.metadata,
      });
      const level = result.approved ? 'info' : 'warn';
      await logger[level]('RISK', `Command ${command.commandId} (${command.action} ${command.symbol}) -> ${result.approved ? 'APPROVED' : 'REJECTED'}: ${result.reason}`);
    } catch (err) {
      console.error('[RiskEngine] failed to log decision:', err.message);
    }
  }
}

module.exports = new RiskEngine();
