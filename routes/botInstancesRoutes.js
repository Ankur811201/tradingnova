'use strict';

const express = require('express');
const botInstancesController = require('../controllers/botInstancesController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.get('/', botInstancesController.listInstances);
router.get('/:instanceId', botInstancesController.getInstance);
router.get('/:instanceId/candles', botInstancesController.getCandles);
router.post('/', botInstancesController.createInstance);
router.post('/:instanceId/start', botInstancesController.startInstance);
router.post('/:instanceId/pause', botInstancesController.pauseInstance);
router.post('/:instanceId/stop', botInstancesController.stopInstance);
router.post('/:instanceId/restart', botInstancesController.restartInstance);
router.post('/:instanceId/config', botInstancesController.updateConfig);
router.delete('/:instanceId', botInstancesController.deleteInstance);

module.exports = router;
