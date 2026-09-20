'use strict';

const Position = require('../models/Position');
const BotInstance = require('../models/BotInstance');
const { AppError } = require('../utils/apiResponse');
const { getActiveTimeframe } = require('../utils/activeTimeframe');

const TARGET_COUNT = 4;
const CONFIRM_CANDLES = 3;

function finitePositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function tfMs(tf) {
  const s = String(tf || '1m');
  const n = parseInt(s, 10);
  if (s.endsWith('m') && Number.isFinite(n)) return n * 60000;
  if (s.endsWith('h') && Number.isFinite(n)) return n * 3600000;
  return 60000;
}

function candleStart(timestamp, timeframe) {
  const ms = tfMs(timeframe);
  return Math.floor(Number(timestamp) / ms) * ms;
}

function validatePlan(raw, side) {
  if (!raw || raw.enabled !== true) throw new AppError('Enable Target Exit before saving targets.', 400);
  const rows = Array.isArray(raw.targets) ? raw.targets : [];
  if (rows.length !== TARGET_COUNT) throw new AppError('Exactly 4 targets are required.', 400);

  const targets = rows.map((t, i) => ({
    index: i + 1,
    price: Number(t.price),
    exitPercent: i === 3 ? null : Number(t.exitPercent),
    status: 'WAITING',
    touchedAt: null,
    executedAt: null,
    confirmation: null,
  }));

  if (targets.some(t => !finitePositive(t.price))) {
    throw new AppError('Every target price must be a positive number.', 400);
  }

  const perc = targets.slice(0, 3).map(t => t.exitPercent);
  if (perc.some(p => !Number.isFinite(p) || p <= 0 || p >= 100)) {
    throw new AppError('T1-T3 exit percentages must be between 0 and 100.', 400);
  }

  const sum = perc.reduce((a, b) => a + b, 0);
  if (!(sum < 100)) {
    throw new AppError('T1 + T2 + T3 must be less than 100%. T4 is the remaining percentage.', 400);
  }
  targets[3].exitPercent = 100 - sum;

  const ascending = side === 'LONG';
  for (let i = 1; i < targets.length; i += 1) {
    if (ascending && !(targets[i].price > targets[i - 1].price)) {
      throw new AppError('For BUY/LONG, targets must increase from T1 to T4.', 400);
    }
    if (!ascending && !(targets[i].price < targets[i - 1].price)) {
      throw new AppError('For SELL/SHORT, targets must decrease from T1 to T4.', 400);
    }
  }

  return {
    enabled: true,
    timeframe: 'same-as-bot',
    confirmCandles: CONFIRM_CANDLES,
    activationPrice: null,
    activatedAt: null,
    // Kept only for backward compatibility with older documents/UI. The new
    // implementation does NOT use a shared confirmation window.
    window: { active: false, startCandle: null, candleCount: 0, stage: null, confirmations: [] },
    events: [],
    runtime: null,
    targets,
    updatedAt: new Date(),
  };
}

/** True only for a NEW post-activation crossing between two raw ticks. */
function targetCrossed(side, price, target, previousPrice) {
  const p = Number(price);
  const t = Number(target);
  const prev = Number(previousPrice);
  if (!Number.isFinite(p) || !Number.isFinite(prev) || !finitePositive(t)) return false;
  if (side === 'LONG') return prev < t && p >= t;
  return prev > t && p <= t;
}

class TargetExitManager {
  constructor() {
    this.io = null;
    // Only a cheap previous-tick cache. Candle construction is deliberately
    // NOT done here. CandlePersistenceService is the single candle source.
    this.lastPrices = new Map();
    // Serialize target processing per symbol so overlapping websocket ticks
    // cannot observe the same previous price and double-arm a target.
    this.tickChains = new Map();
  }

  attachSocketServer(io) {
    this.io = io;
  }

  _emitTargetEvent(position, event) {
    if (!this.io || !position || !position.instanceId) return;
    this.io.to(`bot:${position.instanceId}`).emit('bot:target', {
      instanceId: position.instanceId,
      positionId: String(position._id),
      symbol: position.symbol,
      side: position.side,
      ...event,
    });
  }

