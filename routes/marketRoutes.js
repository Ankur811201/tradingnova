'use strict';

const express = require('express');
const marketController = require('../controllers/marketController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);
router.get('/status', marketController.getStatus);
// NEXT CANDLE TIMING: lightweight server clock (no DB / no external call).
router.get('/time', marketController.getServerTime);
router.get('/price/:symbol', marketController.getPrice);
router.get('/candles/:symbol', marketController.getCandles);
router.get('/fresh/:symbol', marketController.getFreshness);

module.exports = router;
