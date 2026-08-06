'use strict';

const express = require('express');
const botController = require('../controllers/botController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Only keep routes that have real controller functions
router.get('/detail/:instanceId', requireAuth, botController.renderBotDetail);

module.exports = router;