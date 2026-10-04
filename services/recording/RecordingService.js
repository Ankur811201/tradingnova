'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const Candle = require('../../models/Candle');
const BotInstance = require('../../models/BotInstance');
const { getActiveTimeframe } = require('../../utils/activeTimeframe');
const SvgChartRenderer = require('./SvgChartRenderer');

const RECORDINGS_DIR = path.join(__dirname, '..', '..', 'storage', 'recordings');
const FRAME_INTERVAL_MS = 2000;
const FPS = 1 / (FRAME_INTERVAL_MS / 1000);
const POST_EVENT_TAIL_MS = 5000;
const MAX_RECORDING_MS = 24 * 60 * 60 * 1000;
const MAX_CANDLES = 300;
const MAX_LEVEL_TOUCH_INDEX = 3; // S1/R1, S2/R2, S3/R3 can start recordings.
const ENTRY_CANDLE_CLOSE_LIMIT = 3;
const FFMPEG_TIMEOUT_MS = 90 * 1000;

function resolveFfmpeg() {
  // Prefer an explicitly configured binary. This is useful on Windows where
  // ffmpeg may be installed but not present on the Node process PATH.
  const configured = process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.trim();
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    throw new Error(`FFMPEG_PATH does not exist: ${configured}`);
  }

  // Use the bundled ffmpeg-static binary when installed. This keeps the
  // recording feature independent of the user's system PATH.
  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (_) {}

  // Finally fall back to a system ffmpeg available on PATH.
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}


