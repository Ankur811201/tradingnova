'use strict';

const express = require('express');
const liveController = require('../controllers/liveController');
const { requireAuth } = require('../middleware/auth');
const { dangerousActionLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

router.use(requireAuth);
router.get('/status', liveController.getStatus);
router.get('/balance', liveController.getBalance);
router.get('/orders', liveController.getOpenOrders);
router.post('/orders/cancel', dangerousActionLimiter, liveController.cancelOrder);
router.post('/positions', dangerousActionLimiter, liveController.openPosition);
router.post('/positions/:positionId/close', dangerousActionLimiter, liveController.closePosition);
router.post('/positions/sync', liveController.syncPositions);

module.exports = router;
