'use strict';

const BotInstance = require('../models/BotInstance');
const recordingService = require('../services/recording/RecordingService');


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

    const Recording = require('../models/TradeRecording');
    const recording = await Recording.findOne({ recordingId, instanceId }).lean();
    if (!recording || recording.status !== 'READY' || !recording.filePath) {
      return res.status(404).json({ ok: false, error: 'Recording not found' });
    }

    return res.sendFile(require('path').resolve(__dirname, '..', recording.filePath));
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
    const recording = await Recording.findOne({ recordingId, instanceId });
    if (!recording) return res.status(404).json({ ok: false, error: 'Recording not found' });
    if (recording.status !== 'READY' || !recording.filePath) {
      return res.status(409).json({ ok: false, error: 'Recording is not ready for deletion' });
    }

    const filePath = require('path').resolve(__dirname, '..', recording.filePath);
    const root = require('path').resolve(__dirname, '..', 'storage', 'recordings');
    if (!filePath.startsWith(root + require('path').sep)) {
      return res.status(400).json({ ok: false, error: 'Invalid recording path' });
    }

    const fs = require('fs');
    try { fs.rmSync(filePath, { force: true }); } catch (err) {
      return next(err);
    }
    await recording.deleteOne();
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

module.exports = { startRecording, stopRecording, listRecordings, getRecording, deleteRecording, deleteAllRecordings };
