'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const session = require('express-session');
const MongoStore = require('connect-mongo');

const { env } = require('./config/env');
const { attachCurrentUser } = require('./middleware/auth');
const { generalApiLimiter } = require('./middleware/rateLimiters');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/authRoutes');
const marketRoutes = require('./routes/marketRoutes');
const paperRoutes = require('./routes/paperRoutes');
const liveRoutes = require('./routes/liveRoutes');
const ordersRoutes = require('./routes/ordersRoutes');
const positionsRoutes = require('./routes/positionsRoutes');
const tradesRoutes = require('./routes/tradesRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const botModelsRoutes = require('./routes/botModelsRoutes');
const botInstancesRoutes = require('./routes/botInstancesRoutes');
const logsRoutes = require('./routes/logsRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const safetyRoutes = require('./routes/safetyRoutes');
const healthRoutes = require('./routes/healthRoutes');
const viewRoutes = require('./routes/viewRoutes');
const botRoutes = require('./routes/botRoutes')

/**
 * CORS origin resolver. If CORS_ALLOWED_ORIGIN is set (comma-separated), only
 * those exact origins are allowed — required for production per security
 * review (never an unrestricted wildcard). If unset, reflects the request's
 * own origin (safe with credentialed requests since browsers already require
 * an exact origin match with credentials; this preserves the previous
 * same-origin/dev-friendly default) — set CORS_ALLOWED_ORIGIN explicitly in
 * production for a real allowlist.
 */
function buildCorsOrigin() {
  if (!env.CORS_ALLOWED_ORIGIN) return true; // reflect request origin (dev default)
  const allowed = env.CORS_ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  return (origin, callback) => {
    if (!origin || allowed.includes(origin)) return callback(null, true);
    return callback(new Error(`Origin ${origin} is not allowed by CORS_ALLOWED_ORIGIN`));
  };
}

function buildSessionMiddleware() {
  return session({
    name: 'connect.sid',
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: env.MONGODB_URI, collectionName: 'sessions' }),
    cookie: {
      httpOnly: true,
      secure: env.IS_PRODUCTION, // requires HTTPS in production
      sameSite: 'lax',
      maxAge: env.SESSION_COOKIE_MAX_AGE_MS,
    },
  });
}

function createApp() {
  const app = express();
  const sessionMiddleware = buildSessionMiddleware();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: false, // Part 2 (frontend) will configure CSP appropriately
  }));
  app.use(cors({ origin: buildCorsOrigin(), credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(sessionMiddleware);
  app.use(attachCurrentUser);
  app.use('/api', generalApiLimiter);

  app.use(express.static(path.join(__dirname, 'public')));

  // --- API routes ---
  app.use('/api/auth', authRoutes);
  app.use('/api/market', marketRoutes);
  app.use('/api/paper', paperRoutes);
  app.use('/api/live', liveRoutes);
  app.use('/api/orders', ordersRoutes);
  app.use('/api/positions', positionsRoutes);
  app.use('/api/trades', tradesRoutes);
  app.use('/api/portfolio', portfolioRoutes);
  app.use('/api/bot-models', botModelsRoutes);
  app.use('/api/bot-instances', botInstancesRoutes);
  app.use('/api/logs', logsRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/safety', safetyRoutes);
  app.use('/api/health', healthRoutes);

  // --- Frontend page routes (Part 2) ---
  
  const viewRoutes = require('./routes/viewRoutes');
const botRoutes = require('./routes/botRoutes');

/* HTML Pages */
app.use('/', viewRoutes);

/* Bot APIs */
app.use('/api/bots', botRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, sessionMiddleware };
}

module.exports = { createApp };
