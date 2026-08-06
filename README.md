# Nova Trade — Part 1: Backend, Part 2: EJS Frontend, Part 3: Model 001, Part 4: Real Market Data / Delta Integration & Stabilization

Private automated algorithmic trading platform. **Part 1** (backend/core),
**Part 2** (EJS frontend), **Part 3** (Model 001), and **Part 4** (real Delta
market data integration, symbol/timeframe mapping, System Status accuracy,
security hardening, and end-to-end stabilization) are all included below.

## Part 4 — Audit findings, fixes, and real Delta integration

### The reported problem (confirmed by audit)

Exactly as described: `MARKET_DATA_PROVIDER=generic_rest` was pointed at
Delta Exchange, but `RestPollingProvider` only understands generic
`GET /price?symbol=` / `GET /candles?symbol=&resolution=` shapes — Delta's
real API uses different paths and a different response envelope entirely, so
the provider stayed `DISCONNECTED` / `STALE` and `RiskEngine` correctly
blocked all automated trades (this part of the system was working exactly as
designed — the bug was a missing dedicated provider, not broken safety logic).

**Everything else audited (BotManager's market-data dispatch wiring,
RiskEngine's validation pipeline, PaperEngine's execution/fee/P&L math,
Socket.IO session auth, ExecutionRouter's PAPER/LIVE split) was already
correct** — confirmed by re-reading every file line-by-line against the
spec's checklist in §2/§17/§19. No bugs were found in those files; they are
unmodified except where noted below.

### Official Delta documentation used (verified during this build)

- `docs.delta.exchange` (official Delta API reference) — confirmed HMAC-SHA256
  auth scheme, order/position/wallet endpoints (already correct from Part 1),
  and that `/v2/products`, `/v2/products/{symbol}`, `/v2/tickers`,
  `/v2/tickers/{symbol}` are public ("This operation does not require
  authentication").
- Delta's own support article *"Kickstarting Your Trading Journey with Delta
  [India] APIs"* (delta.exchange/support) — confirmed the exact
  `/v2/history/candles?symbol=&resolution=&start=&end=` historical-candles
  endpoint and parameter names, and the `/v2/products` discovery endpoint.
- A real, complete example `/v2/tickers/{symbol}` JSON response was found and
  cross-checked against three independent mirrors — confirming exact field
  names (`close`, `mark_price`, `spot_price`, `symbol`, `timestamp` in unix
  seconds) used by `DeltaMarketDataProvider._extractPrice/_extractTimestamp`.
- A Delta-derived Python WebSocket client example confirmed the **exact**
  subscribe envelope (`{"type":"subscribe","payload":{"channels":[{"name":
  "v2/ticker","symbols":[...]}]}}`) and production WebSocket URL
  (`wss://socket.india.delta.exchange`, already correctly present in Part 1's
  `.env.example`/`DeltaAdapter`).
- **What was deliberately NOT implemented**: the `candlestick_<resolution>`
  WebSocket channel's exact push-message field layout could not be
  independently verified against official documentation in this build. Per
  Nova Trade's "never invent external message formats" rule,
  `deltaWebSocketClient.js` only implements the verified `v2/ticker` channel;
  historical/candle data uses the verified REST endpoint instead, and Model
  001 continues building its own candles from price ticks (unchanged from
  Part 3) — so no candle-specific WS format was ever needed.
- This project is configured for **Delta Exchange India**
  (`api.india.delta.exchange` / `socket.india.delta.exchange`, matching Part
  1's existing `.env.example` default). Global endpoints differ only in
  domain (`api.delta.exchange`) — same paths/auth scheme — so switching is a
  `DELTA_BASE_URL`/`DELTA_WS_URL` change only, no code change.

### New files

```
services/marketData/
├── DeltaMarketDataProvider.js   Dedicated Delta provider (implements MarketDataProvider)
├── symbolMap.js                   Nova <-> Delta symbol mapping + validation
├── timeframeMap.js                 Nova timeframe -> Delta resolution mapping
└── deltaWebSocketClient.js           Isolated, opt-in WS client (v2/ticker only, verified)

utils/candleValidation.js         Shared candle validator (single source of truth)

tests/
├── deltaMarketDataProvider.test.js   Price/candle normalization, status shape
├── symbolMap.test.js                  Symbol mapping/validation
├── timeframeMap.test.js                Timeframe mapping/rejection
└── candleValidation.test.js             Shared validator direct tests
```

### Existing files modified (and why)

1. **`services/marketData/index.js`** — added a `'delta'` case to the
   provider factory. This is the actual fix for the reported problem.
2. **`config/env.js`** — `'delta'` added to the valid `MARKET_DATA_PROVIDER`
   list; added `MARKET_DATA_DELTA_USE_WEBSOCKET` (opt-in, default `false`)
   and `CORS_ALLOWED_ORIGIN`; **removed** `MARKET_DATA_WS_URL`, which existed
   in Part 1 but was never read anywhere (dead/misleading config per spec
   §29) — Delta's WS now correctly reuses the already-existing
   `DELTA_WS_URL`.
3. **`.env.example`** — documents the `delta` provider, clarifies Delta
   market data needs no API key, documents `CORS_ALLOWED_ORIGIN`, removes the
   dead var.
4. **`services/marketData/FreshnessCache.js`** — added `lastUpdateAt`
   tracking and `getActiveSymbols()`, needed for accurate System Status
   (§11/§24: "last update", "active symbols"). Purely additive; existing
   `isFresh`/`getPrice`/`subscribe` behavior unchanged (still covered by
   Part 1's `tests/freshnessCache.test.js`, still passing).
5. **`services/marketData/NullProvider.js`**, **`RestPollingProvider.js`** —
   `getConnectionStatus()` now also returns `lastUpdateAt`/`activeSymbols`
   for shape-consistency with the new Delta provider. Additive fields only.
6. **`bot-models/model-001/validators.js`** — now delegates to the new
   shared `utils/candleValidation.js` instead of a duplicate copy of the same
   logic, so core providers and Model 001 can never silently drift apart on
   what counts as a valid candle. Behavior is byte-for-byte identical — all
   23 existing `model001.indicators.test.js` candle-validation tests still
   pass unchanged.
7. **`services/delta/DeltaAdapter.js`** — added `checkAuthenticated()`: a
   cached (30s), read-only (`GET /profile` only, never a trading endpoint)
   check that credentials actually authenticate — needed to distinguish
   **CONFIGURED** (keys present) from **AUTHENTICATED** (keys actually work)
   per spec §24. No existing method changed.
8. **`controllers/healthController.js`** — `delta` now reports
   `{configured, authenticated, lastCheckedAt}` instead of just `configured`.
9. **`controllers/botInstancesController.js`** — list/get responses now
   include a computed (not persisted) `tradingReadiness`
   (`READY`/`BLOCKED`/`NOT_RUNNING`) and `marketData: {connected, fresh,
   providerName}` per instance, so a `RUNNING` bot with no market data is
   never confused with an actively-trading one (spec §13). The persisted
   `BotInstance.status` contract (`RUNNING`/`PAUSED`/`STOPPED`/`ERROR`) is
   completely unchanged — this is an additive, request-time-only field.
10. **`app.js`**, **`sockets/index.js`** — CORS now honors
    `CORS_ALLOWED_ORIGIN` (exact allowlist) when set, instead of always
    reflecting any request origin. Socket.IO's existing session-based
    connection auth (reject unless `session.userId` present) was
    audited and found already correct — unchanged.
11. **`views/bots.ejs`**/**`public/js/bots.js`** — display the new
    `tradingReadiness`/market-data badges per bot instance card.
    **`public/js/systemStatus.js`** — Delta row split into "Configured" vs
    "Authenticated" to match the new health payload shape.

**Nothing else was modified.** `RiskEngine`, `PaperEngine`, `LiveEngine`,
`ExecutionRouter`, `BotManager`'s core dispatch logic, `Model001.js`, every
Mongoose model, and every other Part 1/2/3 file are unchanged — confirmed by
re-running their full existing test suites (below) with zero regressions.

### Symbol & timeframe mapping

`services/marketData/symbolMap.js`: identity mapping by default (Delta's
`BTCUSD`/`ETHUSD` perpetual futures products already use exactly those
symbols — confirmed via a real example product response, `"symbol":
"BTCUSD"`), with an explicit override table for any future symbol that
genuinely needs to differ, and `_ensureValidProduct()` in the provider
actually calls `GET /v2/products/{symbol}` to confirm the product exists
before ever polling/subscribing — an unsupported symbol throws a clear
`UnsupportedSymbolError` rather than silently failing.

`services/marketData/timeframeMap.js`: Nova's timeframes (`1m,3m,5m,15m,30m,1h`)
map 1:1 to identical Delta `resolution` values — Delta natively supports all
of them (verified: `1m,3m,5m,15m,30m,1h,2h,4h,6h,1d,7d,30d,1w,2w`), so **no
client-side timeframe aggregation was needed or implemented**. An
unsupported timeframe is rejected explicitly (`UnsupportedTimeframeError`)
rather than guessed or silently aggregated.

### Model 001 candle integration (unchanged from Part 3, re-verified)

`DeltaMarketDataProvider.subscribePrice()` feeds price ticks through the
exact same `BotManager.dispatchMarketData({type:'price',...})` path
`server.js` already used in Part 1/3 — Model 001's own
`candleAggregator.js` (from Part 3, unmodified) builds candles from these
ticks exactly as before. Swapping `generic_rest` → `delta` required **zero**
changes to `BotManager`, `Model001.js`, or the dispatch pipeline — this is
the MarketDataProvider abstraction from Part 1 working exactly as designed.

### Tests actually executed

```
node --test tests/pnl.test.js tests/tradeCommandSchema.test.js \
  tests/duplicateSignalDetector.test.js tests/freshnessCache.test.js \
  tests/nullProvider.test.js tests/model001.indicators.test.js \
  tests/model001.candleAggregator.test.js tests/model001.patternEngine.test.js \
  tests/model001.validators.test.js tests/model001.model.test.js \
  tests/symbolMap.test.js tests/timeframeMap.test.js tests/candleValidation.test.js
# tests 118
# pass 118
# fail 0
```

This is every DB/network-independent test across all four parts, run
together: **zero regressions**, plus 15 new Part 4 tests (symbol mapping,
timeframe mapping/rejection, shared candle validator). `node --check` passes
on all 115 project JS files.

`tests/deltaMarketDataProvider.test.js` (price/candle normalization,
malformed-response rejection, status shape, timeframe-before-network-call
ordering) requires the `axios` package and could not run in this
network-isolated sandbox — same documented limitation as every other
axios/mongoose-dependent test since Part 1. It is syntax-checked and ready to
run after `npm install`.

### Real public market-data verification (honest result)

Per spec §31, I attempted to fetch live Delta data. **This sandbox's
`bash_tool` network is restricted to package registries (npm/pip/github)
and cannot reach `api.india.delta.exchange`**, and the `web_fetch` tool
requires a URL to have appeared verbatim in a prior search result before it
can be fetched, which it did not in a directly fetchable form. **I could not
make a live HTTP request to Delta's API from this sandbox — I am not
claiming to have done so.**

What I *did* do instead: multiple targeted web searches surfaced a complete,
real example `/v2/tickers/{symbol}` response body (with realistic BTCUSD
figures, all field names matching what `DeltaMarketDataProvider` parses) from
three independent sources (Delta's own docs mirror + two third-party API
guides), plus Delta's own support article confirming the exact
`/v2/history/candles` parameter names and the products/tickers
public-vs-authenticated distinction. This is why I'm confident the
implementation is correct, but it is **schema verification via documentation
and cross-referenced published examples, not a live network test** — that
distinction matters and I'm not blurring it.

**Action required from you**: after `npm install`, run
`MARKET_DATA_PROVIDER=delta node server.js` (no Delta credentials needed —
market data is public) and check `GET /api/health` /
`GET /api/market/price/BTCUSD` against the real, live API to get the actual
end-to-end confirmation this sandbox couldn't provide.

### End-to-end Paper pipeline test result

Same honest limitation as Parts 1-3: no MongoDB/network in this sandbox means
`tests/integration.test.js` and `tests/model001.integration.test.js` (both
already written, both already proven to correctly self-skip without a
database) were not executed here. The full chain — `DeltaMarketDataProvider`
→ `BotManager.dispatchMarketData` → `Model001` → `PatternEngine` →
`TradeCommand` → `RiskEngine` → `ExecutionRouter` → `PaperEngine` → MongoDB →
Socket.IO → Part 2 UI — is wired end-to-end and unit-tested at every layer,
but a live run against a real MongoDB + real Delta data was not performed. Do
this after `npm install` + starting MongoDB, per "Instructions to run"
below.

### Startup verification (honest result)

`npm install` could not run in this sandbox (no network access to
registry.npmjs.org from `bash_tool`), so `npm start` was never actually
executed here either — consistent with every prior part of this project. All
115 JS files pass `node --check`. This is a static guarantee against syntax
errors only, not a substitute for an actual startup run — please run
`npm install && npm start` yourself and report any runtime error (e.g. a
`require()` typo that only surfaces at load time) so it can be fixed.

### Security/status fixes

- Live Trading remains **disabled by default** (`LIVE_TRADING_DEFAULT_ENABLED=false`,
  unchanged) — Delta being *configured* has never enabled it (confirmed
  unchanged in `RiskEngine`/`LiveEngine`/`SafetyService`).
- Close Position / Close All Positions were re-audited: `PAPER` closes go
  through `PaperEngine.closePosition()`, `LIVE` closes go through
  `LiveEngine.closePosition()` → `DeltaAdapter.placeOrder()` with
  `reduceOnly:true` — never a direct MongoDB status write. Unchanged from
  Part 1/2, confirmed correct.
- CORS is now an explicit allowlist in production via `CORS_ALLOWED_ORIGIN`
  instead of always reflecting any origin (see "Existing files modified" #10).
- System Status now distinguishes **CONFIGURED** vs **AUTHENTICATED** for
  Delta instead of conflating "has API keys" with "actually works".

### Known limitations

- No live network test was performed against Delta's real API from this
  sandbox (see above) — schema correctness is verified via documentation and
  real published examples, not a live call.
- The Delta `candlestick_<resolution>` WebSocket channel is intentionally not
  implemented (unverified message format) — REST polling via the ticker
  channel + Model 001's own tick-based candle aggregation is used instead.
  This is a deliberate, documented choice, not an oversight.
- No `npm install` / live server run / live database run was possible in
  this sandbox — see "Startup verification" and "End-to-end Paper pipeline
  test result" above for exactly what was and wasn't verified.
- Do not treat Nova Trade as production-ready for real-money trading until
  you've run the live verification steps above yourself.

### Instructions to configure and run

```bash
npm install
cp .env.example .env
# Minimum for real Delta market data (no credentials needed):
#   MARKET_DATA_PROVIDER=delta
#   DELTA_BASE_URL=https://api.india.delta.exchange/v2
#   DELTA_WS_URL=wss://socket.india.delta.exchange
#   RISK_ALLOWED_SYMBOLS=BTCUSD,ETHUSD
# Set SESSION_SECRET and MONGODB_URI too.
npm test
npm run dev
```

Then: register/log in → Bots → create a `MODEL_001` instance (`PAPER`,
symbol `BTCUSD`) → Start it → watch System Status for Market Data
`CONNECTED`/`FRESH` and the bot card's `Trading Readiness: READY` → watch
Paper Trading / Positions / Orders as candles accumulate and (if
`DEFAULT_RULESET_V1` conditions are naturally met) a real paper trade
executes.

---

## Part 3 — Model 001 (rule-based strategy)

Model 001 is Nova Trade's first Bot Model, plugged into the **existing,
unmodified** Bot Model contract from Part 1. Full architecture, parameters,
exact `DEFAULT_RULESET_V1` rules, and usage instructions live in
**`bot-models/model-001/README.md`** — read that first. This section covers
what changed at the project level and how Part 3 was verified.

**`DEFAULT_RULESET_V1` is an illustrative example only — it is NOT the
client's final trading strategy, has not been backtested, and no
profitability or win-rate claim is made anywhere in this codebase.**

### New files (Part 3)

```
bot-models/model-001/
├── index.js              Registration (modelId MODEL_001, metadata, create())
├── Model001.js             Orchestrator implementing the existing BotModelBase contract
├── config.js                DEFAULT_PARAMETERS, timeframes, DEFAULT_RULESET_V1 name
├── validators.js              validateCandle(), validateAndMergeParameters()
├── indicators.js                Pure candle-analysis utilities
├── candleAggregator.js            Deterministic price-tick -> OHLCV aggregator
├── patternEngine.js                 Pure deterministic rule evaluator
└── README.md                          Full Model 001 documentation

tests/
├── model001.indicators.test.js       Candle validation + indicator math
├── model001.candleAggregator.test.js  Tick-to-candle aggregation
├── model001.patternEngine.test.js      LONG/SHORT/NO_ACTION/pyramiding/exit rules
├── model001.validators.test.js           Parameter validation
├── model001.model.test.js                  Orchestration: commandId, sizing, SL/TP, lifecycle, boundaries
└── model001.integration.test.js              BotManager -> RiskEngine -> ExecutionRouter -> PaperEngine (DB-gated)
```

### Existing files modified (and why) — minimal, per the "protect existing code" rule

1. **`views/bots.ejs`** — added a single generic `<div id="modelParamsSection">`
   container to the existing "Create Bot Instance" form. No existing fields,
   markup, or the Bot Instance table were changed.
2. **`public/js/bots.js`** — added `renderModelParamFields()`/`collectModelParams()`
   which read the **already-existing** `defaultParameters` field returned by
   `GET /api/bot-models` (this field existed in Part 1's `BotModelMetadata`
   schema and `BotManager.discoverModels()` already populated it — Part 2
   simply hadn't rendered it yet) and render a generic key/value form:
   number → number input, boolean → true/false select, string → text input.
   This is **not Model-001-specific markup** — any future model's parameters
   render the same way automatically, satisfying "frontend should discover
   it from backend model metadata, do not hardcode Model 001 into frontend
   HTML." The collected object is sent as the existing `parameters` field on
   `POST /api/bot-instances`, which Part 1's `botInstancesController`/
   `BotManager.createInstance` already accepted and stored.

**Nothing else was modified.** `BotManager`, `RiskEngine`, `PaperEngine`,
`LiveEngine`, `DeltaAdapter`, `ExecutionRouter`, `BotModelBase`,
`TradeCommandSchema`, every Mongoose model, every other Part 2 page, and the
overall market-data dispatch pipeline (`server.js`) are byte-for-byte
unchanged from Part 2.

### How Model 001 gets market data without any core changes

`BotManager.dispatchMarketData()` already forwards approved price ticks from
`MarketDataProvider` — Model 001 builds its own OHLCV candles from that
existing stream via `candleAggregator.js`, entirely inside the model. No
change to `BotManager`, `server.js`, or `MarketDataProvider` was needed. Full
rationale and known limitations (no historical backfill, no volume data yet)
are documented in `bot-models/model-001/README.md`.

### Tests actually executed for Part 3

```
node --test tests/pnl.test.js tests/tradeCommandSchema.test.js \
  tests/duplicateSignalDetector.test.js tests/freshnessCache.test.js \
  tests/nullProvider.test.js tests/model001.indicators.test.js \
  tests/model001.candleAggregator.test.js tests/model001.patternEngine.test.js \
  tests/model001.validators.test.js tests/model001.model.test.js
# tests 103
# pass 103
# fail 0
```

This is the **full DB-independent suite** (Part 1 + Model 001) run together
in this sandbox, confirming **zero regressions** to Part 1 while adding 71
new Model 001 tests covering: candle validation (valid/invalid/NaN/missing
OHLC/bad timestamp), bullish/bearish/wick/body/doji calculations, swing
high/low, consecutive-candle counts, volume comparison with missing-data
handling, LONG/SHORT rule matching, NO_ACTION paths, pyramiding-disabled
behavior, the v1 exit-on-opposing-signal rule, deterministic `commandId`
generation, capital-allocation-based sizing, LONG/SHORT stop-loss/take-profit
math, duplicate-closed-candle prevention, pause/stop lifecycle, malformed
candle rejection, parameter validation (12 cases), and a static source scan
proving Model 001 never `require()`s `DeltaAdapter`, `PaperEngine`,
`LiveEngine`, `ExecutionRouter`, or any Mongoose model.

`tests/model001.integration.test.js` (BotManager discovers `MODEL_001`, a
PAPER breakout signal flows through RiskEngine + ExecutionRouter into a real
`PaperEngine` position, duplicate-candle protection holds at the integration
level, and a LIVE instance never creates a PAPER position) is written and
**self-skips without MongoDB**, same pattern as `tests/integration.test.js`
from Part 1 — it was not executed in this sandbox for the same reason
`npm install`/a live server couldn't run here (see "Sandbox limitations").

### Paper-mode validation actually performed

**Not executed against a live server in this sandbox** (no network access
here, so no `npm install`, no running MongoDB, no running Node process — see
Part 1/2's "what could not be executed" sections, which apply identically to
Part 3). What **was** verified without a live server:
- Every Model 001 source file passes `node --check`.
- The full BotManager→RiskEngine→ExecutionRouter→PaperEngine flow is
  exercised by `Model001` unit tests using a mocked `submitTradeCommand`
  (proving Model 001's half of the contract) plus the separate
  `tests/model001.integration.test.js` (proving the real
  BotManager/RiskEngine/PaperEngine half), which is ready to run the moment
  MongoDB is available.
- The static boundary scan confirms Model 001 cannot reach Delta/execution
  engines/the database by any import path, at the source-code level.

**After `npm install` + starting MongoDB**, follow
`bot-models/model-001/README.md` → "Running Model 001 in PAPER mode" to
actually execute the full flow against a live server and confirm order/
position persistence, P&L, duplicate-signal protection, stale-data blocking,
and pause/stop behavior in a real running instance — this was not claimed as
done here because it genuinely wasn't run.

### Delta / live-trading limitations (unchanged from Part 1)

Model 001 itself never touches Delta. The existing Part 1 limitation stands:
Delta endpoint paths/auth were checked against Delta's published docs but
should be verified against your own account/region before enabling
`LIVE`-environment Model 001 instances — see `services/delta/DeltaAdapter.js`.
**Do not treat Model 001 as production-ready for real-money trading** until
Delta integration, a real market data source, complete end-to-end Paper
testing, and all live safety mechanisms have actually been verified against a
running system — none of that verification was possible in this sandbox.

### Instructions to run Model 001 in PAPER mode

See `bot-models/model-001/README.md` → "Running Model 001 in PAPER mode" for
the full walkthrough (configure a real market data provider, create a PAPER
instance from the Bots page, start it, watch strategy events, check Paper
Trading/Positions/Orders).

### Where to add the final client strategy later

`bot-models/model-001/patternEngine.js` → add a new pure evaluator function
next to `evaluateDefaultRulesetV1`, register it in `RULESET_EVALUATORS` under
a new name, add any new parameters to `config.js`/`validators.js`, then set
a Bot Instance's `ruleSet` parameter to the new name. Full instructions in
`bot-models/model-001/README.md` → "Replacing DEFAULT_RULESET_V1 with the
real client strategy later." No change to `Model001.js`, any Part 1 core
service, or Part 2 frontend is required.

---

## Part 2 — Frontend (added on top of Part 1)

A complete server-rendered EJS frontend was added directly into this codebase.
No Part 1 architecture was rewritten — see "Part 1 files modified" below for
the small, additive, and justified exceptions.

### Pages implemented

| Page | Route | Backing APIs used |
|---|---|---|
| Login | `/login` | `POST /api/auth/login`, `POST /api/auth/logout` |
| Dashboard | `/dashboard` | `GET /api/portfolio/paper`, `GET /api/health`, `GET /api/orders`, `GET /api/logs/strategy-events`, `GET /api/settings` |
| Paper Trading | `/paper` | `GET/POST /api/paper/*`, `GET /api/portfolio/paper`, `GET /api/orders`, `GET /api/settings` |
| Live Trading | `/live` | `GET /api/live/status`, `GET /api/portfolio/live`, `POST /api/live/positions`, `POST /api/live/positions/:id/close`, `GET /api/settings` |
| Bots | `/bots` | `GET /api/bot-models`, `GET/POST /api/bot-instances/*`, `GET /api/settings` |
| Orders | `/orders` | `GET /api/orders` (filterable) |
| Positions | `/positions` | `GET /api/positions` (filterable), close via `/api/paper/positions/:id/close` or `/api/live/positions/:id/close` |
| Trade History | `/trades` | `GET /api/trades` (filterable) |
| System Status | `/system-status` | `GET /api/health`, `GET /api/market/fresh/:symbol`, `GET /api/logs/system` |
| Safety & Settings | `/safety` | `GET /api/safety/status`, all `POST /api/safety/*` |

Model 001 is **not** implemented anywhere in Part 2 — the Bots page only ever
calls the existing, model-agnostic `BotManager` endpoints.

### Socket.IO events integrated

Only events Part 1 actually emits are used: `market:price`, `market:status`,
`bot:status`, `bot:event`, `log:new`. Two additive events (`paper:portfolio`,
`live:portfolio`, `position:update`, `order:update`) were added — see below.

### Part 1 files modified (and why)

Per the "only touch Part 1 when justified" rule, every change here is small,
additive, and documented in the modified file itself:

1. **`utils/socketBus.js` (new file)** — a minimal accessor so REST
   controllers can broadcast Socket.IO events without any execution engine
   (PaperEngine/LiveEngine/RiskEngine/BotManager/DeltaAdapter) needing to know
   about sockets. Core engines were **not** touched.
2. **`server.js`** — two lines added to attach the Socket.IO server to
   `socketBus`, alongside the existing `logger`/`botManager` attachments.
3. **`controllers/paperController.js`**, **`controllers/liveController.js`**,
   **`controllers/safetyController.js`** — added `socketBus.emitTo(...)` calls
   *after* existing successful mutations (open/close position, add funds,
   safety close). Justification: Part 1 shipped Socket.IO rooms/auth but never
   emitted `paper:portfolio`/`live:portfolio`/`position:update`/`order:update`,
   so the dashboard had no way to update in real time after a trade. No
   existing logic, validation, or response shape was changed.
4. **`controllers/settingsController.js`** — `GET /api/settings` now also
   returns `allowedSymbols`, `paperMaxLeverage`, `riskMaxLeverage` (all
   non-sensitive config already loaded server-side) so trade forms can
   populate a symbol dropdown instead of a free-text field. No secrets added.
5. **`app.js`** — replaced the two Part 1 placeholder inline routes
   (`GET /`, `GET /login`, both rendering `placeholder.ejs`) with
   `app.use('/', viewRoutes)`. This is exactly what Part 1's own code comment
   said Part 2 would do ("Placeholder EJS route (Part 2 replaces this)").
6. **`sockets/index.js`** — doc-comment only update listing the two new
   events/rooms; no behavioral change.
7. **`views/placeholder.ejs`** — removed (superseded by the real pages).

No changes were made to: models, MarketDataProvider, RiskEngine, PaperEngine,
LiveEngine, DeltaAdapter, BotManager, ExecutionRouter, the Bot Model contract,
or any existing route/controller *logic* (only additive broadcast calls were
appended after existing success paths).

### New backend route added

- **`routes/viewRoutes.js` (new)** — maps the 9 protected pages + `/login` +
  `/` to `res.render(...)`, reusing the existing `requireAuth` middleware. No
  new business logic; purely view rendering.

### Frontend structure

```
public/
├── css/styles.css        Design system (dark theme, cards, badges, tables, forms)
└── js/
    ├── format.js          Currency/P&L/time/badge formatting helpers
    ├── api.js              fetch wrapper: loading state, error handling, 401 → /login
    ├── ui.js                Toasts, confirmation modal, mobile sidebar
    ├── socket.js            Socket.IO client + connection indicator
    ├── nav.js                Logout button
    ├── chart.js              Read-only TradingView embed (dashboard only)
    └── {page}.js              Per-page data loading/rendering/actions

views/
├── partials/{head,sidebar,topbar,scripts}.ejs   Reusable layout partials
├── login.ejs
└── {dashboard,paper,live,bots,orders,positions,trades,system-status,safety}.ejs
```

No React/Vue/Angular/build step — vanilla EJS + CSS + JS, Socket.IO client
served automatically by the existing `socket.io` server package.

### Data integrity rules followed

- No `Math.random()`, no hardcoded stats, no fake balances/positions/orders
  anywhere in `public/js/*` — every number comes from a fetched API response.
- Missing/unavailable data renders literal strings: `"No data yet"`,
  `"Unavailable"`, `"Live Trading Unavailable — Delta Exchange is not
  connected."`, `"No Bot Models Installed"`, etc. — never a plausible-looking
  placeholder number.
- The Live page's trade form stays `disabled` until `GET /api/live/status`
  confirms Delta is configured **and** `GET /api/settings` confirms live
  trading is globally enabled.
- Live and Paper position closes route to different backends
  (`/api/paper/positions/:id/close` vs `/api/live/positions/:id/close` /
  `/api/safety/positions/:id/close`) — a position's `environment` field
  decides the path, the frontend never guesses.
- Dangerous actions (enable live trading, close position(s)) show a
  JS confirmation modal *and* the backend still independently requires
  `{"confirm":"CONFIRM"}` — the frontend confirmation is a UX convenience,
  not a security boundary.
- Test-only mocks (`tests/helpers/mockProvider.js`, the `_setProviderForTesting`
  hook) are never imported by anything under `public/` or `views/`.

### Tests run for Part 2

Same test suite as Part 1 (no new backend logic was added that needed new
unit tests — the additions are broadcast calls and a route table). Results in
this sandbox (no network/npm install available here, so DB/HTTP-dependent
tests are unexecuted — see "Sandbox limitations" below):

```
node --test tests/pnl.test.js tests/tradeCommandSchema.test.js \
  tests/duplicateSignalDetector.test.js tests/freshnessCache.test.js \
  tests/nullProvider.test.js
# tests 32
# pass 32
# fail 0
```

All 93 project JS files (up from 75 in Part 1) pass `node --check`.
`tests/integration.test.js` (RiskEngine+PaperEngine end-to-end) is unchanged
and still self-skips without MongoDB.

### What could not be executed in this sandbox

This sandbox has no network access, so `npm install` was not possible here —
meaning the server itself could not actually be started, and manual/browser
testing of the 22 items in the Part 2 spec's testing checklist (login flow,
dashboard rendering, paper LONG/SHORT via the UI, mobile responsiveness,
etc.) could not be executed end-to-end. What *was* verified: `node --check`
on every JS file, EJS `<% %>`/`<body>`/`</html>` tag-balance checks on every
template, and a full re-run of the DB-independent Part 1 test suite (still
32/32 passing, confirming no regression). After `npm install` + starting
MongoDB, run through the Part 2 spec's 22-item manual test list — the code
paths for all of them are implemented and wired to the endpoints listed above.

### Known limitations carried over from Part 1

- Delta Exchange endpoint paths/auth were checked against Delta's published
  docs but should be verified against your own account/region before going
  live (see the `VERIFY BEFORE LIVE USE` note in `services/delta/DeltaAdapter.js`).
- If `MARKET_DATA_PROVIDER` is `none` (default), the Dashboard's chart, price
  displays, and paper/live order forms will correctly show "unavailable" —
  this is expected until a real market data source is configured.

---

## Architecture

```
MARKET DATA PROVIDER
        |
BOT MODEL (Part 3, not included here)
        |
BOT MANAGER
        |
RISK ENGINE
        |
EXECUTION ROUTER
        |
   +----+----+
   |         |
PAPER      LIVE
ENGINE     ENGINE
   |         |
Virtual    Delta Exchange
Execution  Real Execution
```

Key rules enforced throughout the codebase:
- Bot Models never touch Delta, MongoDB, or PaperEngine/LiveEngine directly — they only
  emit `TradeCommand`/`StrategyEvent`/`StatusUpdate`/`Error` objects to `BotManager`.
- Every bot-generated trade command passes through `RiskEngine` before execution.
- `ExecutionRouter` routes strictly on `command.environment` — no inference, no fallback.
- Paper and Live data (balances, positions, orders, portfolios) are never mixed.
- No fake/random market data or fake successful Delta orders anywhere in the codebase.

## Project structure

```
nova-trade/
├── app.js               Express app wiring (middleware, sessions, routes)
├── server.js             Entry point: DB, sockets, bot manager, market-data dispatch
├── config/                env.js (validated config), database.js (Mongo connection)
├── models/                Mongoose schemas
├── controllers/ + routes/ REST API, grouped by domain
├── services/
│   ├── marketData/        MarketDataProvider abstraction + Null/REST implementations
│   ├── paperEngine/        Virtual execution engine
│   ├── liveEngine/         Real execution engine (via DeltaAdapter only)
│   ├── delta/               Isolated Delta Exchange REST client
│   ├── riskEngine/          Mandatory validation gate for bot trade commands
│   ├── botManager/          Bot instance lifecycle + command routing (no strategy logic)
│   ├── execution/           PAPER vs LIVE routing
│   ├── portfolio/           Paper/Live portfolio calculations (kept isolated)
│   └── safety/              Stop bots / enable-disable live / close positions
├── bot-models/             Bot Model contract for Part 3 (BotModelBase, TradeCommandSchema)
├── middleware/ / sockets/ / utils/
├── views/placeholder.ejs   Minimal placeholder page (Part 2 replaces this)
└── tests/                  Unit + integration tests
```

## Installation

```bash
cd nova-trade
npm install
cp .env.example .env
# edit .env — at minimum set SESSION_SECRET and MONGODB_URI
```

## MongoDB setup

Run a local MongoDB (or Atlas) instance and point `MONGODB_URI` at it, e.g.:

```
MONGODB_URI=mongodb://127.0.0.1:27017/nova_trade
```

The server creates collections automatically on first use via Mongoose.

## Running

```bash
npm run dev     # NODE_ENV=development
npm start        # production
```

On startup the server:
1. Validates required env vars (exits with a clear message if misconfigured).
2. Connects to MongoDB.
3. Initializes the global safety singleton (`liveTradingEnabled` defaults to `false`
   unless `LIVE_TRADING_DEFAULT_ENABLED=true`).
4. Starts Express + Socket.IO.
5. Runs `BotManager.discoverModels()` (no-op until Part 3 adds a model folder).
6. Subscribes to market data for each symbol in `RISK_ALLOWED_SYMBOLS`, if a provider
   is configured — otherwise logs a warning and runs in a data-less state where all
   automated trading is blocked (by design, see Rule 9 below).

If `DELTA_API_KEY`/`DELTA_API_SECRET` are absent, the server still starts in
**Paper-only mode**; every Live Trading Engine / Delta endpoint returns an explicit
`DELTA_NOT_CONFIGURED` (503) error instead of silently doing nothing or faking success.

## Running tests

```bash
npm test
```

Pure-logic unit tests (P&L math, TradeCommand validation, duplicate-signal detection,
freshness cache, NullProvider never-fakes-data) run with zero external dependencies.

`tests/integration.test.js` exercises RiskEngine + PaperEngine + ExecutionRouter
end-to-end against a real MongoDB and is **automatically skipped** if no MongoDB is
reachable at `MONGODB_URI_TEST` (default `mongodb://127.0.0.1:27017/nova_trade_test`)
within 1.5s — so `npm test` still passes in environments without a database. To run it
for real:

```bash
MONGODB_URI_TEST=mongodb://127.0.0.1:27017/nova_trade_test npm test
```

Live Delta integration tests are **not included and must never run automatically** —
`ENABLE_LIVE_INTEGRATION_TESTS` exists in `.env.example` as a documented placeholder
for any live tests you add later; none are wired up by default, and none place real
orders.

## Paper Trading

- Each user gets a `PaperAccount` initialized **once** with `PAPER_INITIAL_BALANCE_USD`
  (default $50,000). Balance persists in MongoDB and is never reset on restart.
- Add virtual funds: `POST /api/paper/account/add-funds { amount, reason }`.
- Open/close positions: `POST /api/paper/positions`, `POST /api/paper/positions/:id/close`.
- Formulas (see `utils/pnl.js`): `notional = price*qty`, `margin = notional/leverage`,
  `fee = notional*feeRate`, `LONG PnL = (cur-entry)*qty`, `SHORT PnL = (entry-cur)*qty`.
- Paper orders are **rejected** (not faked) if there is no fresh market price or
  insufficient balance. Paper trades never reach Delta.

## Live Trading

- Requires `DELTA_API_KEY`/`DELTA_API_SECRET` **and** the global live-trading switch
  enabled via `POST /api/safety/live-trading/enable` (requires `{"confirm":"CONFIRM"}`).
- `LiveEngine` talks to Delta only through `DeltaAdapter`. It never fakes fills and
  never falls back to paper trading if Delta is unavailable — it errors out instead.
- `POST /api/live/positions/sync` reconciles local records against Delta's
  authoritative position/order data (MongoDB is treated as a mirror, not the source
  of truth, for live money).

## Delta Exchange setup

1. Create API credentials in your Delta Exchange account.
2. Set `DELTA_API_KEY`, `DELTA_API_SECRET`, and the correct `DELTA_BASE_URL` for your
   region/environment (see comments in `.env.example` — Global vs India, production
   vs testnet).
3. Authentication uses HMAC-SHA256 request signing over
   `method + timestamp + path + query + body`, sent as `api-key`/`signature`/`timestamp`
   headers — implemented in `services/delta/DeltaAdapter.js`, verified against Delta's
   published API docs during this build.
4. **Verify before going live:** the "close all positions" endpoint's exact
   path/behavior was not fully confirmed in this build (see the `VERIFY BEFORE LIVE
   USE` comment in `DeltaAdapter.js`). `LiveEngine.closeAllPositions()` uses a safer,
   fully-verified alternative (iterating positions and closing each with a
   reduce-only market order) by default.

## MarketDataProvider

Configurable via `MARKET_DATA_PROVIDER`:
- `none` (default) — no data source configured. Every method throws an explicit,
  typed `MARKET_DATA_NOT_CONFIGURED` error. **No fake/random prices are ever
  generated.** This is enforced and unit-tested (`tests/nullProvider.test.js`).
- `generic_rest` — polls an authorized REST endpoint you configure via
  `MARKET_DATA_REST_BASE_URL`/`MARKET_DATA_REST_API_KEY`.
- `tradingview_udf` — polls a legitimate, authorized UDF-compatible endpoint (a
  documented third-party protocol many data vendors expose) — this is **not**
  scraping the TradingView website or embedded chart widget.

Freshness: every price update is stamped with a receive timestamp
(`FreshnessCache`). If a symbol's last update exceeds `MARKET_DATA_STALE_THRESHOLD_MS`,
`isDataFresh()` returns `false` and `RiskEngine` blocks all new automated trades for
that symbol (Rule 9). Swapping providers requires no change to PaperEngine,
LiveEngine, RiskEngine, or any Bot Model — they only ever call the abstraction.

## Bot Model contract (for Part 3)

See `bot-models/README.md` and `bot-models/BotModelBase.js` for the full contract.
Summary:

- Extend `BotModelBase`; implement `onStart`, `onMarketData`, `onPause`, `onStop`.
- Call `this.submitTradeCommand({...})` to request a trade — this is the *only* way a
  model can cause execution. Flow: `BotModel -> BotManager -> RiskEngine ->
  ExecutionRouter -> PaperEngine | LiveEngine`.
- Call `this.emitStrategyEvent(...)` / `emitStatusUpdate(...)` / `emitError(...)` for
  observability (persisted to `StrategyEvent`/`SystemLog`, broadcast via Socket.IO).
- `commandId` must be unique per logical signal; `RiskEngine` uses it for
  idempotency/duplicate-signal rejection within `RISK_DUPLICATE_SIGNAL_WINDOW_MS`.
- A Bot Model never receives Delta credentials, never writes to MongoDB directly,
  and never calls PaperEngine/LiveEngine/Delta directly — all of that is enforced by
  the platform, not by convention.
- To register: drop `bot-models/<model-id>/index.js` exporting
  `{ modelId, modelVersion, create }`. Restart the server (or call
  `POST /api/bot-models/rescan`) to pick it up.

## API overview

All responses: `{ success, message, data, error }`.

| Group | Base path | Notes |
|---|---|---|
| Auth | `/api/auth` | register, login, logout, me |
| Market | `/api/market` | price, candles, status, freshness |
| Paper | `/api/paper` | account, add-funds, open/close positions |
| Live | `/api/live` | balance, open/close positions, orders, sync |
| Orders | `/api/orders` | list/get, filterable |
| Positions | `/api/positions` | list/get, filterable |
| Trades | `/api/trades` | list, filterable |
| Portfolio | `/api/portfolio/paper`, `/api/portfolio/live` | kept fully separate |
| Bot Models | `/api/bot-models` | list, rescan |
| Bot Instances | `/api/bot-instances` | create/start/pause/stop/restart |
| Logs | `/api/logs` | system, strategy-events, risk-events |
| Settings | `/api/settings` | global settings snapshot |
| Safety | `/api/safety` | stop bot(s), enable/disable live, close position(s) |
| Health | `/api/health` | unauthenticated; no sensitive config exposed |

Dangerous actions (`enable live trading`, `close position(s)`) require
`{"confirm":"CONFIRM"}` in the request body.

## Safety warnings

- `STOP ALL BOTS` does **not** close positions.
- `DISABLE LIVE TRADING` does **not** close positions.
- `CLOSE ALL POSITIONS` is a separate, explicitly-confirmed, dangerous action that
  affects both Paper and Live environments.
- Live trading defaults to **disabled** (`LIVE_TRADING_DEFAULT_ENABLED=false`) and
  must be explicitly enabled after startup.
- Stale market data blocks new automated trades; it does not affect closing existing
  positions manually.

## What this build could not verify/execute (sandbox limitations)

This codebase was written and syntax-validated (`node --check` on every file) in a
network-isolated sandbox, so `npm install` and a live server run were not possible
here. Everything below should be your first steps after downloading:

1. `npm install` — installs express, mongoose, socket.io, axios, etc.
2. Start MongoDB locally, run `npm run dev`, hit `GET /api/health`.
3. `npm test` — 32 pure-logic unit tests (P&L math, TradeCommand validation,
   duplicate-signal detection, freshness cache, NullProvider) require no setup and
   should pass immediately. `tests/integration.test.js` needs MongoDB reachable at
   `MONGODB_URI_TEST` to actually run (it self-skips otherwise).
4. Delta Exchange endpoint paths/auth were checked against Delta's published API
   documentation, but **verify against your own account/region** before enabling
   live trading — especially the "close all positions" endpoint (flagged in
   `DeltaAdapter.js`).
5. If you configure `MARKET_DATA_PROVIDER=generic_rest` or `tradingview_udf`, confirm
   your vendor's actual response shape matches `RestPollingProvider._parseGenericPrice`
   / `_parseUdfQuote` / `_parseUdfHistory` — adjust those three methods if it differs.

## Part 1 acceptance criteria — status

All 28 criteria from the spec are implemented in code:
server bootstraps, MongoDB connects, auth works, paper account initializes once,
funds can be added, MarketDataProvider abstraction with zero fake data, paper
LONG/SHORT execution + P&L, persisted orders/positions, isolated DeltaAdapter, live
mode never fakes execution, RiskEngine validates every automated command, BotManager
has zero strategy logic, Bot Model contract implemented, instance lifecycle works,
BotManager→RiskEngine→ExecutionRouter flow implemented, PAPER/LIVE strictly
separated, logs/strategy-events/Socket.IO/safety controls implemented, stale-data
blocking and duplicate-command rejection implemented, health API implemented. Item
27 ("critical unit tests pass") is verified for all DB-independent tests (32/32
passing in this sandbox); DB-dependent tests are written and will run once you have
MongoDB + `npm install` available, per the section above.
