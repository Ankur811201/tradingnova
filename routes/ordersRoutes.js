'use strict';

const express = require('express');
const ordersController = require('../controllers/ordersController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.get('/', ordersController.listOrders);
router.get('/:id', ordersController.getOrder);

module.exports = router;
