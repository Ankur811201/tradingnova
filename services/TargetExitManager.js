'use strict';

const Position = require('../models/Position');
const BotInstance = require('../models/BotInstance');
const { AppError } = require('../utils/apiResponse');
const { getMarketDataProvider } = require('./marketData');
const recordingService = require('./recording/RecordingService');
const whatsappNotifications = require('./whatsapp/WhatsAppNotificationService');

const TARGET_COUNT = 4;
const CONFIRM_CANDLES = 3;
const LOT_SIZE_BTC = 0.001; // 1 BTCUSD lot = 0.001 BTC

function quantityToLots(quantity) {
  const q = Number(quantity);
  return Number.isFinite(q) && q >= 0 ? Number((q / LOT_SIZE_BTC).toFixed(8)) : null;
}

function candleTouchesTarget(side, candle, targetPrice) {
  const target = Number(targetPrice);
  const high = Number(candle && candle.high);
  const low = Number(candle && candle.low);
  if (!Number.isFinite(target) || !Number.isFinite(high) || !Number.isFinite(low)) return false;
  return side === 'LONG' ? high >= target : low <= target;
}

function finitePositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function validatePlan(raw, side, entryPrice = null) {
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
  }));

  if (targets.some(t => !finitePositive(t.price))) {
    throw new AppError('Every target price must be a positive number.', 400);
  }

  const perc = targets.slice(0, 3).map(t => t.exitPercent);
  if (perc.some(p => !Number.isFinite(p) || p <= 0 || p >= 100)) {
    throw new AppError('T1-T3 exit percentages must be between 0 and 100.', 400);
  }

  const sum = perc.reduce((a, b) => a + b, 0);
  // T1-T3 are freely allocated; T4 receives the remaining percentage.
  // The first three must leave a positive remainder for T4.
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
    events: [],
    runtime: null,
    targets,
    updatedAt: new Date(),
  };
}

// A target is considered touched only when price crosses it AFTER activation.
// This prevents a target that was already behind/in front of the current price
// when the plan was activated from firing immediately.
function targetCrossed(side, candle, price, previousPrice) {
  const target = Number(price);
  const prev = Number(previousPrice);
  if (!Number.isFinite(prev) || !finitePositive(target)) return false;
  if (side === 'LONG') return prev < target && Number(candle.high) >= target;
  return prev > target && Number(candle.low) <= target;
}

class TargetExitManager {
  constructor() {
    this.io = null;
  }

  attachSocketServer(io) {
    this.io = io;
  }

