'use strict';

const BotInstance = require('../models/BotInstance');
const Trade = require('../models/Trade');
const StrategyEvent = require('../models/StrategyEvent');
const recordingService = require('../services/recording/RecordingService');
const path = require('path');
const fs = require('fs');

async function resolveRecording(instanceId, recordingId) {
  const Recording = require('../models/TradeRecording');
  const stored = await Recording.findOne({ recordingId, instanceId }).lean();
  if (stored) return stored;

  // Recover orphaned videos directly from the recording storage folder.
  const recordingsRoot = path.resolve(__dirname, '..', 'storage', 'recordings');
  const candidates = [
    `${recordingId}.webm`, `${recordingId}.mp4`, `${recordingId}.mkv`,
  ];
  for (const name of candidates) {
    const filePath = path.join(recordingsRoot, name);
    if (!filePath.startsWith(recordingsRoot + path.sep) || !fs.existsSync(filePath)) continue;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) continue;
    const BotInstance = require('../models/BotInstance');
    const bot = await BotInstance.findOne({ instanceId }).lean();
    return {
      recordingId, instanceId, botName: bot?.name || '', symbol: bot?.symbol || 'UNKNOWN',
      timeframe: bot?.parameters?.timeframe || 'UNKNOWN', environment: bot?.environment || 'PAPER',
      direction: 'UNKNOWN', level: null, triggerTime: new Date(stat.birthtimeMs || stat.mtimeMs),
      chunkIndex: 1, chunkStartedAt: new Date(stat.birthtimeMs || stat.mtimeMs), chunkEndedAt: new Date(stat.mtimeMs),
      durationSeconds: null, frameRate: 0.5, status: 'READY', fileName: name,
      filePath: path.relative(path.join(__dirname, '..'), filePath).replace(/\\/g, '/'),
      triggerReason: 'Recovered from video storage', recoveredFromStorage: true,
    };
  }
  return null;
}


async function startRecording(req, res, next) {
  try {
    const { instanceId } = req.params;
    const bot = await BotInstance.findOne({ instanceId, user: req.session.userId }).lean();
    if (!bot) return res.status(404).json({ ok: false, error: 'Bot instance not found' });

    const recordingId = await recordingService.startManual(instanceId);
    return res.status(201).json({ ok: true, recordingId, active: recordingService.getActive(instanceId) });
  } catch (err) {
    return res.status(409).json({ ok: false, error: err.message || 'Unable to start recording' });
  }
}

async function stopRecording(req, res, next) {
  try {
    const { instanceId } = req.params;
    const bot = await BotInstance.findOne({ instanceId, user: req.session.userId }).lean();
    if (!bot) return res.status(404).json({ ok: false, error: 'Bot instance not found' });

    const active = recordingService.getActive(instanceId);
    if (!active) return res.status(404).json({ ok: false, error: 'No active recording' });

    await recordingService.stop(instanceId, 'MANUAL_STOP');
    return res.json({ ok: true, recordingId: active.recordingId });
  } catch (err) {
    return next(err);
  }
}

async function listRecordings(req, res, next) {
  try {
    const { instanceId } = req.params;
    const bot = await BotInstance.findOne({ instanceId, user: req.session.userId }).lean();
    if (!bot) return res.status(404).json({ ok: false, error: 'Bot instance not found' });

    const recordings = await recordingService.list(instanceId);
    return res.json({ ok: true, recordings, active: recordingService.getActive(instanceId) });
  } catch (err) {
    return next(err);
  }
}

async function getRecording(req, res, next) {
  try {
    const { instanceId, recordingId } = req.params;
    const bot = await BotInstance.findOne({ instanceId, user: req.session.userId }).lean();
    if (!bot) return res.status(404).json({ ok: false, error: 'Bot instance not found' });

    const recording = await resolveRecording(instanceId, recordingId);
    if (!recording || recording.status !== 'READY' || !recording.filePath) {
      return res.status(404).json({ ok: false, error: 'Recording not found' });
    }

    return res.sendFile(path.resolve(__dirname, '..', recording.filePath));
  } catch (err) {
    return next(err);
  }
}



