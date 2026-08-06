'use strict';

const express = require('express');
const tradesController = require('../controllers/tradesController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.get('/', tradesController.listTrades);

module.exports = router;
