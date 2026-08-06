'use strict';

const express = require('express');
const paperController = require('../controllers/paperController');
const { requireAuth } = require('../middleware/auth');
const { dangerousActionLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

router.use(requireAuth);
router.get('/account', paperController.getAccount);
router.post('/account/add-funds', dangerousActionLimiter, paperController.addFunds);
router.post('/positions', paperController.openPosition);
router.post('/positions/:positionId/close', paperController.closePosition);

module.exports = router;
