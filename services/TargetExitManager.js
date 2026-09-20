'use strict';

const Position = require('../models/Position');
const BotInstance = require('../models/BotInstance');
const { AppError } = require('../utils/apiResponse');

const TARGET_COUNT = 4;
const CONFIRM_CANDLES = 3;

function finitePositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
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
  }));
  if (targets.some(t => !finitePositive(t.price))) throw new AppError('Every target price must be a positive number.', 400);
  const perc = targets.slice(0, 3).map(t => t.exitPercent);
  if (perc.some(p => !Number.isFinite(p) || p <= 0 || p >= 100)) throw new AppError('T1-T3 exit percentages must be between 0 and 100.', 400);
  const sum = perc.reduce((a,b)=>a+b,0);
  if (Math.abs(sum - 90) > 1e-9) throw new AppError('T1 + T2 + T3 must equal exactly 90%. T4 is the remaining 10%.', 400);
  targets[3].exitPercent = 100 - sum;
  if (targets[3].exitPercent <= 0) throw new AppError('T4 remaining percentage must be positive.', 400);
  const ascending = side === 'LONG';
  for (let i=1;i<targets.length;i++) {
    if (ascending && !(targets[i].price > targets[i-1].price)) throw new AppError('For BUY/LONG, targets must increase from T1 to T4.', 400);
    if (!ascending && !(targets[i].price < targets[i-1].price)) throw new AppError('For SELL/SHORT, targets must decrease from T1 to T4.', 400);
  }
  return {
    enabled: true,
    timeframe: 'same-as-bot',
    confirmCandles: CONFIRM_CANDLES,
    window: { active: false, startCandle: null, candleCount: 0 },
    targets,
    updatedAt: new Date(),
  };
}

function targetTouched(side, candle, price) {
  if (side === 'LONG') return Number(candle.high) >= price;
  return Number(candle.low) <= price;
}

class TargetExitManager {
  async configureForOpenPosition(instanceId, userId, raw) {
    const instance = await BotInstance.findOne({ instanceId, user: userId }).lean();
    if (!instance) throw new AppError('Bot instance not found', 404);
    const position = await Position.findOne({ instanceId, environment: instance.environment, status: 'OPEN' });
    if (!position) throw new AppError('Open a position before configuring Target Exit.', 409);
    const plan = validatePlan(raw, position.side);
    plan.positionId = String(position._id);
    position.targetExit = plan;
    await position.save();
    return position;
  }

  async getStatus(instanceId, userId) {
    const instance = await BotInstance.findOne({ instanceId, user: userId }).lean();
    if (!instance) throw new AppError('Bot instance not found', 404);
    const position = await Position.findOne({ instanceId, environment: instance.environment, status: 'OPEN' }).lean();
    return { active: !!(position && position.targetExit && position.targetExit.enabled), position: position || null, plan: position?.targetExit || null };
  }

  async onTick(symbol, price, timestamp) {
    const positions = await Position.find({ symbol, status: 'OPEN', 'targetExit.enabled': true });
    for (const position of positions) {
      if (!finitePositive(price)) continue;
      const tf = await this._timeframe(position.instanceId);
      const tfMs = this._tfMs(tf);
      const bucket = Math.floor(Number(timestamp || Date.now()) / tfMs) * tfMs;
      let plan = position.targetExit;
      let runtime = plan.runtime || null;

      // A new bucket means the previous candle has CLOSED. This is the only
      // place where the global 3-candle window advances; polling frequency
      // can never be mistaken for candle count.
      if (runtime && runtime.bucket !== bucket) {
        runtime.closed = true;
        const closedCandle = { timestamp: runtime.bucket, open: runtime.open, high: runtime.high, low: runtime.low, close: runtime.close, closed: true };
        plan.runtime = null;
        await this._handleClosedCandle(position, closedCandle, tf);
        const refreshed = await Position.findById(position._id);
        if (!refreshed || refreshed.status !== 'OPEN' || !refreshed.targetExit?.enabled) continue;
        plan = refreshed.targetExit;
        runtime = null;
      }

      if (!runtime) {
        runtime = { bucket, open: price, high: price, low: price, close: price, closed: false };
      } else {
        runtime.high = Math.max(Number(runtime.high), price);
        runtime.low = Math.min(Number(runtime.low), price);
        runtime.close = price;
      }
      plan.runtime = runtime;

      // T4 is immediate. It never participates in the global 3-candle window.
      const t4 = plan.targets?.[3];
      if (t4 && t4.status !== 'EXECUTED' && targetTouched(position.side, runtime, t4.price)) {
        await Position.updateOne({_id:position._id,status:'OPEN'},{$set:{targetExit:plan}});
        await this._execute(position, [3], price, 'TARGET_4');
        continue;
      }

      const touched = [];
      for (let i=0;i<3;i++) {
        const t=plan.targets?.[i];
        if (t && t.status === 'WAITING' && targetTouched(position.side, runtime, t.price)) touched.push(i);
      }
      if (touched.length) {
        for (const i of touched) {
          plan.targets[i].status='ARMED';
          plan.targets[i].touchedAt=new Date();
        }
        if (!plan.window?.active) {
          plan.window={active:true,startCandle:bucket,candleCount:1};
        }
      }
      await Position.updateOne({_id:position._id,status:'OPEN'},{$set:{targetExit:plan}});
    }
  }