  async configureForOpenPosition(instanceId, userId, raw) {
    const instance = await BotInstance.findOne({ instanceId, user: userId }).lean();
    if (!instance) throw new AppError('Bot instance not found', 404);

    const position = await Position.findOne({
      instanceId,
      environment: instance.environment,
      status: 'OPEN',
    });
    if (!position) throw new AppError('Open a position before configuring Target Exit.', 409);

    const plan = validatePlan(raw, position.side);
    const activationPrice = Number(position.currentPrice);
    if (!finitePositive(activationPrice)) {
      throw new AppError('Current position price is invalid; cannot activate Target Exit.', 409);
    }

    if (position.side === 'LONG' && !(plan.targets[0].price > activationPrice)) {
      throw new AppError('For a LONG position, T1 must be above the current price.', 400);
    }
    if (position.side === 'SHORT' && !(plan.targets[0].price < activationPrice)) {
      throw new AppError('For a SHORT position, T1 must be below the current price.', 400);
    }

    plan.positionId = String(position._id);
    plan.activationPrice = activationPrice;
    plan.activatedAt = new Date();
    position.targetExit = plan;
    await position.save();
    this.lastPrices.set(String(position._id), activationPrice);
    return position;
  }

  async getStatus(instanceId, userId) {
    const instance = await BotInstance.findOne({ instanceId, user: userId }).lean();
    if (!instance) throw new AppError('Bot instance not found', 404);
    const position = await Position.findOne({
      instanceId,
      environment: instance.environment,
      status: 'OPEN',
    }).lean();
    return {
      active: !!(position && position.targetExit && position.targetExit.enabled),
      position: position || null,
      plan: position?.targetExit || null,
    };
  }

  /**
   * Raw tick path: ONLY detects a new target crossing. It does not build or
   * close candles and does not run CT1/CT2/CT3.
   */
  onTick(symbol, price, timestamp) {
    if (!finitePositive(price)) return Promise.resolve();
    const previous = this.tickChains.get(symbol) || Promise.resolve();
    const run = previous.then(() => this._processTick(symbol, price, timestamp));
    const queued = run.catch(() => {});
    this.tickChains.set(symbol, queued);
    return run.finally(() => {
      if (this.tickChains.get(symbol) === queued) this.tickChains.delete(symbol);
    });
  }

  async _processTick(symbol, price, timestamp) {
    const positions = await Position.find({
      symbol,
      status: 'OPEN',
      'targetExit.enabled': true,
    });

    const ts = Number(timestamp || Date.now());

    for (const position of positions) {
      const id = String(position._id);
      const previousPrice = this.lastPrices.has(id)
        ? this.lastPrices.get(id)
        : Number(position.targetExit?.activationPrice);
      this.lastPrices.set(id, Number(price));

      if (!finitePositive(previousPrice)) continue;

      const side = position.side;
      const plan = position.targetExit;

      // T4 is immediate. It is independent of the CT flow.
      const t4 = plan.targets?.[3];
      if (t4 && t4.status !== 'EXECUTED' && t4.status !== 'EXECUTING' &&
          targetCrossed(side, price, t4.price, previousPrice)) {
        await this._execute(position, [3], Number(price), 'TARGET_4', { tickTimestamp: ts });
        continue;
      }

      // T1-T3 each own their confirmation state. Multiple targets may be
      // armed by the same tick and then confirm independently.
      for (let i = 0; i < 3; i += 1) {
        const target = plan.targets?.[i];
        if (!target || target.status !== 'WAITING') continue;
        if (!targetCrossed(side, price, target.price, previousPrice)) continue;

        const tf = await this._timeframe(position.instanceId);
        const touchCandle = candleStart(ts, tf);
        const claimed = await Position.findOneAndUpdate(
          {
            _id: position._id,
            status: 'OPEN',
            [`targetExit.targets.${i}.status`]: 'WAITING',
          },
          {
            $set: {
              [`targetExit.targets.${i}.status`]: 'CONFIRMING',
              [`targetExit.targets.${i}.touchedAt`]: new Date(ts),
              [`targetExit.targets.${i}.confirmation`]: {
                touchCandle,
                count: 0,
                stage: null,
              },
            },
          },
          { new: true }
        );

        if (claimed) {
          const event = {
            type: 'TARGET_TOUCHED',
            stage: null,
            targetIndex: i + 1,
            candleStart: touchCandle,
            price: Number(price),
            recordedAt: new Date(ts),
          };
          await this._appendEvent(claimed._id, event);
          this._emitTargetEvent(claimed, event);
        }
      }
    }
  }

