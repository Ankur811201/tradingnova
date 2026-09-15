'use strict';

const express = require('express');
const recordingsController = require('../controllers/recordingsController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.post('/:instanceId/start', recordingsController.startRecording);
router.post('/:instanceId/stop', recordingsController.stopRecording);
router.get('/:instanceId', recordingsController.listRecordings);
router.delete('/:instanceId/all', recordingsController.deleteAllRecordings);
router.get('/:instanceId/:recordingId/video', recordingsController.getRecording);
router.delete('/:instanceId/:recordingId', recordingsController.deleteRecording);

module.exports = router;
