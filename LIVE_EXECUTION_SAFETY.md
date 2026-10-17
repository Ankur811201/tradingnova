# NOVA TRADE — LIVE execution safety changes

Scope: live order lifecycle, fill confirmation, exchange-side stop-loss, exits, reconciliation.
**Untouched (byte-identical to the supplied ZIP):** `bot-models/**` (all MODEL_001/MODEL_002 rules), `services/paperEngine/**`, `services/riskEngine/**`, `bot-models/TradeCommandSchema.js`.

## Findings in the supplied ZIP (original `services/liveEngine/LiveEngine.js` line refs)
| # | Finding | Where |
|---|---|---|
| 1 | `stopLossOrder: null` — no exchange-side stop; protection relied on the local tick loop (server.js:97-98). Confirmed. | LiveEngine:83 |
| 2 | `size: quantity` sent in BTC (MODEL_002 emits lot×0.001, e.g. 0.01). Delta `size` is an **integer number of contracts** (BTCUSD `contract_value` 0.001). A MODEL_002 trigger could not submit the correct order. | LiveEngine:79, ExecutionRouter |
| 3 | HTTP success treated as fill: Position created unconditionally and `OPEN`. | LiveEngine:94-121 |
| 4 | Market-order fill price taken from `limit_price` (null for market) → `entryPrice` 0. | LiveEngine:95,113 |
| 5 | Close/partial-close marked `CLOSED` / quantity reduced before any fill confirmation; exit price = `limit_price` or stale `currentPrice`; `fees: 0`. | LiveEngine:159-170, 245-256 |
| 6 | Timeouts normalised into a generic error with no "did the exchange accept it?" check. | DeltaAdapter `_request` |
| 7 | No idempotency: duplicate command/exit could place a second order; closes had no lock. | LiveEngine |
| 8 | Live positions never got `originalQuantity`, so T2/T3 would be sized off the *remaining* quantity after T1. | LiveEngine / TargetExitManager:478 |
| 9 | `syncPositions` overwrote local `realizedPnl`/`currentPrice` with exchange fields and had no protection/order/orphan checks; no startup recovery for live. | LiveEngine:295-319, server.js |

## What changed
- `services/delta/deltaOrderState.js` (new, pure): order classification from documented fields only (`size`, `unfilled_size`, `average_fill_price`, `state`, `paid_commission`); contract↔quantity conversion (whole contracts, no silent rounding); stop-order matching.
- `services/delta/DeltaAdapter.js`: `ambiguous` (timeout/5xx) and `isAuthError` flags on errors; `placeBracketOrder` → documented `POST /v2/orders/bracket`.
- `services/liveEngine/LiveEngine.js`: rewritten, same public methods. Fill-confirmed entries; verified stop; verified emergency close; atomic close claim (`closeInFlight`); reduce-only closes sized from the real exchange position; close/target never marked done unconfirmed; fee-aware P&L from real fills; stale stop/target cleanup; per-symbol lock; duplicate-command guard; one live position per product; SL tick monitor backoff.
- `services/liveEngine/LiveReconciler.js` (new): startup + periodic (no API calls when idle) + on-demand reconciliation with the policy documented in the file header.
- `services/execution/ExecutionRouter.js`: passes the product `contract_value` (+ comment fix).
- `services/TargetExitManager.js`: per-target `filledQuantity` so a retry after a partial fill sells only the shortfall (no effect on PAPER; percentages/confirmation rules unchanged).
- `server.js`: startup reconciliation, periodic timer, timer stop on shutdown.
- `models/Order|Position|Trade.js`, `config/env.js`: additive optional fields / env vars with safe defaults.
- Tests: `tests/liveExecutionSafety.test.js`, `tests/helpers/fakeLiveExchange.js`.