  async _handleClosedCandle(position, candle, tf) {
    const fresh = await Position.findById(position._id);
    if (!fresh || fresh.status !== 'OPEN' || !fresh.targetExit?.enabled) return;
    const plan = fresh.targetExit;
    if (!plan.window?.active) {
      await Position.updateOne({_id:fresh._id,status:'OPEN'},{$set:{'targetExit.runtime':null}});
      return;
    }
    const tfMs=this._tfMs(tf);
    const count=Math.floor((Number(candle.timestamp)-Number(plan.window.startCandle))/tfMs)+1;
    plan.window.candleCount=count;
    if (count >= CONFIRM_CANDLES) {
      const armed=plan.targets.map((t,i)=>t && t.status==='ARMED'?i:null).filter(i=>i!==null);
      if (armed.length) {
        await Position.updateOne({_id:fresh._id,status:'OPEN'},{$set:{targetExit:plan}});
        await this._execute(fresh,armed,Number(candle.close),'TARGET_WINDOW');
      } else {
        plan.window={active:false,startCandle:null,candleCount:0};
        await Position.updateOne({_id:fresh._id,status:'OPEN'},{$set:{targetExit:plan,'targetExit.runtime':null}});
      }
    } else {
      await Position.updateOne({_id:fresh._id,status:'OPEN'},{$set:{targetExit:plan,'targetExit.runtime':null}});
    }
  }

  async _execute(position, indexes, exitPrice, reason) {
    const fresh=await Position.findById(position._id);
    if (!fresh || fresh.status!=='OPEN' || !fresh.targetExit?.enabled) return;
    const unique=[...new Set(indexes)].filter(i=>i>=0&&i<4);
    const plan=fresh.targetExit;
    if (reason==='TARGET_4' || unique.includes(3)) {
      const { paperEngine, liveEngine } = this._engines();
      if (fresh.environment==='PAPER') await paperEngine.closePosition({positionId:fresh._id,reason:'TARGET_4',exitPriceOverride:exitPrice});
      else await liveEngine.closePosition({positionId:fresh._id,productId:(await require('./delta/DeltaAdapter').getProductBySymbol(fresh.symbol)).id,reason:'TARGET_4'});
      return;
    }
    const { paperEngine, liveEngine }=this._engines();
    // Execute all queued percentages against the original quantity.
    for (const i of unique) {
      const t=plan.targets[i];
      if (!t || t.status!=='ARMED') continue;
      const qty=(Number(fresh.originalQuantity)||Number(fresh.quantity)) * (Number(t.exitPercent)/100);
      if (qty<=0) continue;
      if (fresh.environment==='PAPER') await paperEngine.partialClosePosition({positionId:fresh._id,quantity:Math.min(qty,Number(fresh.quantity)),exitPrice,reason:`TARGET_${i+1}`});
      else {
        const product=await require('./delta/DeltaAdapter').getProductBySymbol(fresh.symbol);
        await liveEngine.partialClosePosition({positionId:fresh._id,productId:product.id,quantity:Math.min(qty,Number(fresh.quantity)),reason:`TARGET_${i+1}`});
      }
      await Position.updateOne({_id:fresh._id,'targetExit.targets.index':i},{$set:{'targetExit.targets.$.status':'EXECUTED','targetExit.targets.$.executedAt':new Date()}});
    }
    const after=await Position.findById(fresh._id);
    if (after && after.status==='OPEN') {
      const allDone=after.targetExit.targets.slice(0,3).every(t=>t.status==='EXECUTED');
      after.targetExit.window={active:false,startCandle:null,candleCount:0};
      await after.save();
      if (allDone && Number(after.quantity)>0) {
        // Remaining 10% belongs to T4; leave T4 armed/waiting for its touch.
      }
    }
  }

  _engines(){ return { paperEngine: require('./paperEngine/PaperEngine'), liveEngine: require('./liveEngine/LiveEngine') }; }
  async _timeframe(instanceId){ const b=await BotInstance.findOne({instanceId}).select('parameters').lean(); return b?.parameters?.timeframe || '1m'; }
  _tfMs(tf){ const n=parseInt(String(tf),10); if (String(tf).endsWith('m')&&Number.isFinite(n)) return n*60000; if(String(tf).endsWith('h')&&Number.isFinite(n)) return n*3600000; return 60000; }
  async _upsertRuntimeCandle(position,bucket,price){
    if(!position.targetExit.runtime) position.targetExit.runtime={bucket,open:price,high:price,low:price,close:price,closed:false};
    const r=position.targetExit.runtime;
    if(r.bucket!==bucket){ r.closed=true; const old={...r}; position.targetExit.runtime={bucket,open:price,high:price,low:price,close:price,closed:false}; await Position.updateOne({_id:position._id},{$set:{'targetExit.runtime':position.targetExit.runtime}}); return old; }
    r.high=Math.max(r.high,price); r.low=Math.min(r.low,price); r.close=price;
    await Position.updateOne({_id:position._id},{$set:{'targetExit.runtime':r}});
    return r;
  }
}

module.exports = { TargetExitManager: new TargetExitManager(), validatePlan, CONFIRM_CANDLES };
