'use strict';

const express = require('express');
const botModelsController = require('../controllers/botModelsController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.get('/', botModelsController.listModels);
router.post('/rescan', botModelsController.rescanModels);

module.exports = router;
