'use strict';

function success(res, data = null, message = 'OK', status = 200) {
  return res.status(status).json({ success: true, message, data, error: null });
}

function failure(res, message = 'Error', status = 400, error = null) {
  return res.status(status).json({ success: false, message, data: null, error: error || message });
}

class AppError extends Error {
  constructor(message, status = 400, code = 'APP_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { success, failure, AppError };
