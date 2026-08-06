'use strict';

const User = require('../models/User');
const paperEngine = require('../services/paperEngine/PaperEngine');
const { env } = require('../config/env');
const { success, failure, AppError } = require('../utils/apiResponse');
const logger = require('../utils/logger');

async function register(req, res, next) {
  try {
    if (!env.ALLOW_REGISTRATION) {
      throw new AppError('Registration is currently disabled by server configuration', 403, 'REGISTRATION_DISABLED');
    }
    const { username, password, role } = req.body;
    if (!username || !password) throw new AppError('username and password are required', 400);
    if (password.length < 8) throw new AppError('password must be at least 8 characters', 400);

    const existing = await User.findOne({ username: username.trim().toLowerCase() });
    if (existing) throw new AppError('username already taken', 409);

    const user = new User({ username: username.trim().toLowerCase(), role: role === 'trader' ? 'trader' : 'admin' });
    await user.setPassword(password);
    await user.save();

    // Every new user automatically gets a paper account initialized once with the starting balance.
    await paperEngine.ensureAccount(user._id);

    await logger.info('AUTH', `New user registered: ${user.username}`);
    return success(res, user.toSafeJSON(), 'User registered', 201);
  } catch (err) {
    return next(err);
  }
}

async function login(req, res, next) {
  try {
    const { username, password } = req.body;
    if (!username || !password) throw new AppError('username and password are required', 400);

    const user = await User.findOne({ username: username.trim().toLowerCase() });
    if (!user || !user.isActive) {
      await logger.warn('AUTH', `Failed login attempt for username "${username}"`);
      throw new AppError('Invalid credentials', 401);
    }
    const valid = await user.verifyPassword(password);
    if (!valid) {
      await logger.warn('AUTH', `Failed login attempt for username "${username}"`);
      throw new AppError('Invalid credentials', 401);
    }

    req.session.userId = user._id.toString();
    req.session.username = user.username;
    req.session.userRole = user.role;

    user.lastLoginAt = new Date();
    await user.save();

    await paperEngine.ensureAccount(user._id);

    await logger.info('AUTH', `User logged in: ${user.username}`);
    return success(res, user.toSafeJSON(), 'Logged in');
  } catch (err) {
    return next(err);
  }
}

async function logout(req, res, next) {
  try {
    const username = req.session.username;
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('connect.sid');
      logger.info('AUTH', `User logged out: ${username}`);
      return success(res, null, 'Logged out');
    });
  } catch (err) {
    return next(err);
  }
}

async function me(req, res, next) {
  try {
    if (!req.session || !req.session.userId) {
      return failure(res, 'Not authenticated', 401, 'UNAUTHENTICATED');
    }
    const user = await User.findById(req.session.userId);
    if (!user) return failure(res, 'User not found', 404);
    return success(res, user.toSafeJSON());
  } catch (err) {
    return next(err);
  }
}

module.exports = { register, login, logout, me };
