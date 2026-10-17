# NOVA TRADE — Live execution audit: CHANGES

Date: 2026-10-17 · Scope: live order execution, fills, stop-loss, exits, reconciliation.
Verification level: **code-level only** (mock-based tests). Nothing was run against a real or testnet Delta account.

---

## 1. What was already correct (kept as-is)

| Area | Why it is correct |
|---|---|
| `ExecutionRouter` environment routing | Routes strictly on `command.environment`, throws on unknown values, never falls back from LIVE to PAPER. |
| `DeltaAdapter` signing and headers | HMAC prehash `method + timestamp + path + query + body`, `api-key`/`signature`/`timestamp`/`User-Agent` headers match Delta's docs. Secrets are never logged or returned. |
| `DeltaAdapter` endpoints | `getOrderById`, `getOrderByClientOrderId`, `cancelOrder`, `getActiveOrders`, `getPosition(s)` and `reduce_only` on closes all exist in Delta's docs. I reused them rather than adding guesses. |
| Live gating | `LiveEngine` still checks Delta is configured and the global `liveTradingEnabled` switch before any entry. `SafetyService` still requires the `CONFIRM` phrase. |
| `TargetExitManager` claim logic | Atomic `findOneAndUpdate` to `EXECUTING`, reset on failure, T4 = all remaining, T1–T3 3-candle confirmation. Rules and percentages are unchanged. |
| Schemas | `commandId` index, `PARTIALLY_FILLED` status and `originalQuantity` already existed, so they fit the new lifecycle. |
| `MODIFY_STOP` for LIVE | Deliberately returns 501 instead of silently pretending a trailing stop works. Kept. |
| MODEL_002, PaperEngine, RiskEngine, TradeCommandSchema | **Byte-identical** to your ZIP (directory diff). I did not audit the strategy's correctness, only that it was not changed. |

## 2. What was wrong, what I fixed, and why

| # | Problem (original location) | Fix | Why it matters |
|---|---|---|---|
| 1 | **Wrong order size.** `size: quantity` sent BTC (e.g. 0.01) to Delta, whose `size` is an integer number of contracts (`contract_value` 0.001). (LiveEngine:79) | `ExecutionRouter` passes the product's `contract_value`; `LiveEngine` converts to whole contracts and refuses non-whole sizes instead of rounding. | A MODEL_002 trigger could not place the correct order. Rounding silently would change risk. |
| 2 | **No exchange-side stop-loss** (`stopLossOrder: null`, LiveEngine:83). Protection depended on the local tick loop. | After the fill, place a stop with Delta's bracket endpoint (`POST /v2/orders/bracket`), then verify it appears as an open `stop_loss_order`. Idempotent: an existing matching stop is reused, never duplicated. | If the server, feed or network dies, the position is still protected on the exchange. |
| 3 | **Accepted treated as filled.** Position was created OPEN regardless of fill. (LiveEngine:94-121) | Fill quantity and average price come only from the exchange order (`size`, `unfilled_size`, `average_fill_price`, `state`). No fill → no position. Partial fill → position sized to the actual fill. | Local books must match real exposure. |
| 4 | **Fabricated entry price** (`limit_price` is null on market orders → entry 0). (LiveEngine:95,113) | Entry price = exchange average fill price; contradictory or missing data is classified UNKNOWN and never guessed. | A 0 or guessed price corrupts P&L, targets (R-multiples) and stop logic. |
| 5 | **Closes marked CLOSED before confirmation**; exit price from `limit_price`/stale price; fees 0. (LiveEngine:159-170, 245-256) | Closes are reduce-only, sized from the real exchange position, retried only for the shortfall, and a position is CLOSED only after the exchange confirms. P&L uses real fills and `paid_commission`. | Prevents "closed locally, still exposed" and wrong P&L. |
| 6 | **Timeout ambiguity.** A timeout looked like a plain failure. (DeltaAdapter `_request`) | Timeouts/5xx are flagged `ambiguous`; the order is looked up by `client_order_id` and never blindly resubmitted. Unresolvable → order marked UNKNOWN, live trading disabled, reconciliation kicked. | A blind retry after an accepted order doubles exposure. |
| 7 | **No idempotency.** Duplicate command or exit events could send a second order; closes had no lock. | Duplicate-command guard, per-symbol entry lock, one live position per product, atomic `closeInFlight` claim, and backoff for the stop-loss tick monitor after failures. | Repeated events must not double-trade. |
| 8 | **`originalQuantity` never set for live**, so T2/T3 were sized off the remaining quantity. | Set at entry to the filled quantity; `TargetExitManager` tracks per-target `filledQuantity` so retries sell only the shortfall (no effect on PAPER). | Keeps the existing 25%-of-original rule true on live. |
| 9 | **`syncPositions` overwrote local `realizedPnl`/`currentPrice`**, no stop/order/orphan checks, no live startup recovery. (LiveEngine:295-319, server.js) | New `LiveReconciler`: startup + 60s periodic (no API calls when idle) + on demand. Policy: exchange flat → close locally (verified only if the stop fill is found, else flagged UNVERIFIED); exchange larger → flag, do not overwrite, disable live; exchange smaller → adopt (risk-reducing) and flag; orphan → alert only; missing stop → restore or emergency close; UNKNOWN entry later found filled → adopt and protect. | Never silently overwrites important state; recovery cannot create duplicate orders. |
| 10 | Misleading comment in `ExecutionRouter` claimed a stop was placed at entry. | Comment corrected. | It described behaviour that did not exist. |
| 11 | Models/config. | Additive optional fields on `Order`, `Position`, `Trade` and new env vars, all with safe defaults. | No migration; PAPER unaffected. |

## 3. Behaviours you should know about
- **Circuit breaker:** unknown order state, an unclosable unprotected position, exposure above local books, an orphan exchange position, or an auth failure turns `liveTradingEnabled` off. Re-enable via `/api/safety`.
- **Alerts** are `SystemLog` errors ("LIVE ALERT"), streamed on `room:logs`. No WhatsApp alert event exists for this.
- **Whole contracts:** a T1–T3 slice under one contract sends no order (logged); fractions are floored and T4 absorbs the remainder.
- Manual live opens without a stop are allowed but flagged `UNPROTECTED`.

## 4. Tests
- New: `tests/liveExecutionSafety.test.js` — 34 tests, all passing, covering the 16 requested scenarios. Mutation check: three deliberately broken safety behaviours were each caught.
- Full suite: 755 tests → 628 pass, 63 fail, 64 skipped. The 63 failures are identical to the baseline before my changes (e.g. missing `data/fake-candles.json`).
- **Blocked:** MongoDB-backed tests (including paper integration) skip here — no `mongod` in the sandbox. Run them on your machine.

## 5. Not verified (do before live money)
1. Accepted `order_type` for the bracket stop-loss leg (default `market_order`, configurable via `DELTA_BRACKET_SL_ORDER_TYPE`).
2. That bracket legs appear in `GET /v2/orders` with `stop_order_type: "stop_loss_order"` on your account (confirmed only by a community answer). If not, every entry is safely emergency-closed.
3. `client_order_id` length/charset limits; Position schema fields beyond `size`/`margin`; trigger method (`last_traded_price` default vs mark price).
4. Late-adopted fills lose `entryLevelKey` (the order record does not store it).

Start with 1 contract on Delta testnet — steps are in `LIVE_EXECUTION_SAFETY.md`.
