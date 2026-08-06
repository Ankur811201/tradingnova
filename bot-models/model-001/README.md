# Model 001

## What it is

Model 001 is Nova Trade's first pluggable trading strategy: a **rule-based**
candle-pattern model. It plugs into the existing Bot Model contract
(`bot-models/BotModelBase.js`) exactly like any future model would.

## What it is NOT

- It is **not** an AI/ML prediction model. There is no training, no model
  weights, no probability output. "Score" fields are **rule match scores**
  (fraction of a rule's sub-conditions that matched) — never a prediction of
  profit or an AI confidence value.
- **`DEFAULT_RULESET_V1` is an illustrative example only.** It exists to
  prove the Model 001 infrastructure works end-to-end (candle aggregation →
  pattern evaluation → TradeCommand → RiskEngine → execution). **It is not
  the client's final strategy**, has not been backtested, and no win rate or
  profitability claim is made or implied anywhere in this codebase.
- It is not a backtesting platform. `patternEngine.js` is written as a pure,
  deterministic function specifically so it *can* be reused for backtesting
  or strategy playback later, but no backtest runner ships in Part 3.

## Architecture

```
bot-models/model-001/
├── index.js            Registration entry point (modelId, metadata, create())
├── Model001.js          Orchestrator: implements the BotModelBase contract
├── config.js             DEFAULT_PARAMETERS, supported timeframes/rulesets
├── validators.js          validateCandle(), validateAndMergeParameters()
├── indicators.js           Pure candle-analysis utilities (body, wicks, swing high/low, ...)
├── candleAggregator.js      Deterministic price-tick -> OHLCV candle builder
├── patternEngine.js          Pure, deterministic rule evaluator (DEFAULT_RULESET_V1 lives here)
└── README.md                 This file
```

Every file except `Model001.js` and `index.js` is a **pure function module**:
no I/O, no MongoDB, no randomness, no wall-clock reads. `Model001.js` is the
only file that touches the Bot Model contract (`emit`/`submitTradeCommand`).

## How market data reaches Model 001 (and why candles are built in-model)

`BotManager.dispatchMarketData()` currently forwards **price ticks**
(`{ type: 'price', symbol, data: { price }, timestamp }`) from the approved
`MarketDataProvider` — this is unchanged Part 1 infrastructure. Rather than
modify Part 1's dispatch pipeline to add a new "candle" update type, Model 001
aggregates price ticks into OHLCV candles **itself**, in `candleAggregator.js`,
using the Bot Instance's configured `timeframe`. This was the smallest
possible integration: **zero changes to `BotManager`, `server.js`'s market
data wiring, or `MarketDataProvider`** were required.

`Model001.onMarketData()` also accepts a `{ type: 'candle', data: <candle> }`
update shape and uses it directly if BotManager ever dispatches pre-built
candles in the future — no change to Model 001 would be needed then either.

**Known limitation:** because candles are built live from incoming ticks,
there is no historical backfill. A freshly started (or restarted) instance
needs to accumulate `breakoutLookback + 1` closed candles before it can
generate its first signal ("warm-up period"). This is deliberate: Model 001
never guesses or fabricates historical candles.

**Known limitation:** the price-tick stream carries no volume, so aggregated
candles always have `volume: null`. `volumeConfirmationEnabled` is fully
implemented and tested but has no effect until a future `MarketDataProvider`
revision supplies volume-bearing data — `indicators.volumeAboveAverage()`
correctly returns `null` (not a false pass) when volume is unavailable, and
the rule treats that as "cannot confirm" rather than silently trading anyway.

## Parameters (Bot Instance `parameters`)

All configured via the existing `BotInstance.parameters` field — no new
database field was added. Defaults live in `config.js` and are returned by
`GET /api/bot-models` so the frontend can build a form dynamically.

| Parameter | Default | Meaning |
|---|---|---|
| `timeframe` | `'5m'` | Candle timeframe. One of `1m,3m,5m,15m,30m,1h`. |
| `historySize` | `100` | Max closed candles kept in memory (10-500). |
| `breakoutLookback` | `20` | Prior-candle window used for recent high/low. |
| `minimumBodyRatio` | `0.5` | Min body/range ratio (0-1) for a confirmation candle. |
| `volumeConfirmationEnabled` | `false` | See "known limitation" above. |
| `volumeMultiplier` | `1.5` | Required multiple of average volume when enabled. |
| `exitOnOpposingSignal` | `true` | Example v1 exit rule — close on an opposing signal. |
| `stopLossPercent` | `1.0` | % from reference price. `0` disables. |
| `takeProfitPercent` | `2.0` | % from reference price. `0` disables. |
| `pyramiding` | `false` | If false, never opens a second same-direction position. |
| `ruleSet` | `'DEFAULT_RULESET_V1'` | Which PatternEngine rule set to run. |
| `quantityMode` | `'CAPITAL_PERCENT'` | Sizing method. Only one mode ships in Part 3. |
| `capitalUsagePercent` | `0.5` | Fraction (0-1] of `capitalAllocation` used as notional per trade. |

Invalid parameters cause `onStart()` to throw a descriptive error, so the Bot
Instance fails to start rather than run in an unsafe configuration — this
error surfaces directly through the existing `POST /api/bot-instances/:id/start`
API response.

## DEFAULT_RULESET_V1 — exact rules

**LONG** (all must hold):
1. Current closed candle is bullish (`close > open`).
2. `bodyRatio >= minimumBodyRatio`.
3. `close` breaks above the highest high of the prior `breakoutLookback` candles.
4. Volume confirmation (if enabled — currently always passes as "not required" since no volume data exists yet).

**SHORT** — the mirror image (bearish, body ratio, breaks below the lowest low).

**CLOSE** (exit, only when `exitOnOpposingSignal` is true and a position is open):
- Long position + SHORT conditions all match → `CLOSE`.
- Short position + LONG conditions all match → `CLOSE`.

**Position-aware behavior:**
- No open position → LONG/SHORT may fire per the rules above.
- Open position, same direction, `pyramiding=false` (default) → `NO_ACTION` (`pyramiding_disabled_*`).
- Open position, opposite direction, exit rule didn't fire → `NO_ACTION` (`opposing_*_position_open`), never stacks conflicting positions.

Everything else → `NO_ACTION` (`no_rule_matched` or `insufficient_history`).

## TradeCommand contract used

Exactly the existing shape validated by `bot-models/TradeCommandSchema.js` —
no competing format was introduced:

```js
{
  commandId, instanceId, symbol, environment, action,
  quantity, stopLoss, takeProfit, timestamp, reason, metadata,
  // modelId/modelVersion/timestamp are added automatically by BotModelBase.submitTradeCommand()
}
```

**`commandId` format** (deterministic, per spec):
```
MODEL001:{instanceId}:{closedCandleTimestamp}:{action}:{ruleId}
```
Same candle + same action + same rule ⇒ same `commandId`, every time — this
is the model-level half of duplicate-signal protection. The existing
`RiskEngine` duplicate-commandId check (`utils/duplicateSignalDetector.js`,
`RISK_DUPLICATE_SIGNAL_WINDOW_MS`) remains the authoritative second layer and
was **not weakened or bypassed**.

**Quantity/sizing:** `quantity = floor((capitalAllocation * capitalUsagePercent) / candle.close * 1e6) / 1e6`.
Deterministic, never derived from a guessed account balance. If sizing can't
be computed safely (bad price, non-positive notional), Model 001 emits
`SIGNAL_REJECTED` and submits nothing.

## Flow (unchanged Part 1 core)

```
MarketDataProvider price tick
        |
BotManager.dispatchMarketData()  (unchanged)
        |
Model001.onMarketData()            <- candle aggregation + PatternEngine happen here
        |  (only on LONG/SHORT/CLOSE, never NO_ACTION)
this.submitTradeCommand(command)
        |
BotManager._handleTradeCommand()  (unchanged) -> schema validation
        |
RiskEngine.evaluate()               (unchanged) -> approve/reject
        |
ExecutionRouter.route()               (unchanged) -> strict PAPER/LIVE split
        |
PaperEngine.openPosition/closePosition   OR   LiveEngine.openPosition/closePosition
```

Model 001 never imports `DeltaAdapter`, `PaperEngine`, `LiveEngine`, or
`ExecutionRouter`, and never touches Mongoose models directly — verified by
`tests/model001.boundaries.test.js` (a static source scan).

## Strategy events emitted

`MODEL_STARTED`, `MODEL_PAUSED`, `MODEL_STOPPED`, `CANDLE_PROCESSED` (once per
closed candle), `RULE_MATCHED` (only when a rule actually matches),
`SIGNAL_GENERATED`, `SIGNAL_REJECTED`. Plain `NO_ACTION` candles are **not**
logged to `StrategyEvent` to avoid flooding MongoDB — the spec explicitly
calls this out, and most candles resolve to `NO_ACTION`.

## Lifecycle

- **START**: validates parameters (throws on invalid config), resets all
  in-memory state, emits `MODEL_STARTED`.
- **PAUSE**: sets an internal flag; `onMarketData` becomes a no-op immediately
  (no new signals), matching the spec exactly.
- **STOP**: same no-op flag, plus frees candle buffer/aggregator. BotManager
  also removes the instance from its live-instance map independently.
- **RESTART**: `BotManager.restartInstance()` stops then starts, which
  constructs a **brand-new** `Model001` instance via `create()` — state is
  never carried over, so a restarted instance cannot resubmit stale
  commands for candles it processed before restarting. It does re-enter the
  warm-up period (see "known limitation" above).
- **ERROR**: any exception thrown out of `onMarketData`/`onStart` is caught by
  `BotManager.dispatchMarketData`/`startInstance` (unchanged Part 1 behavior)
  and surfaces as instance `status: 'ERROR'` — one failing bot instance
  cannot crash the server. Expected failure modes (malformed candle, unknown
  ruleset, sizing failure) are handled internally as graceful no-ops/events
  instead of thrown exceptions.

## Safety

Market data staleness/disconnection is handled by two independent layers, as
required:
1. **Passive, at the model:** if the `MarketDataProvider` stops producing
   updates (disconnected or stale), `BotManager` simply stops calling
   `onMarketData` — no ticks means no candles close, means no signals.
2. **Active, at RiskEngine:** every submitted command is independently
   re-checked for market data freshness by `RiskEngine.evaluate()` before
   approval — unchanged Part 1 behavior, not bypassed.

## Replacing DEFAULT_RULESET_V1 with the real client strategy later

1. Add a new pure function in `patternEngine.js` (or a new file re-exported
   from there) with the same signature as `evaluateDefaultRulesetV1({ candles, params, positionContext })`.
2. Register it in `RULESET_EVALUATORS` under a new name, e.g. `'CLIENT_STRATEGY_V1'`.
3. Add any new needed parameters to `DEFAULT_PARAMETERS`/`validators.js`.
4. Set the Bot Instance's `ruleSet` parameter to the new name.

**Nothing in `Model001.js`, `BotManager`, `RiskEngine`, `ExecutionRouter`, or
the frontend needs to change** — parameters flow through the existing
generic `BotInstance.parameters` field and `GET /api/bot-models`
`defaultParameters` end to end.

## Running Model 001 in PAPER mode

1. Configure a real `MARKET_DATA_PROVIDER` (Model 001 will not receive any
   ticks with `MARKET_DATA_PROVIDER=none` — this is expected, not a bug).
2. Log in, go to **Bots**, confirm "Model 001" appears (auto-discovered).
3. Create a Bot Instance: pick Model 001, a symbol from your configured
   `RISK_ALLOWED_SYMBOLS`, environment `PAPER`, a `capitalAllocation`, and
   optionally override parameters (timeframe, stop loss/take profit %, etc.)
   in the dynamic parameters form.
4. Start the instance. Watch **System Status** / bot events for
   `MODEL_STARTED` → `CANDLE_PROCESSED` (repeating) → eventually
   `RULE_MATCHED`/`SIGNAL_GENERATED` once enough candles accumulate and a
   rule matches.
5. Check **Paper Trading** / **Positions** / **Orders** to confirm the
   resulting paper position, and **Safety & Settings** to pause/stop it.

See the root `README.md` "Paper-mode validation actually performed" section
for what was and wasn't executed in this build's sandbox.
