'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Candle = require('../../models/Candle');
const BotInstance = require('../../models/BotInstance');
const { getActiveTimeframe } = require('../../utils/activeTimeframe');
const SvgChartRenderer = require('./SvgChartRenderer');

const RECORDINGS_DIR = path.join(__dirname, '..', '..', 'storage', 'recordings');
const FRAME_INTERVAL_MS = 2000;
const FPS = 1 / (FRAME_INTERVAL_MS / 1000);
const POST_EVENT_TAIL_MS = 5000;
const CHUNK_MS = 10 * 60 * 1000;
const MAX_RECORDING_MS = 24 * 60 * 60 * 1000;
const MAX_CANDLES = 300;
const MAX_LEVEL_TOUCH_INDEX = 1; // Only S1 / R1 start recordings.
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
    };
  }

  /**
   * Observe the same live price tick already dispatched by BotManager.
   * Recording is the only consumer here: this does not change MODEL_002
   * strategy state. A recording starts only when price crosses/touches S1
   * from above or R1 from below, so it fires at the real live touch rather
   * than waiting for a candle to close.
   */
  observePriceForLevelTouch(bot, price, timestamp) {
    if (!bot || bot.modelId !== 'MODEL_002' || bot.status !== 'RUNNING') return;
    const p = num(price);
    if (p == null) return;

    const previous = this.lastPrices.get(bot.instanceId);
    this.lastPrices.set(bot.instanceId, p);
    if (previous == null || this.active.has(bot.instanceId)) return;

    const support = Array.isArray(bot.parameters?.support) ? num(bot.parameters.support[0]) : null;
    const resistance = Array.isArray(bot.parameters?.resistance) ? num(bot.parameters.resistance[0]) : null;

    let touch = null;
    if (support != null && previous > support && p <= support) {
      touch = { side: 'SUPPORT', index: 1, price: support, at: timestamp };
    } else if (resistance != null && previous < resistance && p >= resistance) {
      touch = { side: 'RESISTANCE', index: 1, price: resistance, at: timestamp };
    }

    if (!touch) return;
    this.startFromLevelTouch({ instanceId: bot.instanceId, touch, bot })
      .catch((err) => console.error(`[RECORDING] live level-touch start failed for ${bot.instanceId}: ${err.message}`));
  }

  async startFromLevelTouch({ instanceId, touch, bot: suppliedBot = null, manual = false }) {
    if (!instanceId || !touch) return null;
    const index = Number(touch.index);
    const side = String(touch.side || '').toUpperCase();
    if (!manual && (index !== MAX_LEVEL_TOUCH_INDEX || !['SUPPORT', 'RESISTANCE'].includes(side))) return null;
    if (manual && side !== 'MANUAL') return null;
    if (this.active.has(instanceId)) return this.active.get(instanceId).id;

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
        reason: manual ? 'Manual recording started' : `${side === 'SUPPORT' ? 'S' : 'R'}${index} touched`,
        activeLevel: manual ? null : { side, index, price: num(touch.price) },
        triggerTime: Date.now(),
      },
      startedAt: Number.isFinite(Number(touch.at)) ? Number(touch.at) : Date.now(),
      frameIndex: 0,
      chunkIndex: 1,
      chunkStartedAt: Number.isFinite(Number(touch.at)) ? Number(touch.at) : Date.now(),
      framesDir: dir,
      candles: new Map(),
      currentCandle: null,
      currentPrice: null,
      stopTimer: null,
      maxTimer: null,
      timer: null,
      chunkTimer: null,
      rotationPromise: null,
      rotating: false,
      stopping: false,
      renderer: null,
      capturePromise: Promise.resolve(),
      executionMarkers: [],
      targetExitPlan: null,
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
    // Frame capture and chunk rotation are deliberately independent. A slow
    // encode must never prevent the 5-minute boundary from being scheduled.
    session.timer = setInterval(() => {
      session.capturePromise = session.capturePromise
        .then(() => this.captureFrame(session))
        .catch(err => console.error(`[RECORDING] frame failed for ${session.id}: ${err.stack || err.message}`));
    }, FRAME_INTERVAL_MS);
    this._scheduleChunkRotation(session);

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

  updateTargetPlan(instanceId, plan) {
    const session = this.active.get(instanceId);
    if (!session) return;
    session.targetExitPlan = plan && plan.enabled ? JSON.parse(JSON.stringify(plan)) : null;
  }

  updateExecution(instanceId, execution) {
    const session = this.active.get(instanceId);
    if (!session || !execution) return;
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
    if (execution.position) {
      const m = toMarker('ENTRY', execution.position);
      if (m) markers.push(m);
    }
    if (execution.trade) {
      const entry = toMarker('ENTRY', execution.trade);
      const exit = toMarker('EXIT', execution.trade);
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
    clearTimeout(session.chunkTimer);

    try {
      // If a chunk rotation is already encoding, finish it before finalizing
      // the current chunk. This prevents duplicate/partial chunk records.
      if (session.rotationPromise) await session.rotationPromise;
      await session.capturePromise;
      await this.captureFrame(session);
      await this._finalizeChunk(session, reason);
      this._emit(instanceId, 'STOPPED', session, { reason });
    } catch (err) {
      console.error(`[RECORDING] ${session.id} failed: ${err.stack || err.message}`);
      this._emit(instanceId, 'FAILED', session, { reason, error: err.message });
      try { fs.rmSync(session.framesDir, { recursive: true, force: true }); } catch (_) {}
    } finally {
      this.active.delete(instanceId);
      if (session.renderer) {
        try { await session.renderer.stop(); } catch (_) {}
        session.renderer = null;
      }
    }
  }

  async captureFrame(session) {
    if (!session || session.stopping || session.rotating || !session.renderer) return;
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

  async _rotateChunkIfNeeded(session) {
    if (!session || session.stopping || session.rotating) return;
    const elapsed = Date.now() - session.chunkStartedAt;
    if (elapsed < CHUNK_MS) {
      this._scheduleChunkRotation(session);
      return;
    }

    session.rotating = true;
    // Finish any in-flight 0.5 FPS frame before detaching the old chunk
    // directory. Otherwise a slow screenshot could land in the wrong chunk.
    await session.capturePromise;
    const oldDir = session.framesDir;
    const oldIndex = session.chunkIndex;
    const oldStartedAt = session.chunkStartedAt;
    const oldFrameIndex = session.frameIndex;

    session.chunkIndex += 1;
    session.chunkStartedAt = Date.now();
    session.frameIndex = 0;
    session.framesDir = path.join(RECORDINGS_DIR, `${session.id}-chunk-${session.chunkIndex}`);
    fs.mkdirSync(session.framesDir, { recursive: true });

    console.log(`[RECORDING] rotating ${session.id} chunk=${oldIndex} frames=${oldFrameIndex}`);
    try {
      await this._encodeChunk(session, oldDir, oldIndex, oldStartedAt, oldFrameIndex);
      this._emit(session.instanceId, 'CHUNK_READY', session, { chunkIndex: oldIndex });
    } catch (err) {
      console.error(`[RECORDING] chunk failed ${session.id} chunk=${oldIndex}: ${err.stack || err.message}`);
      this._emit(session.instanceId, 'CHUNK_FAILED', session, { chunkIndex: oldIndex, error: err.message });
      try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (_) {}
    } finally {
      session.rotating = false;
      session.rotationPromise = null;
    }
  }

  _scheduleChunkRotation(session) {
    if (!session || session.stopping) return;
    if (session.chunkTimer) clearInterval(session.chunkTimer);

    // Chunk rotation has its own timer. It is intentionally independent from
    // frame capture and from FFmpeg. We check the wall-clock boundary and
    // rotate exactly once when the current 10-minute chunk ends.
    session.chunkTimer = setInterval(() => {
      if (session.stopping || session.rotating) return;
      const elapsed = Date.now() - session.chunkStartedAt;
      if (elapsed < CHUNK_MS) return;

      session.rotationPromise = this._rotateChunkIfNeeded(session)
        .catch(err => {
          console.error(`[RECORDING] chunk rotation failed for ${session.id}: ${err.stack || err.message}`);
          this._emit(session.instanceId, 'CHUNK_FAILED', session, { error: err.message });
        });
    }, 1000);

    if (typeof session.chunkTimer.unref === 'function') session.chunkTimer.unref();
  }

  async _finalizeChunk(session, reason) {
    const frameCount = session.frameIndex;
    if (!frameCount) {
      try { fs.rmSync(session.framesDir, { recursive: true, force: true }); } catch (_) {}
      return;
    }
    await this._encodeChunk(session, session.framesDir, session.chunkIndex, session.chunkStartedAt, frameCount, reason);
  }

  async _encodeChunk(session, framesDir, chunkIndex, chunkStartedAt, frameCount, reason = 'CHUNK_COMPLETE') {
    const Recording = require('../../models/TradeRecording');
    const webm = path.join(RECORDINGS_DIR, `${session.id}-chunk-${chunkIndex}.webm`);
    const inputPattern = path.join(framesDir, 'frame-%06d.png');

    if (!fs.existsSync(framesDir)) {
      throw new Error(`Recording frames directory missing: ${framesDir}`);
    }
    if (!Number.isInteger(frameCount) || frameCount < 1) {
      throw new Error(`Invalid frame count ${frameCount} for chunk ${chunkIndex}`);
    }

    console.log(`[RECORDING] encoding ${session.id} chunk=${chunkIndex} frames=${frameCount}`);
    const ffmpeg = resolveFfmpeg();
    try {
      await this.run(ffmpeg, [
        '-y',
        '-loglevel', 'error',
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
      throw new Error(`[RECORDING] ffmpeg failed chunk=${chunkIndex}: ${err.message}`);
    }
    console.log(`[RECORDING] ffmpeg complete ${session.id} chunk=${chunkIndex}`);

    let stat;
    try {
      stat = fs.statSync(webm);
    } catch (err) {
      throw new Error(`FFmpeg reported success but video file is missing: ${webm}`);
    }
    if (!stat.isFile() || stat.size < 1024) {
      throw new Error(`FFmpeg produced an invalid/empty video file (${stat.size || 0} bytes): ${webm}`);
    }

    try {
      await Recording.create({
        recordingId: `${session.id}-chunk-${chunkIndex}`,
        instanceId: session.instanceId,
        botName: session.botName,
        symbol: session.symbol,
        timeframe: session.timeframe,
        environment: session.environment,
        direction: session.direction,
        level: session.level || null,
        triggerTime: new Date(session.startedAt),
        chunkIndex,
        chunkStartedAt: new Date(chunkStartedAt),
        chunkEndedAt: new Date(chunkStartedAt + Math.max(frameCount - 1, 0) * FRAME_INTERVAL_MS),
        durationSeconds: frameCount / FPS,
        frameRate: FPS,
        status: 'READY',
        fileName: path.basename(webm),
        filePath: path.relative(path.join(__dirname, '..', '..'), webm).replace(/\\/g, '/'),
        triggerReason: session.decision.reason || reason || null,
      });
    } catch (err) {
      throw new Error(`[RECORDING] database save failed chunk=${chunkIndex}: ${err.message}`);
    }
    console.log(`[RECORDING] database record ready ${session.id} chunk=${chunkIndex}`);

    try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch (_) {}
  }

  _emit(instanceId, status, session, extra = {}) {
    if (!this.io) return;
    this.io.to(`bot:${instanceId}`).emit('bot:recording', {
      instanceId,
      recordingId: session.id,
      status,
      startedAt: session.startedAt,
      frameRate: FPS,
      level: session.level || null,
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

  async list(instanceId, limit = 50) {
    const Recording = require('../../models/TradeRecording');
    return Recording.find({ instanceId }).sort({ triggerTime: -1 }).limit(Math.min(Number(limit) || 50, 100)).lean();
  }
}

module.exports = new RecordingService();