  /**
   * Canonical candle path: receives only CLOSED candles from
   * CandlePersistenceService. This is the ONLY place CT1/CT2/CT3 advance.
   */
  async onClosedCandle(symbol, timeframe, candle) {
    if (!candle || !candle.closed) return;
    const positions = await Position.find({
      symbol,
      status: 'OPEN',
      'targetExit.enabled': true,
    });

    const start = Number(candle.timestamp);
    const duration = tfMs(timeframe);

    for (const position of positions) {
      const bot = await BotInstance.findOne({ instanceId: position.instanceId })
        .select('parameters activeTimeframe')
        .lean();
      if (!bot) continue;
      const activeTf = getActiveTimeframe(bot);
      if (activeTf !== timeframe) continue;

      // Process each target independently. No shared window.
      for (let i = 0; i < 3; i += 1) {
        const target = position.targetExit?.targets?.[i];
        if (!target || target.status !== 'CONFIRMING' || !target.confirmation) continue;

        const touch = Number(target.confirmation.touchCandle);
        const count = Math.floor((start - touch) / duration) + 1;
        if (!Number.isFinite(count) || count < 1 || count > CONFIRM_CANDLES) continue;

        // If the touch was recorded against a candle later than this closed
        // candle, this event cannot confirm it.
        if (start < touch) continue;

        const stage = `CT${count}`;
        const claimed = await Position.findOneAndUpdate(
          {
            _id: position._id,
            status: 'OPEN',
            [`targetExit.targets.${i}.status`]: 'CONFIRMING',
            [`targetExit.targets.${i}.confirmation.count`]: { $lt: count },
          },
          {
            $set: {
              [`targetExit.targets.${i}.confirmation.count`]: count,
              [`targetExit.targets.${i}.confirmation.stage`]: stage,
            },
          },
          { new: true }
        );
        if (!claimed) continue;

        const event = {
          type: 'TARGET_CONFIRMATION',
          stage,
          targetIndex: i + 1,
          candleStart: start,
          price: Number(candle.close),
          candleHigh: Number(candle.high),
          candleLow: Number(candle.low),
          recordedAt: new Date(),
        };
        await this._appendEvent(claimed._id, event);
        this._emitTargetEvent(claimed, event);

        if (count === CONFIRM_CANDLES) {
          // _execute has its own atomic claim. If another worker/tick already
          // claimed this target, it simply does nothing.
          await this._execute(claimed, [i], Number(candle.close), 'TARGET_WINDOW', { candleStart: start });
        }
      }
    }
  }

  async _appendEvent(positionId, event) {
    await Position.updateOne(
      { _id: positionId, status: 'OPEN' },
      { $push: { 'targetExit.events': event } }
    );
  }

