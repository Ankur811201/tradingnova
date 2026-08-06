'use strict';

const logger = require('../utils/logger');

function notFoundHandler(req, res, next) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'Not found', data: null, error: 'NOT_FOUND' });
  }
  return next();
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const message = err.message || 'Internal server error';

  if (status >= 500) {
    logger.error('SYSTEM', `Unhandled error on ${req.method} ${req.originalUrl}: ${message}`, {
      stack: err.stack,
    });
  }

  if (req.path.startsWith('/api/')) {
    return res.status(status).json({
      success: false,
      message,
      data: null,
      error: err.code || message,
    });
  }

  return res.status(status).send(`Error: ${message}`);
}

module.exports = { notFoundHandler, errorHandler };
