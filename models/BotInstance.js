'use strict';

const mongoose = require('mongoose');

const botInstanceSchema = new mongoose.Schema(
  {
    instanceId: { type: String, required: true, unique: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, },
    
    modelId: { type: String, required: true, index: true },
    modelVersion: { type: String, required: true },

    symbol: { type: String, required: true },
    environment: { type: String, enum: ['PAPER', 'LIVE'], required: true },

    status: { type: String, enum: ['RUNNING', 'PAUSED', 'STOPPED', 'ERROR'], required: true, default: 'STOPPED', index: true },
    lastError: { type: String, default: null },

    parameters: { type: mongoose.Schema.Types.Mixed, default: {} },

    capitalAllocation: { type: Number, required: true },
    leverage: { type: Number, required: true, default: 1 },
    riskSettings: {
      maxPositionSizeUsd: { type: Number, default: null },
      maxDailyLossUsd: { type: Number, default: null },
      stopLossRequired: { type: Boolean, default: false },
    },

    // NOVA TRADE -- PART 13.1 -- PHASE F: configVersion must represent
    // reality, not a schema convenience. A Mongoose `default` is applied to
    // ANY hydrated document (not just newly-created ones) whenever the
    // stored field is missing/undefined -- so a pre-Part-13 document that
    // never persisted configVersion would silently read back as 2 the
    // moment it's loaded through a normal (non-.lean()) query, falsely
    // claiming it was migrated when it never was. There is no `default`
    // here on purpose: BotManager.createInstance explicitly writes
    // configVersion: 2 for every NEW instance (see createInstance below),
    // so new bots are unaffected. An old bot's configVersion now correctly
    // reads back as `undefined` (== "never migrated") both via `.lean()`
    // and via a full Mongoose document. Nothing reads/branches on this
    // field today, so this is a pure data-integrity fix with zero runtime
    // behavior change -- but it stops the field from lying to any future
    // code (or admin/report) that does read it.
    configVersion: { type: Number },

    // Sizing Mode foundation (PHASE H/I). mode: 'CAPITAL' (default, legacy
    // behavior — quantity comes from the strategy's own dynamic lot table,
    // capitalAllocation acts only as a RiskEngine notional ceiling, exactly
    // as before Part 13) or 'LOT' (user supplies an explicit contract/
    // quantity value that overrides the dynamic table, still subject to
    // every RiskEngine check). value is only meaningful in LOT mode.
    sizing: {
      mode: { type: String, enum: ['CAPITAL', 'LOT'], default: 'CAPITAL' },
      value: { type: Number, default: null },
    },

    // Canonical Top/Bottom Level (PHASE D — replaces the old "layer"
    // wording and the old parameters.topLevel/parameters.bottomLevel
    // location for NEW writes). Model001.onStart still honors legacy
    // parameters.topLevel/bottomLevel when these are unset, for backward
    // compatibility with bots created before Part 13.
    levels: {
      top: { type: Number, default: null },
      bottom: { type: Number, default: null },
    },

    // Target Levels foundation (PHASE F). Ordered, de-duplicated, finite
    // positive prices. Multi-target partial-exit execution is NOT
    // implemented in Part 13 (see PHASE S) — this persists/validates/
    // displays intended exit levels and feeds the single primary target
    // through to the existing takeProfit pipeline.
    targets: {
      type: [{ price: { type: Number, required: true }, _id: false }],
      default: [],
    },

    startedAt: { type: Date, default: null },
    stoppedAt: { type: Date, default: null },
    lastSignalAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BotInstance', botInstanceSchema);