async function renderRecordingPlayer(req, res, next) {
  try {
    const { instanceId, recordingId } = req.params;
    const bot = await BotInstance.findOne({ instanceId, user: req.session.userId }).lean();
    if (!bot) return res.status(404).render('404', { title: 'Bot Instance Not Found' });

    const recording = await resolveRecording(instanceId, recordingId);
    if (!recording || recording.status !== 'READY' || !recording.filePath) {
      return res.status(404).render('404', { title: 'Recording Not Found' });
    }

    const start = recording.chunkStartedAt || recording.triggerTime;
    const end = recording.chunkEndedAt || new Date(new Date(start).getTime() + Number(recording.durationSeconds || 0) * 1000);

    const [trades, strategyEvents] = await Promise.all([
      Trade.find({
        instanceId,
        environment: recording.environment,
        $or: [
          { openedAt: { $gte: start, $lte: end } },
          { closedAt: { $gte: start, $lte: end } },
          { openedAt: { $lte: start }, closedAt: { $gte: start } },
        ],
      }).sort({ openedAt: 1, closedAt: 1 }).limit(100).lean(),
      StrategyEvent.find({
        instanceId,
        at: { $gte: start, $lte: end },
      }).sort({ at: 1 }).limit(300).lean(),
    ]);

    const events = [];
    const addEvent = (event) => {
      const at = new Date(event.at);
      const seconds = Math.max(0, Math.min(Number(recording.durationSeconds || 0), (at.getTime() - new Date(start).getTime()) / 1000));
      events.push({ ...event, seconds });
    };

    if (recording.triggerTime) {
      addEvent({
        type: recording.direction === 'MANUAL' ? 'RECORDING' : recording.direction,
        at: recording.triggerTime,
        price: recording.level && recording.level.price != null ? recording.level.price : null,
        label: recording.triggerReason || (recording.level ? `${recording.level.side === 'SUPPORT' ? 'S' : 'R'}${recording.level.index} touched` : 'Recording started'),
      });
    }

    for (const trade of trades) {
      if (trade.openedAt) addEvent({ type: trade.side === 'LONG' ? 'BUY' : 'SELL', at: trade.openedAt, price: trade.entryPrice, label: 'Trade entry', tradeId: String(trade._id), pnl: null });
      if (trade.closedAt) addEvent({ type: 'EXIT', at: trade.closedAt, price: trade.exitPrice, label: trade.reason || 'Trade exit', tradeId: String(trade._id), pnl: trade.realizedPnl });
    }

    for (const event of strategyEvents) {
      const type = String(event.eventType || 'EVENT').toUpperCase();
      addEvent({
        type,
        at: event.at,
        price: event.payload && (event.payload.price ?? event.payload.entryPrice ?? event.payload.levelPrice),
        label: event.payload && (event.payload.reason || event.payload.message || event.payload.label) || type.replace(/_/g, ' '),
      });
    }

    events.sort((a, b) => a.seconds - b.seconds);

    return res.render('recording-player', {
      title: `Recording Player — ${recording.symbol}`,
      bot,
      recording,
      events,
      player: {
        videoUrl: `/api/recordings/${encodeURIComponent(instanceId)}/${encodeURIComponent(recordingId)}/video`,
        start,
        end,
      },
    });
  } catch (err) {
    return next(err);
  }
}

