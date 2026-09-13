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

module.exports = { startRecording, stopRecording, listRecordings, getRecording, deleteRecording };
