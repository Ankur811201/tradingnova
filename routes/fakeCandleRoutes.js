'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/fakeCandleController');

const router = express.Router();
router.use(requireAuth);
router.post('/candle', controller.pushCandle);
router.post('/reset', controller.reset);

module.exports = router;
