'use strict';

const express = require('express');
const portfolioController = require('../controllers/portfolioController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.get('/paper', portfolioController.getPaperPortfolio);
router.get('/live', portfolioController.getLivePortfolio);

module.exports = router;
