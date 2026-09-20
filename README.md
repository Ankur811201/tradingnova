# Nova Trade — MODEL_002 Current Build

This README documents the **current active trading workflow** in this build.
MODEL_001 is obsolete and is not part of this project. Do not use old MODEL_001 documentation to describe current trading behavior.

## 1. Active model

The only active strategy model is **MODEL_002**.

MODEL_002 is user-driven and rule-based:

- Trend is supplied by the user: `BULLISH` or `BEARISH`.
- Exactly 3 Support levels: `S1`, `S2`, `S3`.
- Exactly 3 Resistance levels: `R1`, `R2`, `R3`.
- Execution timeframe: `1m` or `3m`.
- No EMA trend detection.
- No Daily BOS.
- No 1H confirmation.
- No automatic trend detection.

## 2. MODEL_002 entry workflow

The active NEW A/B/C pattern engine is used for all four combinations:

| User trend | Level | Direction |
|---|---|---|
| BULLISH | Support | BUY |
| BEARISH | Support | BUY |
| BULLISH | Resistance | SELL |
| BEARISH | Resistance | SELL |

### Candle A / Candle B

- Candle A is the candle immediately before the level-touch candle.
- Candle B is the candle that touches the configured Support/Resistance level.
- A/B validation uses the candle body.
- Candle B must have the required body progression and correct candle nature.
- Once B validates, fixed boundaries are created:
  - `upper = B.high + 5`
  - `lower = B.low - 5`
- Boundaries do not move.

### Trigger

The running price/tick stream can trigger the trade without waiting for candle close:

- BUY: price reaches `upper`.
- SELL: price reaches `lower`.
- The opposite boundary invalidates the pattern.
- If neither boundary is touched, the pattern remains waiting across later candles.
- If both boundaries occur in one candle, live tick order is used; the code does not guess when order cannot be established.

The first S1 setup for the applicable opposite-side calibration and the first R1 setup for the applicable opposite-side calibration are calibration-only and deliberately do not open a trade.

## 3. Entry sizing

After a valid trigger, MODEL_002 calculates its stop-loss and risk length, maps risk length to a lot count, then converts lots to BTC.

- Maximum accepted risk length: 360 points.
- Lot mapping is implemented in `sameSidePatternEngine.js`.
- `1 lot = 0.001 BTC`.
- Leverage is validated from `1x` through `200x`.
- MODEL_002 does not invent a take-profit formula. Entry commands use `takeProfit: null` and `autoTargets: false`.

The generic RiskEngine still performs platform safety checks before execution.

## 4. PAPER / LIVE execution

```text
MODEL_002
  ↓
TradeCommand
  ↓
RiskEngine
  ↓
ExecutionRouter
  ├── PAPER → PaperEngine
  └── LIVE  → LiveEngine / Delta
```

A bot does not open another MODEL_002 position while its existing position is open.

## 5. Trade-result accounting — current rule

A trade is one **complete position lifecycle**, not each target exit.

### T1/T2/T3

T1, T2 and T3 are partial exits only. They do **not** count as a success or a loss. They do not advance any safety counter.

### T4

T4 closes the remaining position immediately. The resulting final Trade is a **SUCCESS**.

The bot is then stopped permanently for that run because: `MAX_SUCCESSFUL_TRADES_PER_BOT = 1`.

### Stop-loss

When the stored position stop-loss is touched, the remaining position is closed with reason `STOP_LOSS`. The final Trade is a **LOSS**.

A loss increments the counter of the Support/Resistance level that originally created the position.

A final break-even close (`realizedPnl === 0`) changes neither success nor loss counters.

## 6. Level-based loss safety

The old global Layer 1 / Layer 2 / Layer 3 counter is no longer used. Safety is now tied directly to the six configured levels:

```text
S1 = 0 / 2
S2 = 0 / 2
S3 = 0 / 2
R1 = 0 / 2
R2 = 0 / 2
R3 = 0 / 2
```

The level that creates the entry is permanently stored on the Position/Trade as `entryLevelKey`. Later T1/T2/T3/T4/SL events do not change that attribution.

Before opening a new trade:

```text
entry level loss count < 2 → allowed
entry level loss count >= 2 → blocked
```

Blocking S1 does not block S2, S3, R1, R2 or R3.

Example:

```text
S1 → SL → S1 = 1
S1 → SL → S1 = 2 → S1 blocked
S2 → SL → S2 = 1 → S2 still available
R1 → T4 → SUCCESS → bot stops
```

## 7. One-success rule

The bot may have many losing completed trades while eligible levels remain, but it may have only **one successful completed trade**.

```text
T1/T2/T3 → no success count
T4        → SUCCESS +1 → BOT STOPPED
STOP_LOSS → LOSS +1 on the trade's entry level
```

There is no second success after `SUCCESS_STOPPED`.

## 8. Restart recovery

MODEL_002 safety state is reconstructed from the bot's authoritative completed Trade history, ordered by `closedAt`. Each Trade carries `entryLevelKey`.

Current MODEL_002 trades therefore recover their S1/S2/S3/R1/R2/R3 loss counters and the one-success stop after restart. Old trades created before `entryLevelKey` was introduced cannot be safely attributed to a specific level and are not assigned to a level during migration.

## 9. Target Exit

Target Exit supports T1–T4. T1–T3 use independent 3-candle confirmation flows:

- A raw tick detects a new target touch.
- The target's touch candle is CT1 when that canonical candle closes.
- The next canonical candle close is CT2.
- The following canonical candle close is CT3, then that target's configured percentage is exited.
- T1, T2 and T3 may be confirming independently at the same time.
- T4 remains immediate on a new crossing.
- Target Exit never builds a second candle stream; it consumes the same canonical closed candles used by the bot.

## 10. Source-of-truth files

```text
bot-models/model-002/
├── Model002.js
├── config.js
├── validators.js
├── reversalPatternEngine.js
├── sameSidePatternEngine.js
├── layerSafety.js
└── index.js

services/TargetExitManager.js
services/execution/ExecutionRouter.js
services/paperEngine/PaperEngine.js
services/liveEngine/LiveEngine.js
services/botManager/BotManager.js
models/Position.js
models/Trade.js
```

## 11. Safety accounting invariant

There must be exactly one final safety outcome for one completed position lifecycle:

```text
ENTRY
  ├─ T1 → no counter
  ├─ T2 → no counter
  ├─ T3 → no counter
  ├─ T4 → SUCCESS → stop bot
  └─ STOP_LOSS → LOSS → increment entry level
```

Partial target exits are execution events, not separate trades.


### Target Exit chart markers
The Bot Detail chart displays canonical Target Exit events as CT1, CT2, CT3 and Tn EXIT markers. CT1 is the target-touch candle close; CT2 is the next candle close; CT3 is the following candle close, at which T1/T2/T3 partial exit executes.
