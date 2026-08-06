'use strict';

const express = require('express');
const positionsController = require('../controllers/positionsController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.get('/', positionsController.listPositions);
router.get('/:id', positionsController.getPosition);

module.exports = router;