  _emitTargetEvent(position, event) {
    if (!position || !position.instanceId) return;

    const payload = {
      instanceId: position.instanceId,
      positionId: String(position._id),
      symbol: position.symbol,
      side: position.side,
      ...event,
    };

    // Mirror authoritative target events into the server-side recorder.
    // The live chart receives bot:target directly, but the recorder renders
    // its own SVG frames and therefore cannot see browser-only chart markers.
    // TARGET_EXIT must be converted into a recorder execution marker here.
    if (recordingService && typeof recordingService.updateTargetEvent === 'function') {
      try { recordingService.updateTargetEvent(position.instanceId, payload); }
      catch (err) { console.error(`[RECORDING] target event mirror failed: ${err.message}`); }
    }

    if (this.io) this.io.to(`bot:${position.instanceId}`).emit('bot:target', payload);
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

    const plan = validatePlan(raw, position.side, position.entryPrice);

    // Activation must use the ACTUAL current market price, not the position's
    // last persisted currentPrice. That field can be stale between ticks.
    let activationPrice;
    try {
      const provider = getMarketDataProvider();
      const live = await provider.getPrice(position.symbol);
      activationPrice = Number(live && live.price);
      if (!finitePositive(activationPrice)) throw new Error('provider returned an invalid price');
      if (typeof provider.isDataFresh === 'function' && !provider.isDataFresh(position.symbol)) {
        throw new Error('market price is stale');
      }
    } catch (err) {
      throw new AppError(`Current market price is unavailable; cannot activate Target Exit. ${err.message}`, 409);
    }

    // Targets must be ahead of the CURRENT market price at activation.
    // LONG: T1 < T2 < T3 < T4 and all are above current price.
    // SHORT: T1 > T2 > T3 > T4 and all are below current price.
    if (position.side === 'LONG' && !(plan.targets[0].price > activationPrice)) {
      throw new AppError('For a LONG position, T1 must be above the current price.', 400);
    }
    if (position.side === 'SHORT' && !(plan.targets[0].price < activationPrice)) {
      throw new AppError('For a SHORT position, T1 must be below the current price.', 400);
    }

    plan.positionId = String(position._id);
    plan.activationPrice = activationPrice;
    plan.activatedAt = new Date();
    plan.runtime = null;
    position.targetExit = plan;
    await position.save();
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

  async onTick(symbol, price, timestamp) {
    if (!finitePositive(price)) return;

    const positions = await Position.find({
      symbol,
      status: 'OPEN',
      'targetExit.enabled': true,
    });

    for (const position of positions) {
      const ts = Number(timestamp || Date.now());
      const plan = position.targetExit;
      const timeframe = await this._timeframe(position.instanceId);
      const tfMs = this._tfMs(timeframe);
      const previousPrice = plan.runtime && Number.isFinite(Number(plan.runtime.lastPrice))
        ? Number(plan.runtime.lastPrice)
        : Number(plan.activationPrice);

      // Keep only the last tick price. Target Exit does NOT build candles.
      plan.runtime = { lastPrice: Number(price) };

      // T4 is immediate on a NEW post-activation crossing.
      const t4 = plan.targets?.[3];
      if (
        t4 &&
        t4.status !== 'EXECUTED' &&
        t4.status !== 'EXECUTING' &&
        targetCrossed(position.side, { high: price, low: price }, t4.price, previousPrice)
      ) {
        plan.events = Array.isArray(plan.events) ? plan.events : [];
        const t4TouchEvent = {
          type: 'TARGET_TOUCHED',
          stage: null,
          targetIndex: 4,
          candleStart: Math.floor(ts / tfMs) * tfMs,
          price: Number(price),
          recordedAt: new Date(ts),
        };
        plan.events.push(t4TouchEvent);
        await Position.updateOne(
          { _id: position._id, status: 'OPEN' },
          { $set: { targetExit: plan } }
        );
        this._emitTargetEvent(position, t4TouchEvent);
        await this._execute(position, [3], Number(t4.price), 'TARGET_4');
        continue;
      }

      // T1/T2/T3: touching a target only arms that target.
      // Each target has its own confirmation candle and counter.
      let changed = false;
      for (let i = 0; i < 3; i += 1) {
        const target = plan.targets?.[i];
        if (!target || target.status !== 'WAITING') continue;

        if (targetCrossed(position.side, { high: price, low: price }, target.price, previousPrice)) {
          target.status = 'ARMED';
          target.touchedAt = new Date(ts);
          target.confirmationCandle = Math.floor(ts / tfMs) * tfMs;
          target.confirmationCount = 0;
          plan.events = Array.isArray(plan.events) ? plan.events : [];
          const touchEvent = {
            type: 'TARGET_TOUCHED',
            stage: null,
            targetIndex: i + 1,
            candleStart: target.confirmationCandle,
            price: Number(price),
            recordedAt: new Date(ts),
          };
          plan.events.push(touchEvent);
          this._emitTargetEvent(position, touchEvent);
          changed = true;
        }
      }

      if (changed) {
        await Position.updateOne(
          { _id: position._id, status: 'OPEN' },
          { $set: { targetExit: plan } }
        );
      } else {
        await Position.updateOne(
          { _id: position._id, status: 'OPEN' },
          { $set: { 'targetExit.runtime': plan.runtime } }
        );
      }
    }
  }

  /**
   * Receives the ONE canonical closed candle produced by CandlePersistenceService.
   * Target Exit never creates its own candle. Each T1/T2/T3 has an independent
   * confirmation counter: touch candle close = CT1, next close = CT2, next close = CT3.
   */
  async onClosedCandle(symbol, timeframe, candle) {
    if (!candle || candle.closed !== true) return;

    const positions = await Position.find({
      symbol,
      status: 'OPEN',
      'targetExit.enabled': true,
    });

    const tfMs = this._tfMs(timeframe);
    const candleStart = Number(candle.timestamp);
    if (!Number.isFinite(candleStart) || !tfMs) return;

    for (const position of positions) {
      const plan = position.targetExit;
      let changed = false;
      const executeIndexes = [];

      // Canonical candle wick is authoritative for T1-T3 touch detection.
      // If raw ticks did not arm a target (for example because the provider
      // emitted candle OHLC without every intrabar tick), a wick touch still
      // makes THIS candle the touch candle and therefore CT1.
      plan.events = Array.isArray(plan.events) ? plan.events : [];
      for (let i = 0; i < 3; i += 1) {
        const target = plan.targets?.[i];
        if (!target || target.status !== 'WAITING') continue;
        if (!candleTouchesTarget(position.side, candle, target.price)) continue;

        target.status = 'ARMED';
        target.touchedAt = new Date();
        target.confirmationCandle = candleStart;
        target.confirmationCount = 0;
        plan.events.push({
          type: 'TARGET_TOUCHED',
          stage: null,
          targetIndex: i + 1,
          candleStart,
          price: Number(target.price),
          recordedAt: new Date(),
        });
        this._emitTargetEvent(position, {
          type: 'TARGET_TOUCHED',
          stage: null,
          targetIndex: i + 1,
          candleStart,
          price: Number(target.price),
          recordedAt: new Date(),
        });
        changed = true;
      }

      for (let i = 0; i < 3; i += 1) {
        const target = plan.targets?.[i];
        if (!target || target.status !== 'ARMED') continue;

        const touchCandle = Number(target.confirmationCandle);
        if (!Number.isFinite(touchCandle) || candleStart < touchCandle) continue;

        const count = Math.floor((candleStart - touchCandle) / tfMs) + 1;
        const previousCount = Number(target.confirmationCount || 0);
        if (count <= previousCount) continue;

        target.confirmationCount = count;
        changed = true;

        const stage = count === 1 ? 'CT1' : count === 2 ? 'CT2' : count === 3 ? 'CT3' : null;
        if (stage) {
          const event = {
            type: 'TARGET_CONFIRMATION',
            stage,
            targetIndex: i + 1,
            candleStart,
            price: Number(candle.close),
            recordedAt: new Date(),
          };
          plan.events = Array.isArray(plan.events) ? plan.events : [];
          plan.events.push(event);
          this._emitTargetEvent(position, event);
        }

        if (count >= CONFIRM_CANDLES) {
          executeIndexes.push(i);
        }
      }

      // Save all CT state before starting exits. _execute then atomically claims
      // each ARMED target, so duplicate delivery cannot double-close it.
      if (changed) {
        await Position.updateOne(
          { _id: position._id, status: 'OPEN' },
          { $set: { targetExit: plan } }
        );
      }

      if (executeIndexes.length) {
        await this._execute(position, executeIndexes, Number(candle.close), 'TARGET_WINDOW', { candleStart });
      }
    }
  }

  async _execute(position, indexes, exitPrice, reason, meta = null) {
    const fresh = await Position.findById(position._id);
    if (!fresh || fresh.status !== 'OPEN' || !fresh.targetExit?.enabled) return;

    const unique = [...new Set(indexes)].filter(i => i >= 0 && i < 4);
    if (!unique.length) return;

    // T4 is an all-remaining close. Never combine it with T1-T3.
    if (reason === 'TARGET_4' || unique.includes(3)) {
      const realizedBefore = Number(fresh.realizedPnl || 0);
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

      const t4Quantity = Number(fresh.quantity);
      const t4Lots = quantityToLots(t4Quantity);
      try {
        const { paperEngine, liveEngine } = this._engines();
        if (fresh.environment === 'PAPER') {
          await paperEngine.closePosition({ positionId: fresh._id, reason: 'TARGET_4', exitPriceOverride: exitPrice });
        } else {
          const product = await require('./delta/DeltaAdapter').getProductBySymbol(fresh.symbol);
          await liveEngine.closePosition({ positionId: fresh._id, productId: product.id, reason: 'TARGET_4' });
        }
      } catch (err) {
        await Position.updateOne(
          { _id: fresh._id, status: 'OPEN', 'targetExit.targets': { $elemMatch: { index: 4, status: 'EXECUTING' } } },
          { $set: { 'targetExit.targets.$[t].status': 'WAITING' } },
          { arrayFilters: [{ 't.index': 4 }] }
        );
        throw err;
      }

      const closedDoc = await Position.findById(fresh._id);
      const t4Event = {
        type: 'TARGET_EXIT',
        stage: null,
        targetIndex: 4,
        candleStart: meta && Number.isFinite(Number(meta.candleStart))
          ? Number(meta.candleStart)
          : Date.now(),
        price: Number(exitPrice),
        exitPercent: 100,
        quantity: t4Quantity,
        lots: t4Lots,
        realizedPnl: Number((Number(closedDoc && closedDoc.realizedPnl || 0) - realizedBefore).toFixed(8)),
        recordedAt: new Date(),
      };
      if (closedDoc && closedDoc.targetExit) {
        closedDoc.targetExit.events = Array.isArray(closedDoc.targetExit.events) ? closedDoc.targetExit.events : [];
        closedDoc.targetExit.events.push(t4Event);
        await closedDoc.save();
        this._emitTargetEvent(closedDoc, t4Event);
      }
      return;
    }

    const { paperEngine, liveEngine } = this._engines();
    const executedTargets = [];

    for (const i of unique) {
      const targetIndex = i + 1;
      const claimed = await Position.findOneAndUpdate(
        {
          _id: fresh._id,
          status: 'OPEN',
          'targetExit.targets': { $elemMatch: { index: targetIndex, status: 'ARMED' } },
        },
        { $set: { 'targetExit.targets.$[t].status': 'EXECUTING' } },
        { new: true, arrayFilters: [{ 't.index': targetIndex }] }
      );
      if (!claimed) continue;

      try {
        const target = claimed.targetExit.targets.find(t => Number(t.index) === targetIndex);
        const realizedBefore = Number(claimed.realizedPnl || 0);
        if (!target) continue;

        const originalQuantity = Number(claimed.originalQuantity) || Number(claimed.quantity);
        const qty = originalQuantity * (Number(target.exitPercent) / 100);
        if (!(qty > 0)) throw new Error(`Invalid target quantity for T${targetIndex}`);

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
          { _id: claimed._id, 'targetExit.targets': { $elemMatch: { index: targetIndex, status: 'EXECUTING' } } },
          {
            $set: {
              'targetExit.targets.$[t].status': 'EXECUTED',
              'targetExit.targets.$[t].executedAt': new Date(),
            },
          },
          { arrayFilters: [{ 't.index': targetIndex }] }
        );

        const afterTarget = await Position.findById(claimed._id).select('realizedPnl');
        const realizedPnl = Number((Number(afterTarget && afterTarget.realizedPnl || 0) - realizedBefore).toFixed(8));

        // Record the exit so the live graph gets a TARGET_EXIT marker for
        // T1/T2/T3 too (previously only T4 emitted this — the window
        // exit was silently invisible on the chart and lost on refresh).
        executedTargets.push({ targetIndex, exitPercent: Number(target.exitPercent), quantity: actualQty, lots: quantityToLots(actualQty), realizedPnl });
      } catch (err) {
        await Position.updateOne(
          { _id: claimed._id, status: 'OPEN', 'targetExit.targets': { $elemMatch: { index: targetIndex, status: 'EXECUTING' } } },
          { $set: { 'targetExit.targets.$[t].status': 'ARMED' } },
          { arrayFilters: [{ 't.index': targetIndex }] }
        );
        throw err;
      }
    }

    const after = await Position.findById(fresh._id);
    if (after && after.status === 'OPEN') {
      const allDone = after.targetExit.targets.slice(0, 3).every(t => t.status === 'EXECUTED');
      after.targetExit.runtime = null;

      if (executedTargets.length) {
        after.targetExit.events = Array.isArray(after.targetExit.events) ? after.targetExit.events : [];
        for (const et of executedTargets) {
          after.targetExit.events.push({
            type: 'TARGET_EXIT',
            stage: null,
            targetIndex: et.targetIndex,
            candleStart: meta && Number.isFinite(Number(meta.candleStart)) ? Number(meta.candleStart) : Date.now(),
            price: Number(exitPrice),
            exitPercent: et.exitPercent,
            quantity: et.quantity,
            lots: et.lots,
            realizedPnl: et.realizedPnl,
            recordedAt: new Date(),
          });
        }
      }

      await after.save();

      if (executedTargets.length) {
        for (const et of executedTargets) {
          whatsappNotifications.notify(`TARGET_${et.targetIndex}_EXIT`, {
            instanceId: String(after.instanceId), symbol: after.symbol, side: after.side,
            quantity: et.quantity, price: Number(exitPrice), realizedPnl: et.realizedPnl,
          });
          this._emitTargetEvent(after, {
            type: 'TARGET_EXIT',
            stage: null,
            targetIndex: et.targetIndex,
            candleStart: meta && Number.isFinite(Number(meta.candleStart)) ? Number(meta.candleStart) : Date.now(),
            price: Number(exitPrice),
            exitPercent: et.exitPercent,
            quantity: et.quantity,
            lots: et.lots,
            realizedPnl: et.realizedPnl,
            recordedAt: new Date(),
          });
        }
      }

      if (allDone && Number(after.quantity) > 0) {
        // T4 remains the independent final remaining-percentage target.
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
    const b = await BotInstance.findOne({ instanceId }).select('parameters').lean();
    return b?.parameters?.timeframe || '1m';
  }

  _tfMs(tf) {
    const n = parseInt(String(tf), 10);
    if (String(tf).endsWith('m') && Number.isFinite(n)) return n * 60000;
    if (String(tf).endsWith('h') && Number.isFinite(n)) return n * 3600000;
    return 60000;
  }

}

module.exports = { TargetExitManager: new TargetExitManager(), validatePlan, targetCrossed, candleTouchesTarget, quantityToLots, CONFIRM_CANDLES, LOT_SIZE_BTC };
