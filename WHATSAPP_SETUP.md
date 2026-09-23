# Nova Trade WhatsApp Notifications

WhatsApp runs on the Node.js server using Baileys. The browser only displays the QR/status/settings page.

## Install

```bash
npm install
npm run dev
```

Do not use `npm ci` until a lockfile is generated in your deployment environment.

## First connection

1. Open `/whatsapp` in Nova Trade.
2. Wait for the QR code.
3. On the phone: WhatsApp -> Linked devices -> Link a device.
4. Scan the QR.
5. The server saves the session under `data/whatsapp-auth/` by default.

The browser can be closed after pairing. The Node.js process/PM2 keeps the WhatsApp connection alive.

## Optional persistent auth path

Set `WA_AUTH_DIR` to a persistent VPS path, for example:

```env
WA_AUTH_DIR=/home/tradingn/tradingapp/nove-trade/data/whatsapp-auth
```

## Notifications

The WhatsApp page controls these backend events:

- Layer Touch
- Trade Open
- Target 1 Exit
- Target 2 Exit
- Target 3 Exit
- Stop Loss
- Trade Closed

Trading does not depend on WhatsApp. If WhatsApp is disconnected, the trading engine continues normally.

## WhatsApp message details update

WhatsApp notifications now include bot name, model/version, environment, symbol, user-provided MODEL_002 trend (BULLISH/BEARISH), timeframe, direction, entry/exit price, stop loss, leverage, actual quantity/lots, target prices when available, realized P&L, remaining quantity for partial target exits, and a direct bot-detail link.

Direct bot link format:
`https://tradingnova.online/bots/<instanceId>`

The notification service only enriches messages with database context; notification lookup/send failures are isolated and never fail a trade.
