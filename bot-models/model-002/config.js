'use strict';

/**
 * MODEL_002 configuration constants — CURRENT CONFIRMED REQUIREMENTS ONLY.
 *
 * This replaces the earlier Daily-BOS/1H-confirmation design. Per the
 * client's current confirmed requirements:
 *   - No Daily BOS, no 1H confirmation, no EMA trend, no automatic trend
 *     detection of any kind. Trend is user-provided (BULLISH/BEARISH).
 *   - Support/resistance are user-provided (up to 3 each), never
 *     auto-detected.
 *   - Execution timeframe is user-selectable: 1m or 3m only.
 *
 * requiredTimeframes is deliberately EMPTY — MODEL_002 no longer declares
 * any higher-timeframe dependency (Part A multi-timeframe infrastructure
 * itself is untouched and still available for other/future models; this
 * model simply no longer uses it).
 */

const SUPPORTED_TIMEFRAMES = ['1m', '3m'];
const DEFAULT_TIMEFRAME = '1m';
const DEFAULT_HISTORY_SIZE = 20; // small buffer: the active pattern only ever needs the last 2-3 closed candles

// No higher-timeframe dependency — see comment above.
const REQUIRED_TIMEFRAMES = [];

const CONSECUTIVE_LOSS_LIMIT = 3; // confirmed requirement §11

// PHASE 2 — layer/success safety (confirmed requirements). A separate,
// independent mechanism from CONSECUTIVE_LOSS_LIMIT above: that rule
// pauses the bot after N consecutive losses regardless of layer; this one
// tracks a layer/loss-count/success state machine per bot. Both can be
// active at once — see bot-models/model-002/layerSafety.js.
const MAX_LAYERS = 6;
const MAX_LOSSES_PER_LAYER = 2;
const MAX_SUCCESSFUL_TRADES_PER_BOT = 1;

/**
 * Default parameters, instance-configurable (user supplies trend/levels/
 * timeframe when creating the bot — see routes/controllers for how
 * defaultParameters surfaces in the Bot Management UI's dynamic form).
 * capitalAllocation and leverage are NOT here — they are already generic
 * BotInstance fields (Maximum Capital = capitalAllocation, Leverage =
 * leverage), reused as-is per the confirmed requirements, not duplicated.
 */
const DEFAULT_PARAMETERS = {
  timeframe: DEFAULT_TIMEFRAME,
  historySize: DEFAULT_HISTORY_SIZE,

  // USER-PROVIDED directional context — never calculated (confirmed §5).
  trend: null, // 'BULLISH' | 'BEARISH' — required at onStart, no default value is ever guessed

  // USER-PROVIDED levels — never calculated (confirmed §3). Up to 3 each,
  // in the user's given order (index 0 = first/primary level).
  support: [],
  resistance: [],

  // Touch-zone tolerance for detecting whether a candle reached a configured level.
  touchTolerancePct: 0.001,

  // Preserved from the prior implementation (confirmed §13: "preserve the
  // existing implementation temporarily... make it easy to replace the SL
  // rule later"). SL is computed off the touched user level itself instead
  // of an auto-detected swing — same formula shape, different level source.
  slBufferPct: 0.001,
  slMinDistancePct: 0.002,
  slMaxDistancePct: 0.05,

  // Preserved risk/sizing formula (confirmed §13).
  riskPercent: 0.01,
  quantityDecimalPrecision: 3,

  // Preserved TP formula (confirmed §13 — RR source itself is pending per §19C, but the RR *mechanism* already exists and is preserved).
  riskRewardRatio: 2,

  // Confirmed §11.
  consecutiveLossLimit: CONSECUTIVE_LOSS_LIMIT,
};

module.exports = {
  SUPPORTED_TIMEFRAMES,
  DEFAULT_TIMEFRAME,
  DEFAULT_HISTORY_SIZE,
  REQUIRED_TIMEFRAMES,
  CONSECUTIVE_LOSS_LIMIT,
  MAX_LAYERS,
  MAX_LOSSES_PER_LAYER,
  MAX_SUCCESSFUL_TRADES_PER_BOT,
  DEFAULT_PARAMETERS,
};
