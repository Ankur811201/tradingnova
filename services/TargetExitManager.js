'use strict';

const Position = require('../models/Position');
const BotInstance = require('../models/BotInstance');
const { TARGET_TIMEFRAME } = require('../utils/targetExit');
const paperEngine = require('./paperEngine/PaperEngine');
const liveEngine = require('./liveEngine/LiveEngine');
const deltaAdapter = require('./delta/DeltaAdapter');
const recordingService = require('./recording/RecordingService');
const logger = require('../utils/logger');

class TargetExitManager {
  constructor() {
    this.locks = new Map();
  }

  async _withLock(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const chain = previous.then(() => current);
    this.locks.set(key, chain);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chain) this.locks.delete(key);
    }
  }

  _touches(position, price, targetPrice) {
    return position.side === 'LONG'
      ? price >= targetPrice
      : price <= targetPrice;
  }

  async handlePriceTick(instanceId, price, timestamp) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return;
    return this._withLock(instanceId, async () => {
      const position = await Position.findOne({
        instanceId,
        status: 'OPEN',
        'targetExitPlan.enabled': true,
      });
      if (!position) return;

      const targets = position.targetExitPlan.targets || [];
      const t4 = targets.find(t => Number(t.index) === 4 && !t.executed);
      if (t4 && this._touches(position, p, Number(t4.price))) {
        await this._executeFinal(position, t4, p, timestamp);
        return;
      }

      for (const target of targets) {
        if (Number(target.index) >= 4 || target.executed || target.triggered) continue;
        if (!this._touches(position, p, Number(target.price))) continue;

        const claimed = await Position.findOneAndUpdate(
          {
            _id: position._id,
            status: 'OPEN',
            'targetExitPlan.enabled': true,
            targetExitPlan: {
              $exists: true,
            },
            [`targetExitPlan.targets.${Number(target.index) - 1}.triggered`]: false,
            [`targetExitPlan.targets.${Number(target.index) - 1}.executed`]: false,
          },
          {
            $set: {
              [`targetExitPlan.targets.${Number(target.index) - 1}.triggered`]: true,
              [`targetExitPlan.targets.${Number(target.index) - 1}.triggeredAt`]: new Date(timestamp || Date.now()),
            },
          },
          { new: true }
        );
        if (claimed) {
          const botManager = require('./botManager/BotManager');
          botManager.emitTargetExitUpdate(instanceId, claimed, {
            type: 'TOUCHED',
            target: Number(target.index),
          });
          recordingService.updateTargetPlan(instanceId, claimed.targetExitPlan);
          recordingService.updateExecution(instanceId, {
            instanceId,
            action: `TARGET_${target.index}_TOUCHED`,
            position: claimed,
          });
        }
      }
    });
  }

  async handleCandle(instanceId, candle) {
    if (!candle || candle.timeframe && candle.timeframe !== TARGET_TIMEFRAME) return;
    if (candle.closed === false) return;
    return this._withLock(instanceId, async () => {
      let position = await Position.findOne({
        instanceId,
        status: 'OPEN',
        'targetExitPlan.enabled': true,
      });
      if (!position) return;

      const activationMs = position.targetExitPlan.activatedAt
        ? new Date(position.targetExitPlan.activatedAt).getTime() : null;
      const candleStartMs = Number(candle.timestamp);
      if (Number.isFinite(activationMs) && Number.isFinite(candleStartMs) && candleStartMs < activationMs) {
        return;
      }

      const triggered = (position.targetExitPlan.targets || [])
        .filter(t => Number(t.index) < 4 && t.triggered && !t.executed)
        .sort((a, b) => Number(a.index) - Number(b.index));

      if (!triggered.length) return;

      for (const target of triggered) {
        const idx = Number(target.index) - 1;
        const claimed = await Position.findOneAndUpdate(
          {
            _id: position._id,
            status: 'OPEN',
            [`targetExitPlan.targets.${idx}.triggered`]: true,
            [`targetExitPlan.targets.${idx}.executed`]: false,
          },
          { $set: { [`targetExitPlan.targets.${idx}.executed`]: true, [`targetExitPlan.targets.${idx}.executedAt`]: new Date(candle.timestamp || Date.now()) } },
          { new: true }
        );
        if (!claimed) continue;

        try {
          const liveTarget = claimed.targetExitPlan.targets.find(t => Number(t.index) === Number(target.index));
          const result = await this._partialExit(claimed, liveTarget, Number(candle.close));
          position = await Position.findById(position._id);
          if (!position || position.status !== 'OPEN') return;

          const botManager = require('./botManager/BotManager');
          botManager.emitTargetExitUpdate(instanceId, position, {
            type: 'EXECUTED',
            target: Number(target.index),
            executionPrice: Number(candle.close),
          });
          recordingService.updateTargetPlan(instanceId, position.targetExitPlan);

          recordingService.updateExecution(instanceId, {
            instanceId,
            action: `TARGET_${target.index}_EXIT`,
            position: result && result.position ? result.position : position,
          });
        } catch (err) {
          await Position.updateOne(
            { _id: position._id, status: 'OPEN' },
            { $set: { [`targetExitPlan.targets.${idx}.executed`]: false } }
          );
          await logger.error('TRADING', `Target ${target.index} partial exit failed for ${instanceId}: ${err.message}`);
          return;
        }
      }
    });
  }

  async _partialExit(position, target, executionPrice) {
    if (position.environment === 'PAPER') {
      const result = await paperEngine.partialClosePosition({
        positionId: position._id,
        targetIndex: Number(target.index),
        quantity: Number(target.quantity),
        executionPrice,
        reason: `TARGET_${target.index}`,
      });
      return result;
    }

    const product = await deltaAdapter.getProductBySymbol(position.symbol);
    if (!product || !product.id) throw new Error(`Unable to resolve Delta product for ${position.symbol}`);
    return liveEngine.partialClosePosition({
      positionId: position._id,
      productId: product.id,
      quantity: Number(target.quantity),
      reason: `TARGET_${target.index}`,
    });
  }

  async _executeFinal(position, target, price, timestamp) {
    const idx = Number(target.index) - 1;
    const claimed = await Position.findOneAndUpdate(
      {
        _id: position._id,
        status: 'OPEN',
        [`targetExitPlan.targets.${idx}.executed`]: false,
      },
      {
        $set: {
          [`targetExitPlan.targets.${idx}.triggered`]: true,
          [`targetExitPlan.targets.${idx}.triggeredAt`]: new Date(timestamp || Date.now()),
          [`targetExitPlan.targets.${idx}.executed`]: true,
          [`targetExitPlan.targets.${idx}.executedAt`]: new Date(timestamp || Date.now()),
        },
      },
      { new: true }
    );
    if (!claimed) return;

    try {
      if (claimed.environment === 'PAPER') {
        await paperEngine.closePosition({ positionId: claimed._id, reason: 'TARGET_4', exitPriceOverride: price });
      } else {
        const product = await deltaAdapter.getProductBySymbol(claimed.symbol);
        if (!product || !product.id) throw new Error(`Unable to resolve Delta product for ${claimed.symbol}`);
        await liveEngine.closePosition({ positionId: claimed._id, productId: product.id, reason: 'TARGET_4' });
      }
      const closedPosition = await Position.findById(claimed._id).lean();
      const botManager = require('./botManager/BotManager');
      await botManager.deactivateTargetExit(instanceIdFrom(position));
      botManager.emitTargetExitUpdate(instanceIdFrom(position), closedPosition, {
        type: 'T4_EXIT',
        target: 4,
      });
      recordingService.updateExecution(instanceIdFrom(position), {
        instanceId: instanceIdFrom(position),
        action: 'TARGET_4_EXIT',
        position: closedPosition,
      });
    } catch (err) {
      await Position.updateOne(
        { _id: claimed._id, status: 'OPEN' },
        { $set: { [`targetExitPlan.targets.${idx}.executed`]: false } }
      );
      throw err;
    }
  }
}

function instanceIdFrom(position) {
  return position.instanceId;
}

module.exports = new TargetExitManager();
