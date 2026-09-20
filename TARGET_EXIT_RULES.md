# NOVA TRADE — Target Exit Rules

- Configure Target Exit only after an OPEN position exists.
- No automatic timeframe switching. The chart and bot remain on the user's selected timeframe.
- T1/T2/T3 each have an independent 3-candle confirmation flow.
- A target starts its own flow when that target is newly touched.
- Multiple targets may be confirming at the same time; each keeps its own CT1/CT2/CT3 state.
- Confirmation uses the bot's canonical closed-candle stream; Target Exit does not build a second candle stream.
- At CT3 close, that target's configured percentage is executed.
- T4 is independent: any touch exits all remaining quantity immediately, without waiting for candle close.
- T1/T2/T3 percentages are freely configurable but their sum must be < 100%; T4 automatically receives the remaining percentage.
- Target prices must be ahead of the current price at activation: LONG T1 > current price; SHORT T1 < current price.
- Target price order is directional: LONG T1 < T2 < T3 < T4; SHORT T1 > T2 > T3 > T4.
- A target line is removed from the live graph after that target executes.
- Only the active trading chart is used; no second target timeframe/chart is created.
- The bot is never paused by target activation or target execution.
- Legacy automatic SL/TP/R-multiple price-trigger exits are disabled. Manual, bot-signal, and safety close commands remain available.
