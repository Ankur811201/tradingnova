'use strict';

const express = require('express');
const logsController = require('../controllers/logsController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.get('/system', logsController.listSystemLogs);
router.get('/strategy-events', logsController.listStrategyEvents);
router.get('/risk-events', logsController.listRiskEvents);

module.exports = router;
