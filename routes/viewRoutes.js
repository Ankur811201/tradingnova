'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const botController = require('../controllers/botController');


const router = express.Router();

const PAGES = [
  { path: '/dashboard', view: 'dashboard', title: 'Dashboard', nav: 'dashboard' },
  { path: '/paper', view: 'paper', title: 'Paper Trading', nav: 'paper' },
  { path: '/live', view: 'live', title: 'Live Trading', nav: 'live' },
  { path: '/bots', view: 'bots', title: 'Bots', nav: 'bots' },
  { path: '/orders', view: 'orders', title: 'Orders', nav: 'orders' },
  { path: '/positions', view: 'positions', title: 'Positions', nav: 'positions' },
  { path: '/trades', view: 'trades', title: 'Trade History', nav: 'trades' },
  { path: '/system-status', view: 'system-status', title: 'System Status', nav: 'system-status' },
  { path: '/safety', view: 'safety', title: 'Safety & Settings', nav: 'safety' },
];

// Public login page. If already authenticated, go straight to the dashboard.
router.get('/login', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/dashboard');
  }
  return res.render('login', { title: 'Login', bodyClass: 'auth-page' });
});



router.get(
    '/bots/:instanceId',
    requireAuth,
    botController.renderBotDetail
);

// Root redirects based on auth state.
router.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/dashboard');
  }
  return res.redirect('/login');
});

PAGES.forEach(({ path, view, title, nav }) => {
  router.get(path, requireAuth, (req, res) => {
    res.render(view, { title, activeNav: nav, currentUser: res.locals.currentUser });
  });
});

module.exports = router;
