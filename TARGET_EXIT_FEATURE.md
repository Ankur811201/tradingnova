# NOVA TRADE — Position-Level 4-Target Exit

The 4-target exit form lives only below Control Center on Bot Details. It is
available only while an OPEN position exists and can be submitted without
pausing the running bot.

Rules:
- T1/T2/T3: price touch arms the target; the next eligible 3-minute candle
  close executes every armed target's configured percentage. Close location
  relative to the target does not matter.
- T4: price touch immediately closes all remaining quantity.
- T1-T3 percentages are based on the position quantity at target-plan
  activation. T4 is the calculated remainder.
- Targets must be ordered upward for LONG and downward for SHORT.
- Activating the plan changes the bot's active execution timeframe to 3m
  without stopping or pausing it. The previous active timeframe is restored
  after the position closes.
- Legacy PaperEngine tick-based SL/TP/R-multiple auto-exits are disabled.
- Live Delta entry orders do not attach automatic SL/TP conditional orders.
- Target execution uses reduce-only orders in LIVE mode.
- Target states are persisted on the Position document to survive process
  restarts.
