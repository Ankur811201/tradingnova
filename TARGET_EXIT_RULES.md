# NOVA TRADE — Target Exit Rules

- Configure Target Exit only after an OPEN position exists.
- No automatic timeframe switching. The chart and bot remain on the user's selected timeframe.
- T1/T2/T3 share one global 3-candle confirmation window.
- The first T1/T2/T3 touch starts the global window.
- Any additional T1/T2/T3 touched during those three candles joins the same queue.
- At the close of candle 3, all queued T1/T2/T3 percentages are executed together.
- If no T1/T2/T3 target is touched during a window, no exit occurs and the next touch starts a new window.
- A new target touch after the previous window has completed starts a new global 3-candle window.
- T4 is independent: any touch exits all remaining quantity immediately, without waiting for candle close.
- A target line is removed from the live graph after that target executes.
- Only the active trading chart is used; no second target timeframe/chart is created.
- The bot is never paused by target activation or target execution.
- Legacy automatic SL/TP/R-multiple price-trigger exits are disabled. Manual, bot-signal, and safety close commands remain available.