## Behavioural policies to be aware of
- **Circuit breaker:** unknown order state, unprotected-and-unclosable position, exchange exposure larger than local books, orphan exchange position, or Delta auth failure set `liveTradingEnabled=false` (new entries stop; existing positions remain manageable). Re-enable via `/api/safety` after you've reviewed `SystemLog` (category `SAFETY`, "LIVE ALERT").
- **Operator alerts** are `SystemLog` errors (persisted, streamed on `room:logs`). WhatsApp has no safety-alert event today; I did not add one.
- **Whole contracts:** a T1–T3 slice below one contract sends no order (logged); fractional slices are floored and T4 (all remaining) absorbs the remainder. This is an exchange constraint, not a strategy change.
- **One net position per product:** a second live entry on a symbol that already has one is refused.
- Manual live opens without a stop are allowed but flagged `UNPROTECTED` + alert.
- `MODIFY_STOP` for LIVE is still intentionally unimplemented (501).

## Deployment / restart
1. Back up MongoDB (new fields are optional; no migration needed. Existing OPEN live positions have no `exchangeContracts`/`contractValue`; they are handled by fallback to `quantity/contract_value`).
2. Deploy the ZIP over the existing project (keep your `.env`; no variable names changed). Optional new vars: `LIVE_FILL_TIMEOUT_MS` (8000), `LIVE_FILL_POLL_INTERVAL_MS` (400), `LIVE_CLOSE_MAX_ATTEMPTS` (3), `LIVE_RECONCILE_INTERVAL_MS` (60000), `DELTA_BRACKET_SL_ORDER_TYPE` (`market_order`), `DELTA_BRACKET_TRIGGER_METHOD` (`last_traded_price`).
3. `npm install` (unchanged dependencies) then restart the process. On start, check the log for `Startup LIVE reconciliation done`.
4. Keep `LIVE_TRADING_DEFAULT_ENABLED=false` until the manual verification below passes.

## Manual verification (Delta **testnet** first: https://cdn-ind.testnet.deltaex.org, testnet keys, `DELTA_BASE_URL` pointed there)
1. Smallest size (1 contract). Open a LONG via the live controller with a stop ~1% away. Confirm: Order `FILLED` with `fillVerified`, Position `entryPrice` equals Delta's fill, `protectionStatus=PROTECTED`, and a `stop_loss_order` visible in Delta's open orders. **If bracket placement is rejected here, see "Unresolved" #1 before anything else.**
2. Cancel the stop in the Delta UI; wait one reconcile interval; confirm it is restored (single stop, no duplicates).
3. Close manually; confirm exchange flat, Trade row `priceVerified=true`, no stale stop left.
4. Restart the server with a position open; confirm no new orders and state unchanged.
5. Only then repeat with a MODEL_002-generated trigger at minimum size on testnet, then minimal live size.

## Unresolved Delta API details (not guessed)
1. **Bracket leg order type:** the docs reviewed show `stop_loss_order.order_type: "limit_order"` in the sample and describe UI brackets as market-on-trigger, but do not enumerate accepted values for this endpoint. Default here is `market_order` (configurable). If testnet rejects it, set `DELTA_BRACKET_SL_ORDER_TYPE=limit_order` **and** extend the adapter to send a `limit_price` (a limit stop can gap through — decide knowingly).
2. **Bracket verification shape:** protection is verified by finding an open/pending order with `stop_order_type: "stop_loss_order"` on the product (a Delta community answer confirms bracket legs are real orders listed by `GET /v2/orders`; the docs don't show the exact fields). If legs look different on your account every entry will be (safely) emergency-closed — verify in step 1.
3. **Position `size` sign / `entry_price` / `margin`:** only `abs(size)` and `margin` (informational) are used; signs are not relied on. The Position schema was not reviewed field-by-field.
4. **`client_order_id` max length/charset** not documented in the reviewed section; ids are `ord_<uuid>` (existing scheme) or the command id.
5. **Trigger method:** bracket stops trigger on `last_traded_price` by default; Delta's UI doc says mark price. Set `DELTA_BRACKET_TRIGGER_METHOD=mark_price` if preferred.
6. Fees: `paid_commission` is used as reported (settling-asset units); not converted.
