'use strict';

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, message: 'Authentication required', data: null, error: 'UNAUTHENTICATED' });
  }
  return res.redirect('/login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.userRole) {
      return res.status(401).json({ success: false, message: 'Authentication required', data: null, error: 'UNAUTHENTICATED' });
    }
    if (!roles.includes(req.session.userRole)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions', data: null, error: 'FORBIDDEN' });
    }
    return next();
  };
}

function attachCurrentUser(req, res, next) {
  res.locals.currentUser = req.session && req.session.userId
    ? { id: req.session.userId, username: req.session.username, role: req.session.userRole }
    : null;
  next();
}

module.exports = { requireAuth, requireRole, attachCurrentUser };
