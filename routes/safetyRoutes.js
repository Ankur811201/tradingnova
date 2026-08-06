'use strict';

const express = require('express');
const safetyController = require('../controllers/safetyController');
const { requireAuth } = require('../middleware/auth');
const { dangerousActionLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
router.use(requireAuth);

router.get('/status', safetyController.getStatus);
router.post('/bots/:instanceId/stop', dangerousActionLimiter, safetyController.stopOneBot);
router.post('/bots/stop-all', dangerousActionLimiter, safetyController.stopAllBots);
router.post('/live-trading/disable', dangerousActionLimiter, safetyController.disableLiveTrading);
router.post('/live-trading/enable', dangerousActionLimiter, safetyController.enableLiveTrading);
router.post('/positions/:positionId/close', dangerousActionLimiter, safetyController.closeOnePosition);
router.post('/positions/close-all', dangerousActionLimiter, safetyController.closeAllPositions);

module.exports = router;