function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatPrice(value) {
  const n = num(value);
  return n == null ? '--' : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function positivePriceArray(values) {
  return (Array.isArray(values) ? values : [])
    .map(value => num(value))
    .filter(value => value != null && value > 0);
}

function validRecordingCandle(candle) {
  if (!candle || typeof candle !== 'object') return false;
  const timestamp = num(candle.timestamp != null ? candle.timestamp : candle.time);
  const open = num(candle.open);
  const high = num(candle.high);
  const low = num(candle.low);
  const close = num(candle.close);
  return timestamp != null && timestamp > 0 && open != null && open > 0 &&
    high != null && high > 0 && low != null && low > 0 && close != null && close > 0 &&
    high >= Math.max(open, close) && low <= Math.min(open, close);
}

class RecordingService {
  constructor() {
    this.active = new Map();
    this.lastPrices = new Map();
    this.io = null;
    // Per-level recording lifecycle. State survives individual recording sessions
    // for the lifetime of this Node process, so a level can have at most two
    // loss-driven recording cycles before it is blocked until another level is touched.
    this.levelStates = new Map();
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }

  attachSocketServer(io) {
    this.io = io;
  }

  getActive(instanceId) {
    const session = this.active.get(instanceId);
    if (!session) return null;
    return {
      recordingId: session.id,
      instanceId: session.instanceId,
      status: 'RECORDING',
      startedAt: session.startedAt,
      frameRate: FPS,
      level: session.level,
      videoId: session.videoId,
      tradeNumber: session.tradeNumber,
      entryCandleCloseCount: session.entryCandleCloseCount,
    };
  }

  /**
   * Observe the existing live price stream. Recording only: this never changes
   * MODEL_002 strategy state.
   *
   * Every configured S/R level can start one recording cycle. A level is not
   * allowed to start again merely because it is touched again; the only second
   * recording for that level is created after Trade 1 closes with a loss.
   */
  observePriceForLevelTouch(bot, price, timestamp) {
    if (!bot || bot.modelId !== 'MODEL_002' || bot.status !== 'RUNNING') return;
    const p = num(price);
    if (p == null || this.active.has(bot.instanceId)) return;

    const previous = this.lastPrices.get(bot.instanceId);
    this.lastPrices.set(bot.instanceId, p);
    if (previous == null) return;

    const touches = [];
    const support = Array.isArray(bot.parameters?.support) ? bot.parameters.support : [];
    const resistance = Array.isArray(bot.parameters?.resistance) ? bot.parameters.resistance : [];

    support.forEach((raw, i) => {
      const level = num(raw);
      if (i < MAX_LEVEL_TOUCH_INDEX && level != null && previous > level && p <= level) {
        touches.push({ side: 'SUPPORT', index: i + 1, price: level, at: timestamp });
      }
    });
    resistance.forEach((raw, i) => {
      const level = num(raw);
      if (i < MAX_LEVEL_TOUCH_INDEX && level != null && previous < level && p >= level) {
        touches.push({ side: 'RESISTANCE', index: i + 1, price: level, at: timestamp });
      }
    });

    if (!touches.length) return;

    // If one tick crosses more than one configured level, use the level that
    // was crossed last in the supplied configuration order. The trading engine
    // itself remains untouched; this is only recording metadata.
    const touch = touches[touches.length - 1];
    this.startFromLevelTouch({ instanceId: bot.instanceId, touch, bot })
      .catch((err) => console.error(`[RECORDING] live level-touch start failed for ${bot.instanceId}: ${err.message}`));
  }

  async startFromLevelTouch({ instanceId, touch, bot: suppliedBot = null, manual = false, allowRepeat = false, triggerReason = null, startedAt = null }) {
    if (!instanceId || !touch) return null;
    const index = Number(touch.index);
    const side = String(touch.side || '').toUpperCase();
    if (!manual && (index < 1 || index > MAX_LEVEL_TOUCH_INDEX || !['SUPPORT', 'RESISTANCE'].includes(side))) return null;
    if (manual && side !== 'MANUAL') return null;
    if (this.active.has(instanceId)) return this.active.get(instanceId).id;

    const levelKey = manual ? null : `${side === 'SUPPORT' ? 'S' : 'R'}${index}`;
    let levelState = null;
    if (!manual) {
      let byLevel = this.levelStates.get(instanceId);
      if (!byLevel) {
        byLevel = new Map();
        this.levelStates.set(instanceId, byLevel);
      }
      levelState = byLevel.get(levelKey) || null;

      // A physical touch starts a level only once. The only permitted repeat
      // is the loss-driven Trade 2 recording for that exact same level.
      if (!allowRepeat && levelState) return null;
      if (allowRepeat && (!levelState || levelState.blocked || levelState.losses !== 1 || levelState.tradesStarted !== 1)) {
        return null;
      }
      if (!levelState) {
        levelState = {
          levelKey,
          losses: 0,
          tradesStarted: 0,
          blocked: false,
          profitable: false,
          lastTradeId: null,
        };
        byLevel.set(levelKey, levelState);
      }
    }

    const bot = suppliedBot || await BotInstance.findOne({ instanceId }).lean();
    if (!bot || bot.modelId !== 'MODEL_002') return null;

    const timeframe = getActiveTimeframe(bot) || bot.parameters?.timeframe;
    const id = `${instanceId}-${Date.now()}`;
    const dir = path.join(RECORDINGS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });

    const session = {
      id,
      instanceId,
      botName: bot.name,
      symbol: bot.symbol,
      timeframe,
      environment: bot.environment,
      createdAtMs: bot.createdAt instanceof Date && !Number.isNaN(bot.createdAt.getTime()) ? bot.createdAt.getTime() : null,
      trend: bot.parameters?.trend || '',
      direction: manual ? 'MANUAL' : (side === 'SUPPORT' ? 'BUY' : 'SELL'),
      support: bot.parameters?.support || [],
      resistance: bot.parameters?.resistance || [],
      level: manual ? null : { side, index, price: num(touch.price) },
      boundaries: { upper: null, lower: null },
      decision: {
        decision: 'TOUCHED',
        reason: triggerReason || (manual ? 'Manual recording started' : `${side === 'SUPPORT' ? 'S' : 'R'}${index} touched`),
        activeLevel: manual ? null : { side, index, price: num(touch.price) },
        triggerTime: Date.now(),
      },
      startedAt: Number.isFinite(Number(startedAt)) ? Number(startedAt) : (Number.isFinite(Number(touch.at)) ? Number(touch.at) : Date.now()),
      frameIndex: 0,
      chunkIndex: 1,
      chunkStartedAt: Number.isFinite(Number(startedAt)) ? Number(startedAt) : (Number.isFinite(Number(touch.at)) ? Number(touch.at) : Date.now()),
      videoId: crypto.randomUUID(),
      mode: manual ? 'MANUAL' : (allowRepeat ? 'TRADE_2_LOSS_RETRY' : 'LEVEL_TOUCH'),
      levelKey,
      tradeNumber: manual ? 0 : ((levelState && levelState.losses || 0) + 1),
      tradeId: null,
      entryOpenedAt: null,
      entryCandleCloseCount: 0,
      triggerReason: triggerReason || null,
      framesDir: dir,
      candles: new Map(),
      currentCandle: null,
      currentPrice: null,
      stopTimer: null,
      maxTimer: null,
      timer: null,
      rotating: false,
      stopping: false,
      renderer: null,
      capturePromise: Promise.resolve(),
      executionMarkers: [],
      position: null,
    };

    // Register the session BEFORE the first database read. The trading
    // pipeline can finish independently of recording; this prevents a fast
    // risk/execution response from racing ahead of recording startup.
    this.active.set(instanceId, session);

    // Load the same 300-candle historical baseline used by the live chart
    // BEFORE the first recording frame is captured. The old implementation
    // started the renderer before this async query completed, which could
    // produce a valid video containing only the current candle and a wildly
    // expanded price scale. A short timeout keeps level-touch startup from
    // being held indefinitely if MongoDB is slow; subsequent live updates
    // continue to fill the renderer with canonical candles.
    try {
      // IMPORTANT: use the exact same historical-candle boundary as the
      // live bot-detail chart. The live chart reads candles for this bot
      // instance from `createdAt` onward; the recorder must not accidentally
      // pull older/global candles (including stale malformed rows) because
      // that can change Lightweight Charts' autoscale and make the recorded
      // graph look nothing like the live graph.
      const candleFilter = { symbol: bot.symbol, timeframe };
      if (bot.createdAt instanceof Date && !Number.isNaN(bot.createdAt.getTime())) {
        candleFilter.timestamp = { $gte: bot.createdAt.getTime() };
      }

      const historyPromise = Candle.find(candleFilter)
        .sort({ timestamp: -1 })
        .limit(MAX_CANDLES)
        .lean();
      const history = await Promise.race([
        historyPromise,
        new Promise(resolve => setTimeout(() => resolve(null), 5000)),
      ]);
      const current = this.active.get(instanceId);
      if (current && current.id === id && !current.stopping && Array.isArray(history)) {
        history.reverse().forEach(c => {
          if (validRecordingCandle(c)) current.candles.set(String(c.timestamp), c);
        });
      } else if (history === null) {
        console.warn(`[RECORDING] chart history timeout ${id}; continuing with live candles`);
      }
    } catch (err) {
      console.warn(`[RECORDING] history load failed for ${id}: ${err.message}`);
    }

    // Capture the authoritative OPEN position at recording start so ENTRY/SL/TP
    // and active target overlays match the live graph from the first frame.
    try {
      const Position = require('../../models/Position');
      const openPosition = await Position.findOne({ instanceId, environment: bot.environment, status: 'OPEN' }).lean();
      if (openPosition) session.position = openPosition;
    } catch (err) {
      console.warn(`[RECORDING] initial position load failed ${id}: ${err.message}`);
    }

    // Server-side SVG->PNG chart renderer. No browser process is launched:
    // the same canonical candle/decision state that used to be pushed into a
    // headless Chrome tab is instead rendered directly to an SVG document
    // and rasterized with sharp. See SvgChartRenderer.js for the frame
    // builder (renderChartFrame) and visual-parity notes.
    session.renderer = new SvgChartRenderer();
    try {
      await session.renderer.start(session);
    } catch (err) {
      this.active.delete(instanceId);
      try { if (session.renderer) await session.renderer.stop(); } catch (_) {}
      try { fs.rmSync(session.framesDir, { recursive: true, force: true }); } catch (_) {}
      throw new Error(`Chart renderer failed to start: ${err.message}`);
    }

    console.log(`[RECORDING] starting ${id} instance=${instanceId} symbol=${bot.symbol} timeframe=${timeframe}`);
    await this.captureFrame(session);
    session.timer = setInterval(() => {
      session.capturePromise = session.capturePromise
        .then(() => this.captureFrame(session))
        .catch(err => console.error(`[RECORDING] frame failed for ${session.id}: ${err.stack || err.message}`));
    }, FRAME_INTERVAL_MS);
    session.maxTimer = setTimeout(() => {
      this.stop(instanceId, 'MAX_DURATION').catch(err => console.error(`[RECORDING] max-stop failed: ${err.message}`));
    }, MAX_RECORDING_MS);

    return id;
  }

  async startManual(instanceId) {
    if (!instanceId) return null;
    if (this.active.has(instanceId)) return this.active.get(instanceId).id;

    const bot = await BotInstance.findOne({ instanceId }).lean();
    if (!bot || bot.modelId !== 'MODEL_002') {
      throw new Error('Manual recording is currently supported for MODEL_002 bots only');
    }
    if (String(bot.status || '').toUpperCase() !== 'RUNNING') {
      throw new Error('Start the bot before starting a recording');
    }

    const now = Date.now();
    return this.startFromLevelTouch({
      instanceId,
      bot,
      manual: true,
      touch: { side: 'MANUAL', index: 0, price: null, at: now },
    });
  }


  updatePrice(instanceId, symbol, price, timestamp) {
    const session = this.active.get(instanceId);
    if (!session) return;

    // The market-data loop can service multiple subscribed symbols. Never
    // feed a tick into a recording for a different instrument; doing so can
    // combine (for example) a low-priced symbol with BTCUSD OHLC and create
    // a visually catastrophic giant candle.
    if (String(session.symbol || '').toUpperCase() !== String(symbol || '').toUpperCase()) return;

    const p = num(price);
    if (p == null) return;
    session.currentPrice = p;
    const ts = num(timestamp, Date.now());
    const bucketMs = this._timeframeMs(session.timeframe);
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    if (!session.currentCandle || Number(session.currentCandle.timestamp) !== bucket || !validRecordingCandle(session.currentCandle)) {
      session.currentCandle = { timestamp: bucket, open: p, high: p, low: p, close: p };
    } else {
      session.currentCandle.high = Math.max(session.currentCandle.high, p);
      session.currentCandle.low = Math.min(session.currentCandle.low, p);
      session.currentCandle.close = p;
    }
  }

  ingestCandleEvents(events = []) {
    for (const evt of events) {
      if (!evt || !evt.candle) continue;
      for (const session of this.active.values()) {
        if (session.symbol !== evt.symbol || session.timeframe !== evt.timeframe) continue;
        const c = {
          timestamp: num(evt.candle.timestamp),
          open: num(evt.candle.open),
          high: num(evt.candle.high),
          low: num(evt.candle.low),
          close: num(evt.candle.close),
          volume: num(evt.candle.volume),
          closed: Boolean(evt.candle.closed),
        };
        if (validRecordingCandle(c)) {
          session.candles.set(String(c.timestamp), c);
          session.currentCandle = c.closed ? null : c;

          // Count completed candles only after a real bot trade has opened.
          // The candle containing the entry counts when it closes; therefore
          // compare candle end-time with the authoritative openedAt.
          if (c.closed && session.entryOpenedAt && !session.stopping) {
            const candleEnd = Number(c.timestamp) + this._timeframeMs(session.timeframe);
            if (candleEnd > Number(session.entryOpenedAt)) {
              session.entryCandleCloseCount = Number(session.entryCandleCloseCount || 0) + 1;
              if (session.entryCandleCloseCount >= ENTRY_CANDLE_CLOSE_LIMIT) {
                this.stop(session.instanceId, 'THREE_CANDLES_AFTER_ENTRY')
                  .catch(err => console.error(`[RECORDING] 3-candle stop failed: ${err.message}`));
              }
            }
          }
        }
      }
    }
  }

  updateDecision(instanceId, decision) {
    const session = this.active.get(instanceId);
    if (!session || !decision) return;
    session.decision = { ...session.decision, ...decision };
    if (decision.candle3 && validRecordingCandle(decision.candle3)) {
      session.currentCandle = { ...decision.candle3 };
    }
  }

  updateTargetEvent(instanceId, event) {
    const session = this.active.get(instanceId);
    if (!session || !event || String(event.type || '').toUpperCase() !== 'TARGET_EXIT') return;
    // Partial target exits change live position quantity and target status even
    // though the position remains OPEN. Refresh the authoritative position so
    // the next SVG frame mirrors those live-chart changes.
    try {
      const Position = require('../../models/Position');
      Position.findById(event.positionId).lean().then((p) => {
        const current = this.active.get(instanceId);
        if (current && current.id === session.id) current.position = p || null;
      }).catch(() => {});
    } catch (_) {}

    const price = num(event.price);
    if (price == null || price <= 0) return;

    const recordedAt = event.recordedAt ? new Date(event.recordedAt).getTime() : Date.now();
    const candleStart = num(event.candleStart, recordedAt);
    const markerMs = Number.isFinite(candleStart) ? candleStart : recordedAt;
    const bucket = Math.floor(markerMs / this._timeframeMs(session.timeframe)) * this._timeframeMs(session.timeframe);
    const targetIndex = Number(event.targetIndex);
    const lots = num(event.lots);
    const side = event.side === 'LONG' ? 'LONG' : event.side === 'SHORT' ? 'SHORT' : null;
    const lotText = lots != null ? `${Math.ceil(lots * 100) / 100} LOT` : '';

    const marker = {
      id: `target-exit:${String(event.positionId || instanceId)}:${targetIndex}:${String(event.recordedAt || recordedAt)}`,
      type: 'EXIT',
      side,
      price,
      execTime: Math.floor(recordedAt / 1000),
      time: Math.floor(bucket / 1000),
      text: `T${Number.isFinite(targetIndex) ? targetIndex : '?'} EXIT${lotText ? ` · ${lotText}` : ''}`,
    };

    if (!session.executionMarkers.some(existing => existing.id === marker.id)) {
      session.executionMarkers.push(marker);
      if (session.executionMarkers.length > 20) session.executionMarkers = session.executionMarkers.slice(-20);
    }
  }

  updateExecution(instanceId, execution) {
    if (!execution) return;
    const session = this.active.get(instanceId);
    const position = execution.position || null;
    const trade = execution.trade || null;

    // OPEN: attach the authoritative trade/position to the active level
    // recording and start the 3-completed-candle counter.
    if (position && String(execution.action || '').toUpperCase() !== 'CLOSE') {
      if (session && session.id) {
        session.position = position;
        const levelKey = position.entryLevelKey || session.levelKey || null;
        if (!session.tradeId || session.tradeId !== String(position._id || '')) {
          session.tradeId = String(position._id || `${position.openedAt || Date.now()}`);
          session.entryOpenedAt = position.openedAt instanceof Date
            ? position.openedAt.getTime()
            : new Date(position.openedAt || Date.now()).getTime();
          session.entryCandleCloseCount = 0;

          if (levelKey && this.levelStates.get(instanceId)?.get(levelKey)) {
            const state = this.levelStates.get(instanceId).get(levelKey);
            state.tradesStarted = Math.max(Number(state.tradesStarted || 0), 1);
            state.lastTradeId = session.tradeId;
          }
          this._emit(instanceId, 'TRADE_OPEN', session, {
            tradeNumber: session.tradeNumber,
            entryOpenedAt: session.entryOpenedAt,
          });
        }
      }
    }

    // Keep the authoritative execution markers in the current recording.
    if (session) {
      session.position = position || session.position || null;
      const timeframeMs = this._timeframeMs(session.timeframe);
      const toMarker = (type, item) => {
        if (!item) return null;
        const price = num(type === 'EXIT' ? item.exitPrice : item.entryPrice);
        const rawTime = item.closedAt || item.openedAt;
        const ms = rawTime instanceof Date ? rawTime.getTime() : new Date(rawTime).getTime();
        if (price == null || price <= 0 || !Number.isFinite(ms)) return null;
        const sec = Math.floor(ms / 1000);
        const bucket = Math.floor(ms / timeframeMs) * timeframeMs;
        const side = item.side === 'LONG' ? 'BUY' : item.side === 'SHORT' ? 'SELL' : null;
        return {
          id: `${type.toLowerCase()}:${String(item._id || `${sec}:${price}`)}`,
          type, side, price, execTime: sec, time: Math.floor(bucket / 1000),
          text: type === 'EXIT' ? 'EXIT' : (side || 'ACTION'),
        };
      };
      const markers = [];
      if (position) {
        const m = toMarker('ENTRY', position);
        if (m) markers.push(m);
      }
      if (trade) {
        const entry = toMarker('ENTRY', trade);
        const exit = toMarker('EXIT', trade);
        if (entry) markers.push(entry);
        if (exit) markers.push(exit);
      }
      for (const marker of markers) {
        if (!session.executionMarkers.some(existing => existing.id === marker.id)) {
          session.executionMarkers.push(marker);
        }
      }
      if (session.executionMarkers.length > 20) {
        session.executionMarkers = session.executionMarkers.slice(-20);
      }
    }

    // CLOSE: level-specific lifecycle. A negative realized PnL gets exactly
    // one retry recording for that same level. The second loss blocks that
    // level. A profitable/target close blocks the retry path because the bot
    // pauses and the user explicitly does not want Trade 2 recording.
    if (!trade || String(execution.action || '').toUpperCase() !== 'CLOSE') return;

    const levelKey = trade.entryLevelKey || session?.levelKey || null;
    if (!levelKey) {
      if (session) {
        this.stopSoon(instanceId, Number(trade.realizedPnl) < 0 ? 'LOSS_EXIT' : 'PROFIT_EXIT');
      }
      return;
    }

    let byLevel = this.levelStates.get(instanceId);
    if (!byLevel) {
      byLevel = new Map();
      this.levelStates.set(instanceId, byLevel);
    }
    let state = byLevel.get(levelKey);
    if (!state) {
      state = {
        levelKey,
        losses: 0,
        tradesStarted: 0,
        blocked: false,
        profitable: false,
        lastTradeId: null,
      };
      byLevel.set(levelKey, state);
    }

    const pnl = num(trade.realizedPnl, 0);
    state.lastTradeId = String(trade._id || state.lastTradeId || '');
    if (Number(state.tradesStarted || 0) < 1) state.tradesStarted = 1;
    if (pnl < 0) {
      state.losses = Number(state.losses || 0) + 1;

      if (state.losses >= 2) {
        state.blocked = true;
        if (session) this.stopSoon(instanceId, 'SECOND_LOSS_LEVEL');
        this._emit(instanceId, 'LEVEL_RECORDING_BLOCKED', session || {
          id: null, instanceId, startedAt: Date.now(), level: null,
        }, { levelKey, losses: state.losses });
        return;
      }

      // First loss: finish the current video (if it is still active), then
      // immediately create the one allowed Trade 2 recording for the same level.
      const botPromise = BotInstance.findOne({ instanceId }).lean();
      const restart = async () => {
        const bot = await botPromise;
        if (!bot || bot.status !== 'RUNNING') return;
        const touch = session?.level
          ? { side: session.level.side, index: session.level.index, price: session.level.price, at: Date.now() }
          : this._levelObjectToTouch(levelKey, bot);
        if (!touch) return;

        if (session && !session.stopping) {
          await this.stop(instanceId, 'LOSS_EXIT');
        }
        await this.startFromLevelTouch({
          instanceId,
          touch,
          bot,
          allowRepeat: true,
          triggerReason: `Trade 1 LOSS — ${levelKey} recording for Trade 2`,
          startedAt: Date.now(),
        });
      };
      restart().catch(err => console.error(`[RECORDING] loss-retry start failed for ${instanceId}: ${err.message}`));
    } else {
      state.profitable = true;
      state.blocked = true;
      if (session) this.stopSoon(instanceId, 'PROFIT_EXIT');
    }
  }

  _levelObjectToTouch(levelKey, bot) {
    const m = String(levelKey || '').match(/^([SR])([123])$/);
    if (!m) return null;
    const index = Number(m[2]);
    const side = m[1] === 'S' ? 'SUPPORT' : 'RESISTANCE';
    const arr = side === 'SUPPORT' ? bot.parameters?.support : bot.parameters?.resistance;
    const price = Array.isArray(arr) ? num(arr[index - 1]) : null;
    if (price == null) return null;
    return { side, index, price, at: Date.now() };
  }

  stopSoon(instanceId, reason) {
    const session = this.active.get(instanceId);
    if (!session || session.stopping) return;
    if (session.stopTimer) clearTimeout(session.stopTimer);
    session.stopReason = reason;
    session.stopTimer = setTimeout(() => {
      this.stop(instanceId, reason).catch(err => console.error(`[RECORDING] stop failed: ${err.message}`));
    }, POST_EVENT_TAIL_MS);
  }

  async stop(instanceId, reason = 'EVENT') {
    const session = this.active.get(instanceId);
    if (!session || session.stopping) return;
    session.stopping = true;
    clearInterval(session.timer);
    clearTimeout(session.stopTimer);
    clearTimeout(session.maxTimer);

    try {
      await session.capturePromise;
      await this.captureFrame(session, true);
      await this._finalizeRecording(session, reason);
      this._emit(instanceId, 'STOPPED', session, { reason, videoId: session.videoId });
    } catch (err) {
      console.error(`[RECORDING] ${session.id} failed: ${err.stack || err.message}`);
      this._emit(instanceId, 'FAILED', session, { reason, error: err.message, videoId: session.videoId });
      try { fs.rmSync(session.framesDir, { recursive: true, force: true }); } catch (_) {}
    } finally {
      this.active.delete(instanceId);
      if (session.renderer) {
        try { await session.renderer.stop(); } catch (_) {}
        session.renderer = null;
      }
    }
  }

  async captureFrame(session, finalFrame = false) {
    if (!session || (!finalFrame && session.stopping) || !session.renderer) return;
    try {
      await session.renderer.update(session);
    } catch (err) {
      throw new Error(`[RECORDING] frame generation failed ${session.id}: ${err.message}`);
    }
    const file = path.join(session.framesDir, `frame-${String(session.frameIndex).padStart(6, '0')}.png`);
    session.frameIndex += 1;
    try {
      await session.renderer.screenshot(file);
    } catch (err) {
      throw new Error(`[RECORDING] frame rasterization failed ${session.id}: ${err.message}`);
    }
  }

  async _finalizeRecording(session, reason) {
    const frameCount = session.frameIndex;
    if (!frameCount) {
      try { fs.rmSync(session.framesDir, { recursive: true, force: true }); } catch (_) {}
      return;
    }

    const Recording = require('../../models/TradeRecording');
    const webm = path.join(RECORDINGS_DIR, `${session.id}.webm`);
    const inputPattern = path.join(session.framesDir, 'frame-%06d.png');

    if (!fs.existsSync(session.framesDir)) {
      throw new Error(`Recording frames directory missing: ${session.framesDir}`);
    }

    console.log(`[RECORDING] encoding ${session.id} frames=${frameCount}`);
    const ffmpeg = resolveFfmpeg();
    try {
      await this.run(ffmpeg, [
        '-y', '-loglevel', 'error',
        '-framerate', String(FPS),
        '-start_number', '0',
        '-i', inputPattern,
        '-frames:v', String(frameCount),
        '-c:v', 'libvpx-vp9',
        '-b:v', '0',
        '-crf', '35',
        '-pix_fmt', 'yuv420p',
        webm,
      ], FFMPEG_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`[RECORDING] ffmpeg failed: ${err.message}`);
    }

    let stat;
    try { stat = fs.statSync(webm); }
    catch (err) { throw new Error(`FFmpeg reported success but video file is missing: ${webm}`); }
    if (!stat.isFile() || stat.size < 1024) {
      throw new Error(`FFmpeg produced an invalid/empty video file (${stat.size || 0} bytes)`);
    }
    console.log(`[RECORDING] ffmpeg complete ${session.id} bytes=${stat.size}`);

    // Permanent local storage: MongoDB stores metadata/path only.
    // The completed WebM is never deleted automatically. It is removed only
    // by the explicit Delete / Delete All actions.
    const relativeVideoPath = path.relative(path.join(__dirname, '..', '..'), webm).replace(/\\/g, '/');
    await Recording.findOneAndUpdate(
      { recordingId: session.id },
      {
        $set: {
          recordingId: session.id,
          videoId: session.videoId,
          instanceId: session.instanceId,
          botName: session.botName,
          symbol: session.symbol,
          timeframe: session.timeframe,
          environment: session.environment,
          direction: session.direction,
          level: session.level || null,
          triggerTime: new Date(session.startedAt),
          chunkIndex: 1,
          chunkStartedAt: new Date(session.startedAt),
          chunkEndedAt: new Date(session.startedAt + Math.max(frameCount - 1, 0) * FRAME_INTERVAL_MS),
          durationSeconds: frameCount / FPS,
          frameRate: FPS,
          status: 'READY',
          storageType: 'FILESYSTEM',
          storageStatus: 'STORED',
          fileName: `${session.id}.webm`,
          filePath: relativeVideoPath,
          triggerReason: session.triggerReason || session.decision.reason || reason || null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(`[RECORDING] database record verified ${session.id} videoId=${session.videoId} localFile=${webm}`);
    // Only temporary PNG frames are removed. The final WebM stays permanently.
    try { fs.rmSync(session.framesDir, { recursive: true, force: true }); } catch (_) {}
  }

  _emit(instanceId, status, session, extra = {}) {
    if (!this.io) return;
    this.io.to(`bot:${instanceId}`).emit('bot:recording', {
      instanceId,
      recordingId: session?.id || null,
      status,
      startedAt: session?.startedAt || Date.now(),
      frameRate: FPS,
      level: session?.level || null,
      videoId: session?.videoId || null,
      ...extra,
    });
  }

  run(command, args, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      let settled = false;
      let timeout = null;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        reject(err);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve();
      };

      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', fail);
      child.on('close', code => {
        if (code === 0) succeed();
        else fail(new Error(`${command} exited with ${code}: ${stderr.slice(-2000)}`));
      });

      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_) {}
          fail(new Error(`${command} timed out after ${timeoutMs}ms: ${stderr.slice(-2000)}`));
        }, timeoutMs);
        if (typeof timeout.unref === 'function') timeout.unref();
      }
    });
  }

  _timeframeMs(tf) {
    const m = String(tf || '1m').match(/^(\d+)(m|h|d)$/i);
    if (!m) return 60000;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    return n * ({ m: 60000, h: 3600000, d: 86400000 }[unit]);
  }

  async list(instanceId, limit = 100) {
    const Recording = require('../../models/TradeRecording');
    const BotInstance = require('../../models/BotInstance');
    const safeLimit = Math.min(Number(limit) || 100, 500);
    const [records, bot] = await Promise.all([
      Recording.find({ instanceId }).sort({ triggerTime: -1 }).limit(safeLimit).lean(),
      BotInstance.findOne({ instanceId }).lean(),
    ]);

    const byId = new Map(records.map(r => [String(r.recordingId), r]));
    const files = [];
    if (fs.existsSync(RECORDINGS_DIR)) {
      for (const name of fs.readdirSync(RECORDINGS_DIR)) {
        if (!name.startsWith(`${instanceId}-`)) continue;
        if (!/\.(webm|mp4|mkv)$/i.test(name)) continue;
        const file = path.join(RECORDINGS_DIR, name);
        let stat;
        try { stat = fs.statSync(file); } catch (_) { continue; }
        if (!stat.isFile() || stat.size <= 0) continue;
        const recordingId = path.basename(name, path.extname(name));
        if (byId.has(recordingId)) continue;

        const match = name.match(/-chunk-(\d+)\.(?:webm|mp4|mkv)$/i);
        const chunkIndex = match ? Number(match[1]) : 1;
        const startedAt = stat.birthtimeMs || stat.mtimeMs;
        files.push({
          recordingId,
          instanceId,
          botName: bot?.name || '',
          symbol: bot?.symbol || 'UNKNOWN',
          timeframe: getActiveTimeframe(bot) || bot?.parameters?.timeframe || 'UNKNOWN',
          environment: bot?.environment || 'PAPER',
          direction: 'UNKNOWN',
          level: null,
          triggerTime: new Date(startedAt),
          chunkIndex,
          chunkStartedAt: new Date(startedAt),
          chunkEndedAt: new Date(stat.mtimeMs),
          durationSeconds: null,
          frameRate: FPS,
          status: 'READY',
          fileName: name,
          filePath: path.relative(path.join(__dirname, '..', '..'), file).replace(/\\/g, '/'),
          triggerReason: 'Recovered from video storage',
          recoveredFromStorage: true,
        });
      }
    }

    return [...records, ...files]
      .sort((a, b) => new Date(b.triggerTime || 0).getTime() - new Date(a.triggerTime || 0).getTime())
      .slice(0, safeLimit);
  }
}

module.exports = new RecordingService();
