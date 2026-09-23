# Bot Models — Current Build

**MODEL_001** is retained and registered for compatibility. **MODEL_002** is the current strategy model.

## MODEL_002 contract

- User-provided trend: `BULLISH` / `BEARISH`
- Exactly 3 Support levels: S1/S2/S3
- Exactly 3 Resistance levels: R1/R2/R3
- Timeframe: 1m or 3m
- No EMA/Daily BOS/1H confirmation/automatic trend detection
- A/B/C fixed-boundary pattern engine
- Generic RiskEngine and ExecutionRouter remain outside the model

## Safety

Each entry is attributed to the Support/Resistance level that created it. Each level allows at most 2 losing completed trades. T1/T2/T3 partial exits do not count. T4 is the final successful close and stops the bot after the first success. Stop-loss is the final loss event and increments the entry level's counter.

## Runtime flow

```text
MODEL_002 → TradeCommand → RiskEngine → ExecutionRouter → Paper/Live
```

The model does not open a new position while one is already open.
