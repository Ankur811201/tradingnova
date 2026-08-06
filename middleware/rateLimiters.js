'use strict';

const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

const loginLimiter = rateLimit({
  windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
  max: env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again later.', data: null, error: 'RATE_LIMITED' },
});

const dangerousActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.', data: null, error: 'RATE_LIMITED' },
});

const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests.', data: null, error: 'RATE_LIMITED' },
});

module.exports = { loginLimiter, dangerousActionLimiter, generalApiLimiter };
