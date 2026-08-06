'use strict';

const express = require('express');
const settingsController = require('../controllers/settingsController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.get('/', settingsController.getSettings);

module.exports = router;
