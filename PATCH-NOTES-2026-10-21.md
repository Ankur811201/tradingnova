# MODEL_002 and Target Exit patch notes — 2026-10-21

This patch continues from `NOVA-TRADE-MODEL002-WICK-LEVEL-ATTRIBUTION-FIX-2026-10-21.zip`.

## Changes
- Target-exit `TARGET_EXIT` events for T1–T4 are written with atomic MongoDB updates to `targetExit.events`; the code no longer relies on mutating the nested array of a Mongoose `Mixed` field and calling `save()`.
- Confirmed T1–T3 exits are persisted/emitted even when a later target in the same batch fails, and history can still be appended if the position becomes CLOSED after a confirmed partial fill.
- T1–T4 exit markers carry `positionId` and a candle-aligned `candleStart` fallback. Historical chart loading supplies the parent position ID for older events.
- Invalid/non-positive target execution prices are rejected by the chart marker builder instead of producing NaN markers.
- MODEL_002 retry touches are consumed for one candle only, preventing stale touch labels from being retried indefinitely.
- LayerSafety now distinguishes a global safety stop, an unresolved entry level, and a per-level loss limit; blocked-decision payloads include gate scope and selected level.
- Added regression tests for the entry-gate reason distinction and invalid chart prices.

## Verification
- JavaScript syntax checks passed for the edited backend/frontend files.
- Focused tests passed: 20/20 across `model002.layerSafety.test.js`, `targetExit.flow.pure.test.js`, and `targetExitGraphDisplay.test.js`.
- Full `npm test`: 550 passed, 115 failed. This environment has no installed `mongoose`/`axios`, and the ZIP lacks `data/fake-candles.json`; there is also an existing `targetExit.feature.test.js` section-order assertion failure. These are not represented as passing.
- MongoDB integration, replica-set transaction behavior, Delta live execution, and production chart refresh/reload remain unverified here. Do not deploy to live trading without testing in the actual environment.
