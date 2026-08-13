/**
 * NOVA TRADE
 * MODEL_002 Full Diagnostic Test
 *
 * READ ONLY
 * Does NOT insert/update/delete MongoDB data.
 */

require('dotenv').config();

const mongoose = require('mongoose');

const INSTANCE_ID =
  process.env.TEST_INSTANCE_ID ||
  'inst_b6fe3224-2234-4ee2-895f-a5235e58f4c9';

const HOURS_BACK = 24;

async function main() {
  console.log('\n========================================');
  console.log(' NOVA TRADE - MODEL_002 FULL TEST');
  console.log('========================================\n');

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing from .env');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  console.log('✅ MongoDB connected\n');

  const db = mongoose.connection.db;

  // ---------------------------------------------------------
  // 1. BOT
  // ---------------------------------------------------------

  console.log('\n[1] BOT INSTANCE');

  const bot = await db.collection('botinstances').findOne({
    instanceId: INSTANCE_ID
  });

  if (!bot) {
    console.log('❌ Bot not found:', INSTANCE_ID);
    return;
  }

  console.log({
    instanceId: bot.instanceId,
    modelId: bot.modelId,
    symbol: bot.symbol,
    status: bot.status,
    environment: bot.environment,
    timeframe:
      bot.parameters?.timeframe ||
      bot.config?.timeframe,
    lastSignalAt: bot.lastSignalAt,
    lastError: bot.lastError
  });

  const symbol = bot.symbol;
  const timeframe =
    bot.parameters?.timeframe ||
    bot.config?.timeframe;

  // ---------------------------------------------------------
  // 2. STRATEGY EVENTS
  // ---------------------------------------------------------

  console.log('\n[2] STRATEGY EVENTS');

  const events = await db.collection('strategyevents')
    .find({ instanceId: INSTANCE_ID })
    .sort({ at: -1 })
    .limit(50)
    .toArray();

  console.log(`Found ${events.length} events`);

  for (const event of events.slice(0, 20)) {
    console.log(
      new Date(event.at).toISOString(),
      '|',
      event.eventType,
      '|',
      event.payload?.decision ||
      event.payload?.action ||
      event.payload?.reason ||
      ''
    );
  }

  // ---------------------------------------------------------
  // 3. DECISION EVENTS
  // ---------------------------------------------------------

  console.log('\n[3] MODEL_002 DECISIONS');

  const decisions = await db.collection('strategyevents')
    .find({
      instanceId: INSTANCE_ID,
      eventType: 'DECISION'
    })
    .sort({ at: -1 })
    .limit(100)
    .toArray();

  console.log(`Decision events: ${decisions.length}`);

  for (const d of decisions.slice(0, 20)) {
    console.log({
      time: d.at,
      decision: d.payload?.decision,
      action: d.payload?.action,
      reason: d.payload?.reason,
      candleTimestamp: d.payload?.candleTimestamp
    });
  }

  // ---------------------------------------------------------
  // 4. DECISION GAP
  // ---------------------------------------------------------

  console.log('\n[4] DECISION GAP TEST');

  const recentDecisions =
    decisions
      .filter(d => d.at)
      .sort((a, b) =>
        new Date(a.at) - new Date(b.at)
      );

  let largestGap = 0;
  let gapFrom = null;
  let gapTo = null;

  for (let i = 1; i < recentDecisions.length; i++) {
    const previous =
      new Date(recentDecisions[i - 1].at);

    const current =
      new Date(recentDecisions[i].at);

    const gap = current - previous;

    if (gap > largestGap) {
      largestGap = gap;
      gapFrom = previous;
      gapTo = current;
    }
  }

  if (largestGap) {
    console.log(
      'Largest decision gap:',
      Math.round(largestGap / 60000),
      'minutes'
    );

    console.log('From:', gapFrom.toISOString());
    console.log('To  :', gapTo.toISOString());

    if (largestGap > 10 * 60 * 1000) {
      console.log('🚨 LARGE DECISION GAP');
    } else {
      console.log('✅ Decision timing looks normal');
    }
  } else {
    console.log('⚠️ Not enough decisions for gap test');
  }

  // ---------------------------------------------------------
  // 5. CANDLES
  // ---------------------------------------------------------

  console.log('\n[5] CANDLE TEST');

  const from =
    new Date(Date.now() - HOURS_BACK * 60 * 60 * 1000);

  const candleQuery = {
    symbol,
    timestamp: {
      $gte: Math.floor(from.getTime() / 1000)
    }
  };

  if (timeframe) {
    candleQuery.timeframe = timeframe;
  }

  const candles = await db.collection('candles')
    .find(candleQuery)
    .sort({ timestamp: 1 })
    .toArray();

  console.log('Symbol:', symbol);
  console.log('Timeframe:', timeframe);
  console.log('Candles:', candles.length);

  if (candles.length) {
    console.log(
      'First:',
      new Date(
        Number(candles[0].timestamp) * 1000
      ).toISOString()
    );

    console.log(
      'Last:',
      new Date(
        Number(candles[candles.length - 1].timestamp) * 1000
      ).toISOString()
    );
  } else {
    console.log('❌ NO CANDLES FOUND');
  }

  // ---------------------------------------------------------
  // 6. CANDLE GAP
  // ---------------------------------------------------------

  console.log('\n[6] CANDLE GAP TEST');

  let candleGaps = [];

  for (let i = 1; i < candles.length; i++) {
    const previous =
      Number(candles[i - 1].timestamp);

    const current =
      Number(candles[i].timestamp);

    const gap = current - previous;

    if (gap > 120) {
      candleGaps.push({
        from: new Date(previous * 1000),
        to: new Date(current * 1000),
        minutes: Math.round(gap / 60)
      });
    }
  }

  if (!candleGaps.length) {
    console.log('✅ No large candle gaps');
  } else {
    console.log(
      `🚨 ${candleGaps.length} candle gaps found`
    );

    console.table(
      candleGaps.slice(-10)
    );
  }

  // ---------------------------------------------------------
  // 7. ORDERS
  // ---------------------------------------------------------

  console.log('\n[7] ORDERS');

  const orders = await db.collection('orders')
    .find({
      $or: [
        { instanceId: INSTANCE_ID },
        { botInstanceId: INSTANCE_ID }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();

  console.log(`Orders: ${orders.length}`);

  for (const order of orders.slice(0, 10)) {
    console.log({
      side: order.side,
      quantity: order.quantity,
      requestedPrice: order.requestedPrice,
      executedPrice: order.executedPrice,
      status: order.status,
      reason: order.reason,
      environment: order.environment
    });
  }

  // ---------------------------------------------------------
  // 8. POSITIONS
  // ---------------------------------------------------------

  console.log('\n[8] POSITIONS');

  const positions = await db.collection('positions')
    .find({
      $or: [
        { instanceId: INSTANCE_ID },
        { botInstanceId: INSTANCE_ID }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  console.log(`Positions: ${positions.length}`);

  for (const position of positions) {
    console.log({
      status: position.status,
      side: position.side,
      entryPrice: position.entryPrice,
      currentPrice: position.currentPrice,
      quantity: position.quantity,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      unrealizedPnl: position.unrealizedPnl,
      realizedPnl: position.realizedPnl
    });
  }

  // ---------------------------------------------------------
  // 9. TRADES
  // ---------------------------------------------------------

  console.log('\n[9] TRADES');

  const trades = await db.collection('trades')
    .find({
      $or: [
        { instanceId: INSTANCE_ID },
        { botInstanceId: INSTANCE_ID }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();

  console.log(`Trades: ${trades.length}`);

  for (const trade of trades.slice(0, 10)) {
    console.log({
      side: trade.side,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      status: trade.status,
      realizedPnl: trade.realizedPnl,
      reason: trade.reason
    });
  }

  // ---------------------------------------------------------
  // 10. FINAL DIAGNOSIS
  // ---------------------------------------------------------

  console.log('\n========================================');
  console.log(' FINAL DIAGNOSIS');
  console.log('========================================');

  console.log(
    'Bot status:',
    bot.status
  );

  console.log(
    'Model:',
    bot.modelId
  );

  console.log(
    'Symbol:',
    symbol
  );

  console.log(
    'Timeframe:',
    timeframe
  );

  console.log(
    'Candles:',
    candles.length
  );

  console.log(
    'Decisions:',
    decisions.length
  );

  console.log(
    'Orders:',
    orders.length
  );

  console.log(
    'Positions:',
    positions.length
  );

  console.log(
    'Trades:',
    trades.length
  );

  console.log(
    'Last error:',
    bot.lastError || 'NONE'
  );

  console.log('\n----------------------------------------');

  if (bot.status === 'ERROR') {
    console.log('❌ BOT IS IN ERROR STATE');
  } else if (!candles.length) {
    console.log('❌ MARKET DATA / CANDLE PIPELINE PROBLEM');
  } else if (!decisions.length) {
    console.log('❌ MODEL_002 IS NOT PRODUCING DECISIONS');
  } else if (largestGap > 10 * 60 * 1000) {
    console.log('⚠️ DECISION PIPELINE HAS A LARGE GAP');
  } else {
    console.log('✅ BASIC MODEL_002 PIPELINE LOOKS HEALTHY');
  }

  console.log('========================================\n');
}

main()
  .catch(err => {
    console.error('\n❌ TEST FAILED');
    console.error(err);
  })
  .finally(async () => {
    await mongoose.disconnect();
  });