# NOVA TRADE — Target Exit Rules

- Configure Target Exit only after an OPEN position exists.
- No automatic timeframe switching. The chart and bot remain on the user's selected timeframe.
- Each T1/T2/T3 has its own simple 3-candle confirmation sequence.
- The candle in which a target is touched closes as CT1.
- The next candle close is CT2.
- The following candle close is CT3, then that target's configured percentage is exited.
- Targets are independent: T1, T2 and T3 can be confirming at the same time without sharing a window.
- T4 is independent: any touch exits all remaining quantity immediately, without waiting for candle close.
- T1/T2/T3 percentages are freely configurable but their sum must be < 100%; T4 automatically receives the remaining percentage.
- Target prices must be ahead of the current price at activation: LONG T1 > current price; SHORT T1 < current price.
- Target price order is directional: LONG T1 < T2 < T3 < T4; SHORT T1 > T2 > T3 > T4.
- A target line is removed from the live graph after that target executes.
- Only the active trading chart is used; no second target timeframe/chart is created.
- The bot is never paused by target activation or target execution.
- Legacy automatic SL/TP/R-multiple price-trigger exits are disabled. Manual, bot-signal, and safety close commands remain available.
