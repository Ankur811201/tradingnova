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
const CHUNK_DURATION_MS = 30 * 60 * 1000;
const MAX_CANDLES = 300;
const MAX_LEVEL_TOUCH_INDEX = 1; // Only S1/R1 may trigger the first automatic recording.
const CLOSED_TRADE_LOOKUP_ATTEMPTS = 6;
const CLOSED_TRADE_LOOKUP_DELAY_MS = 250;
const FFMPEG_TIMEOUT_BASE_MS = 90 * 1000;
const FFMPEG_TIMEOUT_PER_FRAME_MS = 250;

function validTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

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
    // Recording intent and the one-time S1/R1 trigger are persisted on BotInstance.
    this.deletedInstances = new Set();
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
      chunkIndex: session.chunkIndex,
      desiredOn: true,
    };
  }

  /**
   * Observe the existing live price stream. Recording only: this never changes
   * MODEL_002 strategy state.
   *
   * Only the first S1 or R1 touch may trigger automatic recording, once per bot lifetime.
   */
  observePriceForLevelTouch(bot, price, timestamp) {
    if (!bot || bot.modelId !== 'MODEL_002' || bot.status !== 'RUNNING') return;
    const p = num(price);
    if (p == null || this.active.has(bot.instanceId)) return;
    const state = bot.recordingState || {};
    if (state.autoTriggered || state.desiredOn === false) return;

    const previous = this.lastPrices.get(bot.instanceId);
    this.lastPrices.set(bot.instanceId, p);
    if (previous == null) return;

    const support = Array.isArray(bot.parameters?.support) ? bot.parameters.support : [];
    const resistance = Array.isArray(bot.parameters?.resistance) ? bot.parameters.resistance : [];
    let touch = null;
    const s1 = num(support[0]);
    const r1 = num(resistance[0]);
    if (s1 != null && previous > s1 && p <= s1) touch = { side: 'SUPPORT', index: 1, price: s1, at: timestamp };
    if (r1 != null && previous < r1 && p >= r1) touch = { side: 'RESISTANCE', index: 1, price: r1, at: timestamp };
    if (!touch) return;

    this.startFromLevelTouch({ instanceId: bot.instanceId, touch, bot })
      .catch(err => console.error(`[RECORDING] first S1/R1 trigger failed for ${bot.instanceId}: ${err.message}`));
  }

  async startFromLevelTouch({ instanceId, touch, bot: suppliedBot = null, manual = false, triggerReason = null, startedAt = null, resumed = false }) {
    if (!instanceId || !touch || this.deletedInstances.has(instanceId)) return null;
    const index = Number(touch.index);
    const side = String(touch.side || '').toUpperCase();
    if (!manual && (index !== 1 || !['SUPPORT', 'RESISTANCE'].includes(side))) return null;
    if (manual && side !== 'MANUAL') return null;
    if (!manual && suppliedBot?.recordingState?.desiredOn === false) return null;
    if (this.active.has(instanceId)) return this.active.get(instanceId).id;

    const bot = suppliedBot || await BotInstance.findOne({ instanceId }).lean();
    if (!bot || bot.modelId !== 'MODEL_002') return null;
    if (!resumed && String(bot.status || '').toUpperCase() !== 'RUNNING') {
      throw new Error('Bot must be running to start recording');
    }

    // Atomic one-time claim: duplicate price/event paths cannot create multiple automatic starts.
    if (!manual && !resumed) {
      const claimed = await BotInstance.findOneAndUpdate(
        { instanceId, $or: [{ 'recordingState.autoTriggered': { $exists: false } }, { 'recordingState.autoTriggered': false }] },
        { $set: { 'recordingState.autoTriggered': true, 'recordingState.autoTriggeredAt': new Date(), 'recordingState.desiredOn': true, 'recordingState.paused': false } },
        { new: true }
      ).lean();
      if (!claimed) return null;
    } else if (manual) {
      await BotInstance.updateOne({ instanceId }, { $set: { 'recordingState.desiredOn': true, 'recordingState.paused': false } });
    }

    const levelKey = manual || resumed ? null : `${side === 'SUPPORT' ? 'S' : 'R'}1`;
    // CandlePersistenceService publishes configured bot.parameters.timeframe;
    // use the same canonical value so close events are not filtered out.
    const timeframe = bot.parameters?.timeframe || getActiveTimeframe(bot);
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
      direction: manual || resumed ? 'MANUAL' : (side === 'SUPPORT' ? 'BUY' : 'SELL'),
      support: bot.parameters?.support || [],
      resistance: bot.parameters?.resistance || [],
      level: manual ? null : { side, index, price: num(touch.price) },
      boundaries: { upper: null, lower: null },
      decision: {
        decision: 'TOUCHED',
        reason: triggerReason || (manual || resumed ? (resumed ? 'Recording resumed' : 'Manual recording started') : `${side === 'SUPPORT' ? 'S' : 'R'}1 touched`),
        activeLevel: manual || resumed ? null : { side, index, price: num(touch.price) },
        triggerTime: Date.now(),
      },
      startedAt: validTimestamp(startedAt) || validTimestamp(touch.at) || Date.now(),
      // Wall-clock timestamps of the actual first/last frames, separate from the level-touch trigger time.
      firstFrameAt: null,
      lastFrameAt: null,
      frameIndex: 0,
      chunkIndex: Number(bot.recordingState?.chunkIndex || 1),
      chunkStartedAt: validTimestamp(startedAt) || validTimestamp(touch.at) || Date.now(),
      videoId: crypto.randomUUID(),
      mode: resumed ? 'RESUMED' : (manual ? 'MANUAL' : 'LEVEL_TOUCH'),
      levelKey,
      tradeNumber: 0,
      tradeId: null,
      entryOpenedAt: null,
      entryCandleCloseCount: 0,
      noEntryCandleCloseCount: 0,
      triggerReason: triggerReason || null,
      framesDir: dir,
      candles: new Map(),
      currentCandle: null,
      currentPrice: null,
      stopTimer: null,
      maxTimer: null,
      timer: null,
      rotating: false,
      rotationPromise: null,
      rotationTimer: null,
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
    this._startCaptureLoop(session);
    this._scheduleChunkRotation(session);
    await BotInstance.updateOne({ instanceId }, { $set: { 'recordingState.desiredOn': true, 'recordingState.paused': false, 'recordingState.chunkIndex': session.chunkIndex } });
    return id;
  }

  _startCaptureLoop(session) {
    clearInterval(session.timer);
    session.timer = setInterval(() => {
      session.capturePromise = session.capturePromise
        .then(() => this.captureFrame(session))
        .catch(err => console.error(`[RECORDING] frame failed for ${session.id}: ${err.stack || err.message}`));
    }, FRAME_INTERVAL_MS);
  }

  async startManual(instanceId) {
    if (!instanceId) return null;
    if (this.active.has(instanceId)) return this.active.get(instanceId).id;
    const bot = await BotInstance.findOne({ instanceId }).lean();
    if (!bot || bot.modelId !== 'MODEL_002') throw new Error('Manual recording is currently supported for MODEL_002 bots only');
    if (String(bot.status || '').toUpperCase() !== 'RUNNING') throw new Error('Resume the bot before starting a recording');
    return this.startFromLevelTouch({ instanceId, bot, manual: true, touch: { side: 'MANUAL', index: 0, price: null, at: Date.now() } });
  }

  async stopManual(instanceId) {
    await BotInstance.updateOne({ instanceId }, { $set: { 'recordingState.desiredOn': false, 'recordingState.paused': false } });
    return this.stop(instanceId, 'MANUAL_STOP');
  }

  async pauseForBot(instanceId) {
    const wasActive = this.active.has(instanceId);
    const bot = await BotInstance.findOne({ instanceId }).select('recordingState').lean();
    const desiredOn = wasActive || Boolean(bot?.recordingState?.desiredOn);
    await BotInstance.updateOne({ instanceId }, { $set: { 'recordingState.desiredOn': desiredOn, 'recordingState.paused': true } });
    if (wasActive) await this.stop(instanceId, 'BOT_PAUSE');
  }

  async resumeForBot(instanceId, bot = null) {
    const currentBot = bot || await BotInstance.findOne({ instanceId }).lean();
    if (!currentBot || currentBot.modelId !== 'MODEL_002') return null;
    const state = currentBot.recordingState || {};
    await BotInstance.updateOne({ instanceId }, { $set: { 'recordingState.paused': false } });
    if (!state.desiredOn || this.active.has(instanceId)) return null;
    return this.startFromLevelTouch({ instanceId, bot: currentBot, resumed: true, manual: true, touch: { side: 'MANUAL', index: 0, price: null, at: Date.now() }, triggerReason: 'Recording resumed after bot/server pause' });
  }

  async recoverPersistedRecordings() {
    const bots = await BotInstance.find({ modelId: 'MODEL_002', status: { $in: ['RUNNING', 'STOPPED'] }, 'recordingState.desiredOn': true, 'recordingState.paused': { $ne: true } }).lean();
    const results = [];
    for (const bot of bots) {
      try {
        const recordingId = await this.resumeForBot(bot.instanceId, bot);
        results.push({ instanceId: bot.instanceId, resumed: Boolean(recordingId) });
      } catch (err) {
        results.push({ instanceId: bot.instanceId, resumed: false, error: err.message });
        console.error(`[RECORDING] restart recovery failed for ${bot.instanceId}: ${err.message}`);
      }
    }
    return results;
  }

  _scheduleChunkRotation(session) {
    if (!session || session.stopping) return;
    clearTimeout(session.rotationTimer);
    const elapsed = Math.max(0, Date.now() - Number(session.chunkStartedAt || Date.now()));
    session.rotationTimer = setTimeout(() => {
      session.rotationPromise = this._rotateChunk(session).catch(err => {
        console.error(`[RECORDING] chunk rotation failed for ${session.instanceId}: ${err.message}`);
      });
    }, Math.max(1, CHUNK_DURATION_MS - elapsed));
    if (session.rotationTimer.unref) session.rotationTimer.unref();
  }

  async _rotateChunk(session) {
    if (!session || session.stopping || this.active.get(session.instanceId) !== session) return;
    if (session.rotating) return session.rotationPromise;
    session.rotating = true;
    clearInterval(session.timer);
    try {
      await session.capturePromise;
      await this.captureFrame(session, true);
      const old = { ...session, candles: new Map(session.candles), executionMarkers: [...session.executionMarkers], position: session.position };
      old.stopTimer = old.maxTimer = old.timer = old.rotationTimer = null;
      const nextIndex = Number(session.chunkIndex || 1) + 1;
      const nextId = `${session.instanceId}-${Date.now()}-${nextIndex}`;
      const nextDir = path.join(RECORDINGS_DIR, nextId);
      fs.mkdirSync(nextDir, { recursive: true });
      session.id = nextId;
      session.videoId = crypto.randomUUID();
      session.framesDir = nextDir;
      session.frameIndex = 0;
      session.firstFrameAt = null;
      session.lastFrameAt = null;
      session.chunkIndex = nextIndex;
      session.chunkStartedAt = Date.now();
      session.startedAt = session.chunkStartedAt;
      await BotInstance.updateOne({ instanceId: session.instanceId }, { $set: { 'recordingState.chunkIndex': nextIndex, 'recordingState.desiredOn': true } });
      session.rotating = false;
      await this.captureFrame(session);
      this._startCaptureLoop(session);
      this._scheduleChunkRotation(session);
      // Encoding the prior chunk runs independently; the active capture loop continues on the new directory.
      this._finalizeRecording(old, 'CHUNK_ROTATION').catch(async err => {
        console.error(`[RECORDING] rotated chunk ${old.id} failed: ${err.message}`);
        await this._saveFailedChunk(old, 'CHUNK_ROTATION', err);
      });
      this._emit(session.instanceId, 'CHUNK_STARTED', session, { chunkIndex: nextIndex });
    } finally {
      session.rotating = false;
    }
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

  /** Notify recording lifecycle about an already-committed position close.
   * Some live close paths persist Position before Trade. Retry the exact
   * position-linked Trade lookup briefly instead of silently losing the event.
   */
  async handleClosedTrade(instanceId, positionId) {
    if (!positionId) return false;
    const Position = require('../../models/Position');
    const Trade = require('../../models/Trade');
    let position = null;
    let effectiveInstanceId = instanceId || null;
    let trade = null;

    for (let attempt = 0; attempt < CLOSED_TRADE_LOOKUP_ATTEMPTS; attempt += 1) {
      position = await Position.findById(positionId).lean();
      if (!position || position.status !== 'CLOSED') {
        if (attempt < CLOSED_TRADE_LOOKUP_ATTEMPTS - 1) {
          await new Promise(resolve => setTimeout(resolve, CLOSED_TRADE_LOOKUP_DELAY_MS));
          continue;
        }
        console.warn(`[RECORDING] closed position ${positionId} was not visible as CLOSED after retries`);
        return false;
      }
      effectiveInstanceId = effectiveInstanceId || position.instanceId;
      if (!effectiveInstanceId) return false;
      trade = await Trade.findOne({
        instanceId: effectiveInstanceId,
        position: position._id,
        environment: position.environment,
      }).sort({ closedAt: -1 }).lean();
      if (trade) break;
      if (attempt < CLOSED_TRADE_LOOKUP_ATTEMPTS - 1) {
        await new Promise(resolve => setTimeout(resolve, CLOSED_TRADE_LOOKUP_DELAY_MS));
      }
    }

    if (!trade) {
      console.error(`[RECORDING] closed position ${positionId} has no linked Trade after ${CLOSED_TRADE_LOOKUP_ATTEMPTS} attempts; close lifecycle could not be applied`);
      return false;
    }
    this.updateExecution(effectiveInstanceId, { instanceId: effectiveInstanceId, action: 'CLOSE', position, trade });
    return true;
  }

  async stopAll(reason = 'SERVER_SHUTDOWN') {
    const instanceIds = Array.from(this.active.keys());
    const results = await Promise.allSettled(instanceIds.map(id => this.stop(id, reason)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`[RECORDING] shutdown finalize failed for ${instanceIds[index]}: ${result.reason?.message || result.reason}`);
      }
    });
    return results;
  }

  updateExecution(instanceId, execution) {
    if (!execution) return;
    const session = this.active.get(instanceId);
    const position = execution.position || null;
    const trade = execution.trade || null;

    // OPEN: attach authoritative trade/position metadata only; no lifecycle side effects.
    if (position && String(execution.action || '').toUpperCase() !== 'CLOSE') {
      if (session && session.id) {
        session.position = position;
            if (!session.tradeId || session.tradeId !== String(position._id || '')) {
          session.tradeId = String(position._id || `${position.openedAt || Date.now()}`);
          session.entryOpenedAt = position.openedAt instanceof Date
            ? position.openedAt.getTime()
            : new Date(position.openedAt || Date.now()).getTime();
          session.entryCandleCloseCount = 0;

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

    // Trade opens/closes are visual metadata only. They never control recording lifecycle.
  }

  async stop(instanceId, reason = 'EVENT') {
    const session = this.active.get(instanceId);
    if (!session) return;
    // Concurrent exit/fallback/shutdown triggers must all await the same finalizer.
    if (session.stopPromise) return session.stopPromise;
    if (session.rotationPromise) { try { await session.rotationPromise; } catch (_) {} }
    session.stopping = true;
    clearInterval(session.timer);
    clearTimeout(session.stopTimer);
    clearTimeout(session.maxTimer);
    clearTimeout(session.rotationTimer);

    session.stopPromise = (async () => {
      try {
        await session.capturePromise;
        await this.captureFrame(session, true);
        await this._finalizeRecording(session, reason);
        if (!(reason === 'BOT_PAUSE' || reason === 'PROCESS_RESTART' || String(reason).startsWith('SERVER_SHUTDOWN'))) {
          await BotInstance.updateOne({ instanceId }, { $set: { 'recordingState.desiredOn': false, 'recordingState.paused': false } });
        }
        this._emit(instanceId, 'STOPPED', session, { reason, videoId: session.videoId });
      } catch (err) {
        console.error(`[RECORDING] ${session.id} failed: ${err.stack || err.message}`);
        this._emit(instanceId, 'FAILED', session, { reason, error: err.message, videoId: session.videoId, framesPreserved: true });
        // Keep source frames on every finalize/encode failure so the video can be
        // recovered manually or retried. Never silently destroy the only copy.
        console.error(`[RECORDING] source frames preserved for retry: ${session.framesDir}`);
        await this._saveFailedChunk(session, reason, err);
      } finally {
        this.active.delete(instanceId);
        if (session.renderer) {
          try { await session.renderer.stop(); } catch (_) {}
          session.renderer = null;
        }
      }
    })();
    return session.stopPromise;
  }

  async captureFrame(session, finalFrame = false) {
    if (!session || (!finalFrame && (session.stopping || session.rotating)) || !session.renderer) return;
    try {
      await session.renderer.update(session);
    } catch (err) {
      throw new Error(`[RECORDING] frame generation failed ${session.id}: ${err.message}`);
    }
    const file = path.join(session.framesDir, `frame-${String(session.frameIndex).padStart(6, '0')}.png`);
    try {
      await session.renderer.screenshot(file);
      const capturedAt = Date.now();
      if (!session.firstFrameAt) session.firstFrameAt = capturedAt;
      session.lastFrameAt = capturedAt;
      session.frameIndex += 1;
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
        '-deadline', 'realtime',
        '-cpu-used', '8',
        '-row-mt', '1',
        '-b:v', '0',
        '-crf', '35',
        '-pix_fmt', 'yuv420p',
        webm,
      ], Math.max(FFMPEG_TIMEOUT_BASE_MS, FFMPEG_TIMEOUT_BASE_MS + frameCount * FFMPEG_TIMEOUT_PER_FRAME_MS));
    } catch (err) {
      throw new Error(`[RECORDING] ffmpeg failed: ${err.message}`);
    }

    let stat;
    try { stat = fs.statSync(webm); }
    catch (err) { throw new Error(`FFmpeg reported success but video file is missing: ${webm}`); }
    if (!stat.isFile() || stat.size < 1024) {
      throw new Error(`FFmpeg produced an invalid/empty video file (${stat.size || 0} bytes)`);
    }
    // Validate the produced container by decoding it fully before declaring
    // READY or removing the source frames.
    try {
      await this.run(resolveFfmpeg(), ['-v', 'error', '-i', webm, '-map', '0:v:0', '-f', 'null', '-'],
        Math.max(FFMPEG_TIMEOUT_BASE_MS, FFMPEG_TIMEOUT_BASE_MS + frameCount * FFMPEG_TIMEOUT_PER_FRAME_MS));
    } catch (err) {
      try { fs.rmSync(webm, { force: true }); } catch (_) {}
      throw new Error(`Recorded WebM failed media validation: ${err.message}`);
    }
    console.log(`[RECORDING] ffmpeg complete and validated ${session.id} bytes=${stat.size}`);

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
          chunkIndex: Number(session.chunkIndex || 1),
          chunkStartedAt: new Date(session.firstFrameAt || session.startedAt),
          chunkEndedAt: new Date(session.lastFrameAt || session.firstFrameAt || session.startedAt),
          durationSeconds: Math.max(0, Number(session.lastFrameAt || Date.now()) - Number(session.firstFrameAt || session.startedAt)) / 1000,
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

  async _saveFailedChunk(session, reason, err) {
    try {
      const Recording = require('../../models/TradeRecording');
      await Recording.findOneAndUpdate({ recordingId: session.id }, { $set: {
        recordingId: session.id, videoId: session.videoId, instanceId: session.instanceId,
        botName: session.botName, symbol: session.symbol, timeframe: session.timeframe,
        environment: session.environment, direction: session.direction, level: session.level || null,
        triggerTime: new Date(session.startedAt), chunkIndex: Number(session.chunkIndex || 1),
        chunkStartedAt: new Date(session.firstFrameAt || session.startedAt),
        chunkEndedAt: new Date(session.lastFrameAt || session.firstFrameAt || session.startedAt),
        durationSeconds: session.frameIndex / FPS, frameRate: FPS, status: 'FAILED',
        storageType: 'FILESYSTEM', storageStatus: 'FAILED', fileName: null, filePath: null,
        triggerReason: `${session.triggerReason || reason || 'RECORDING'} | FINALIZE_FAILED: ${err.message} | FRAMES: ${session.framesDir}`,
      } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    } catch (dbErr) {
      console.error(`[RECORDING] failed metadata write for ${session.id}: ${dbErr.message}`);
    }
  }

  async deleteInstanceData(instanceId) {
    if (!instanceId) return;
    this.deletedInstances.add(instanceId);
    if (this.active.has(instanceId)) await this.stop(instanceId, 'BOT_DELETE');
    const Recording = require('../../models/TradeRecording');
    await Recording.deleteMany({ instanceId });
    const prefix = `${instanceId}-`;
    for (const root of [RECORDINGS_DIR, path.join(__dirname, '..', '..', 'storage', 'recording-runtime')]) {
      if (!fs.existsSync(root)) continue;
      for (const name of fs.readdirSync(root)) {
        if (!name.startsWith(prefix)) continue;
        try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); }
        catch (err) { console.error(`[RECORDING] delete artifact failed ${name}: ${err.message}`); throw err; }
      }
    }
    this.lastPrices.delete(instanceId);
    this._emit(instanceId, 'DELETED', null, { deleted: true });
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

    // Normalize legacy metadata before returning it to the UI. Older records can
    // contain Unix epoch timestamps (1970) or null durations from recovery.
    const normalizedRecords = records.map((record) => {
      const item = { ...record };
      let videoPath = item.filePath ? path.resolve(path.join(__dirname, '..', '..'), item.filePath) : null;
      let stat = null;
      try {
        if (videoPath && videoPath.startsWith(RECORDINGS_DIR + path.sep) && fs.existsSync(videoPath)) stat = fs.statSync(videoPath);
        if (!stat) {
          const recoveredPath = path.join(RECORDINGS_DIR, `${item.recordingId}.webm`);
          if (recoveredPath.startsWith(RECORDINGS_DIR + path.sep) && fs.existsSync(recoveredPath)) {
            videoPath = recoveredPath;
            stat = fs.statSync(recoveredPath);
          }
        }
      } catch (_) {}
      const isUsableDate = value => {
        const ms = value ? new Date(value).getTime() : NaN;
        return Number.isFinite(ms) && ms >= Date.UTC(2000, 0, 1) ? ms : null;
      };
      const fileStart = stat ? (stat.birthtimeMs > Date.UTC(2000, 0, 1) ? stat.birthtimeMs : stat.mtimeMs) : null;
      const fileEnd = stat ? stat.mtimeMs : null;
      const startMs = isUsableDate(item.chunkStartedAt) || isUsableDate(item.triggerTime) || (fileStart && fileStart >= Date.UTC(2000, 0, 1) ? fileStart : null);
      const endMs = isUsableDate(item.chunkEndedAt) || (fileEnd && startMs && fileEnd >= startMs ? fileEnd : null);
      if (startMs) {
        item.chunkStartedAt = new Date(startMs);
        if (!isUsableDate(item.triggerTime)) item.triggerTime = new Date(startMs);
      } else {
        item.chunkStartedAt = null;
      }
      item.chunkEndedAt = endMs ? new Date(endMs) : null;
      const duration = Number(item.durationSeconds);
      if (!Number.isFinite(duration) || duration <= 0) {
        item.durationSeconds = startMs && endMs && endMs >= startMs ? Math.round((endMs - startMs) / 1000) : 0;
      }
      return item;
    });
    const byId = new Map(normalizedRecords.map(r => [String(r.recordingId), r]));
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
          durationSeconds: Math.max(0, Math.round((stat.mtimeMs - startedAt) / 1000)),
          frameRate: FPS,
          status: 'READY',
          fileName: name,
          filePath: path.relative(path.join(__dirname, '..', '..'), file).replace(/\\/g, '/'),
          triggerReason: 'Recovered from video storage',
          recoveredFromStorage: true,
        });
      }
    }

    return [...normalizedRecords, ...files]
      .sort((a, b) => new Date(b.triggerTime || 0).getTime() - new Date(a.triggerTime || 0).getTime())
      .slice(0, safeLimit);
  }
}

module.exports = new RecordingService();
