# MODEL_002 STOP HUNT trade-history gate

- Added persisted `parameters.tradeOccurredBeforeStopHunt`.
- When a normal MODEL_002 trade command is approved, the model latches the flag and emits `MODEL002_TRADE_OCCURRED`; BotManager persists the flag in `BotInstance.parameters`.
- `_computeIsOppositeStopHuntPattern()` now permits the one-time opposite S1/R1 simulated STOP HUNT only when no prior trade was accepted and the existing stop-hunt-used/active checks are clear.
- If a prior trade was accepted, an eligible later opposite S1/R1 pattern continues through the existing normal trade flow.
- Existing stop-hunt lifecycle, candle validations, and level safety are unchanged.
- Added regression test: prior accepted trade disables STOP HUNT and routes the S1/R1 setup as a normal trade.

Validation: `node --check` passed for Model002.js, BotManager.js, and config.js. `node --test tests/model002.oppositeStopHunt.test.js`: 5 passed, 0 failed. The environment logs that `mongoose` is unavailable for optional log persistence; it did not fail these tests.
