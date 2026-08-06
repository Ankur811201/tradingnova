# Bot Models

This directory holds pluggable trading-strategy implementations ("Bot Models").
Part 1 ships **no strategy logic** here — only the contract Part 3's Model 001
must implement.

## Contract

Extend `BotModelBase` (see `BotModelBase.js`):

```js
const BotModelBase = require('./BotModelBase');

class Model001 extends BotModelBase {
  async onStart(instanceConfig) {
    // one-time setup per bot instance
  }

  async onMarketData(marketUpdate, positionContext) {
    // strategy logic lives here — pattern detection, entries, exits.
    // Call this.submitTradeCommand({...}) to request a trade.
    // Call this.emitStrategyEvent(...) for playback/audit visibility.
  }

  async onPause() {}
  async onStop() {}
}

module.exports = {
  modelId: 'model-001',
  modelVersion: '1.0.0',
  create: (ctx) => new Model001(ctx),
};
```

## Registration

Drop a folder under `bot-models/<model-id>/index.js` exporting
`{ modelId, modelVersion, create }`. `BotManager.discoverModels()` (Part 1)
scans this directory at startup and registers metadata in `BotModelMetadata`.

## Rules enforced by the platform (not by the model itself)

- A Bot Model never receives Delta credentials.
- A Bot Model never writes to MongoDB directly.
- A Bot Model never calls PaperEngine/LiveEngine/Delta directly.
- Every `TradeCommand` is validated (`TradeCommandSchema.js`), then routed
  through `BotManager -> RiskEngine -> ExecutionRouter -> Paper/LiveEngine`.
- `commandId` must be unique per logical signal — RiskEngine uses it (plus a
  time window) to reject duplicate signals.