async function deleteRecording(req, res, next) {
  try {
    const { instanceId, recordingId } = req.params;
    const bot = await BotInstance.findOne({ instanceId, user: req.session.userId }).lean();
    if (!bot) return res.status(404).json({ ok: false, error: 'Bot instance not found' });

    const Recording = require('../models/TradeRecording');
    const recording = await resolveRecording(instanceId, recordingId);
    if (!recording) return res.status(404).json({ ok: false, error: 'Recording not found' });
    if (recording.status !== 'READY' || !recording.filePath) {
      return res.status(409).json({ ok: false, error: 'Recording is not ready for deletion' });
    }

    const filePath = path.resolve(__dirname, '..', recording.filePath);
    const root = path.resolve(__dirname, '..', 'storage', 'recordings');
    if (!filePath.startsWith(root + path.sep)) {
      return res.status(400).json({ ok: false, error: 'Invalid recording path' });
    }

    try { fs.rmSync(filePath, { force: true }); } catch (err) {
      return next(err);
    }
    if (!recording.recoveredFromStorage) await Recording.deleteOne({ recordingId, instanceId });
    return res.json({ ok: true, recordingId });
  } catch (err) {
    return next(err);
  }
}

async function deleteAllRecordings(req, res, next) {
  try {
    const { instanceId } = req.params;
    const bot = await BotInstance.findOne({ instanceId, user: req.session.userId }).lean();
    if (!bot) return res.status(404).json({ ok: false, error: 'Bot instance not found' });

    // Do not delete files while a recording session is actively writing them.
    const active = recordingService.getActive(instanceId);
    if (active) {
      return res.status(409).json({ ok: false, error: 'Stop the active recording before deleting all recordings' });
    }

    const Recording = require('../models/TradeRecording');
    const fs = require('fs');
    const path = require('path');
    const projectRoot = path.resolve(__dirname, '..');
    const recordingsRoot = path.resolve(projectRoot, 'storage', 'recordings');
    const runtimeRoot = path.resolve(projectRoot, 'storage', 'recording-runtime');

    const recordings = await Recording.find({ instanceId }).lean();
    const deletedRecordingIds = recordings.map(r => r.recordingId);
    let filesDeleted = 0;

    // Delete every video and chunk directory belonging to this bot instance.
    for (const recording of recordings) {
      if (recording.filePath) {
        const filePath = path.resolve(projectRoot, recording.filePath);
        if (filePath.startsWith(recordingsRoot + path.sep) && fs.existsSync(filePath)) {
          try { fs.rmSync(filePath, { force: true }); filesDeleted += 1; } catch (err) { return next(err); }
        }
      }
      const prefix = `${recording.recordingId}`;
      if (fs.existsSync(recordingsRoot)) {
        for (const name of fs.readdirSync(recordingsRoot)) {
          if (name === prefix || name.startsWith(`${prefix}-`)) {
            const target = path.join(recordingsRoot, name);
            try { fs.rmSync(target, { recursive: true, force: true }); filesDeleted += 1; } catch (err) { return next(err); }
          }
        }
      }
    }

    // Also remove orphan recording folders whose name starts with this instanceId.
    // This catches frame/image directories left by an interrupted recording.
    if (fs.existsSync(recordingsRoot)) {
      const instancePrefix = `${instanceId}-`;
      for (const name of fs.readdirSync(recordingsRoot)) {
        if (name.startsWith(instancePrefix)) {
          const target = path.join(recordingsRoot, name);
          try { fs.rmSync(target, { recursive: true, force: true }); filesDeleted += 1; } catch (err) { return next(err); }
        }
      }
    }

    // recording-runtime is a temporary frame/runtime area. Clear it only when
    // there are no active recordings anywhere, so one bot cannot disrupt another.
    let runtimeCleared = false;
    if (recordingService.active.size === 0 && fs.existsSync(runtimeRoot)) {
      for (const name of fs.readdirSync(runtimeRoot)) {
        const target = path.join(runtimeRoot, name);
        try { fs.rmSync(target, { recursive: true, force: true }); runtimeCleared = true; filesDeleted += 1; } catch (err) { return next(err); }
      }
    }

    const result = await Recording.deleteMany({ instanceId });
    return res.json({
      ok: true,
      deletedRecordings: Number(result.deletedCount || 0),
      filesDeleted,
      runtimeCleared,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { startRecording, stopRecording, listRecordings, getRecording, renderRecordingPlayer, deleteRecording, deleteAllRecordings };
