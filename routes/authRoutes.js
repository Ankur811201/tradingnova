'use strict';

const express = require('express');
const authController = require('../controllers/authController');
const { loginLimiter } = require('../middleware/rateLimiters');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/register', authController.register);
router.post('/login', loginLimiter, authController.login);
router.post('/logout', requireAuth, authController.logout);
router.get('/me', authController.me);

module.exports = router;