  async _execute(position, indexes, exitPrice, reason, meta = null) {
    const fresh = await Position.findById(position._id);
    if (!fresh || fresh.status !== 'OPEN' || !fresh.targetExit?.enabled) return;

    const unique = [...new Set(indexes)].filter(i => i >= 0 && i < 4);
    if (!unique.length) return;

    // T4: immediate full remaining close.
    if (reason === 'TARGET_4' || unique.includes(3)) {
      const claimed = await Position.findOneAndUpdate(
        {
          _id: fresh._id,
          status: 'OPEN',
          'targetExit.targets': { $elemMatch: { index: 4, status: { $nin: ['EXECUTED', 'EXECUTING'] } } },
        },
        { $set: { 'targetExit.targets.$[t].status': 'EXECUTING' } },
        { new: true, arrayFilters: [{ 't.index': 4 }] }
      );
      if (!claimed) return;

      try {
        const { paperEngine, liveEngine } = this._engines();
        if (claimed.environment === 'PAPER') {
          await paperEngine.closePosition({ positionId: claimed._id, reason: 'TARGET_4', exitPriceOverride: exitPrice });
        } else {
          const product = await require('./delta/DeltaAdapter').getProductBySymbol(claimed.symbol);
          await liveEngine.closePosition({ positionId: claimed._id, productId: product.id, reason: 'TARGET_4' });
        }
      } catch (err) {
        await Position.updateOne(
          { _id: claimed._id, status: 'OPEN', 'targetExit.targets': { $elemMatch: { index: 4, status: 'EXECUTING' } } },
          { $set: { 'targetExit.targets.$[t].status': 'WAITING' } },
          { arrayFilters: [{ 't.index': 4 }] }
        );
        throw err;
      }

      const event = {
        type: 'TARGET_EXIT',
        stage: null,
        targetIndex: 4,
        candleStart: meta && Number.isFinite(Number(meta.candleStart)) ? Number(meta.candleStart) : Date.now(),
        price: Number(exitPrice),
        exitPercent: 100,
        recordedAt: new Date(),
      };
      const closedDoc = await Position.findById(claimed._id);
      if (closedDoc?.targetExit) {
        closedDoc.targetExit.events = Array.isArray(closedDoc.targetExit.events) ? closedDoc.targetExit.events : [];
        closedDoc.targetExit.events.push(event);
        await closedDoc.save();
        this._emitTargetEvent(closedDoc, event);
      }
      this.lastPrices.delete(String(fresh._id));
      return;
    }

    const { paperEngine, liveEngine } = this._engines();
    for (const i of unique) {
      const targetIndex = i + 1;
      const claimed = await Position.findOneAndUpdate(
        {
          _id: fresh._id,
          status: 'OPEN',
          'targetExit.targets': { $elemMatch: { index: targetIndex, status: 'CONFIRMING' } },
        },
        { $set: { 'targetExit.targets.$[t].status': 'EXECUTING' } },
        { new: true, arrayFilters: [{ 't.index': targetIndex }] }
      );
      if (!claimed) continue;

      try {
        const target = claimed.targetExit.targets.find(t => Number(t.index) === targetIndex);
        if (!target) continue;
        const originalQuantity = Number(claimed.originalQuantity) || Number(claimed.quantity);
        const qty = originalQuantity * (Number(target.exitPercent) / 100);
        const actualQty = Math.min(qty, Number(claimed.quantity));
        if (!(actualQty > 0)) throw new Error(`No remaining quantity for T${targetIndex}`);

        if (claimed.environment === 'PAPER') {
          await paperEngine.partialClosePosition({
            positionId: claimed._id,
            quantity: actualQty,
            exitPrice,
            reason: `TARGET_${targetIndex}`,
          });
        } else {
          const product = await require('./delta/DeltaAdapter').getProductBySymbol(claimed.symbol);
          await liveEngine.partialClosePosition({
            positionId: claimed._id,
            productId: product.id,
            quantity: actualQty,
            reason: `TARGET_${targetIndex}`,
          });
        }

        await Position.updateOne(
          { _id: claimed._id, status: 'OPEN', 'targetExit.targets': { $elemMatch: { index: targetIndex, status: 'EXECUTING' } } },
          {
            $set: {
              'targetExit.targets.$[t].status': 'EXECUTED',
              'targetExit.targets.$[t].executedAt': new Date(),
              'targetExit.targets.$[t].confirmation': null,
            },
          },
          { arrayFilters: [{ 't.index': targetIndex }] }
        );

        const event = {
          type: 'TARGET_EXIT',
          stage: null,
          targetIndex,
          candleStart: meta && Number.isFinite(Number(meta.candleStart)) ? Number(meta.candleStart) : Date.now(),
          price: Number(exitPrice),
          exitPercent: Number(target.exitPercent),
          recordedAt: new Date(),
        };
        const after = await Position.findById(claimed._id);
        if (after?.targetExit) {
          after.targetExit.events = Array.isArray(after.targetExit.events) ? after.targetExit.events : [];
          after.targetExit.events.push(event);
          await after.save();
          this._emitTargetEvent(after, event);
        }
      } catch (err) {
        await Position.updateOne(
          { _id: claimed._id, status: 'OPEN', 'targetExit.targets': { $elemMatch: { index: targetIndex, status: 'EXECUTING' } } },
          { $set: { 'targetExit.targets.$[t].status': 'CONFIRMING' } },
          { arrayFilters: [{ 't.index': targetIndex }] }
        );
        throw err;
      }
    }
  }

  _engines() {
    return {
      paperEngine: require('./paperEngine/PaperEngine'),
      liveEngine: require('./liveEngine/LiveEngine'),
    };
  }

  async _timeframe(instanceId) {
    const b = await BotInstance.findOne({ instanceId }).select('parameters activeTimeframe').lean();
    return getActiveTimeframe(b) || b?.parameters?.timeframe || '1m';
  }
}

module.exports = {
  TargetExitManager: new TargetExitManager(),
  validatePlan,
  targetCrossed,
  CONFIRM_CANDLES,
};
