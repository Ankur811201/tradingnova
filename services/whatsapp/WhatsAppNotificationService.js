'use strict';
const WhatsAppSetting = require('../../models/WhatsAppSetting');
const BotInstance = require('../../models/BotInstance');
const Position = require('../../models/Position');
const client = require('./WhatsAppClient');

const BASE_URL = 'https://tradingnova.online';

const enabledKey = {
  LAYER_TOUCH: 'layerTouch',
  TRADE_OPEN: 'tradeOpen',
  TARGET_1_EXIT: 'target1Exit',
  TARGET_2_EXIT: 'target2Exit',
  TARGET_3_EXIT: 'target3Exit',
  STOP_LOSS: 'stopLoss',
  TRADE_CLOSED: 'tradeClosed',
};

function fmt(n, digits = 2) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(digits) : '—';
}

function lots(q) {
  const x = Number(q);
  return Number.isFinite(x) ? (x / 0.001).toFixed(2).replace(/\.00$/, '') : '—';
}

function btc(q) {
  const x = Number(q);
  return Number.isFinite(x) ? x.toFixed(3) : '—';
}

function pct(n) {
  const x = Number(n);
  return Number.isFinite(x) ? `${fmt(x, 2)}%` : '—';
}

function botLink(instanceId) {
  return instanceId ? `${BASE_URL}/bots/${encodeURIComponent(instanceId)}` : `${BASE_URL}/bots`;
}

function trendLabel(trend) {
  const t = String(trend || '').toUpperCase();
  return t === 'BULLISH' ? '🟢 BULLISH' : t === 'BEARISH' ? '🔴 BEARISH' : '—';
}

function targetLines(targets) {
  if (!Array.isArray(targets) || !targets.length) return [];
  return targets.slice(0, 4).map((t, i) => {
    const price = typeof t === 'object' ? t.price : t;
    const label = `T${i + 1}`;
    return `${label}: ${fmt(price)}`;
  });
}

async function resolveContext(data = {}) {
  let bot = null;
  let position = null;

  try {
    if (data.instanceId) {
      bot = await BotInstance.findOne({ instanceId: data.instanceId }).lean();
      position = await Position.findOne({ instanceId: data.instanceId })
        .sort({ updatedAt: -1, openedAt: -1 })
        .lean();
    }
  } catch (_) {
    // WhatsApp must never affect trading if Mongo context lookup fails.
  }

  const params = bot?.parameters || {};
  const targetExit = position?.targetExit || null;
  const targets = data.targets || targetExit?.targets || bot?.targets || [];

  return {
    bot,
    position,
    trend: data.trend || params.trend,
    timeframe: data.timeframe || params.timeframe,
    leverage: data.leverage ?? bot?.leverage ?? position?.leverage,
    targets,
  };
}

function commonHeader(eventTitle, data, ctx) {
  const bot = ctx.bot || {};
  return [
    `🤖 ${bot.name || data.botName || 'NOVA TRADE BOT'}`,
    `📦 Model: ${bot.modelId || data.modelId || '—'}${bot.modelVersion || data.modelVersion ? ` v${bot.modelVersion || data.modelVersion}` : ''}`,
    `💱 ${data.symbol || bot.symbol || ctx.position?.symbol || '—'} · ${data.environment || bot.environment || ctx.position?.environment || '—'}`,
    `📊 Trend: ${trendLabel(ctx.trend)}`,
    `⏱ Timeframe: ${ctx.timeframe || '—'}`,
    eventTitle,
  ];
}

async function notify(event, data = {}) {
  try {
    const setting = await WhatsAppSetting.getSingleton();
    const key = enabledKey[event];
    if (!key || !setting.enabled?.[key] || !setting.recipient) return { sent: false, reason: 'disabled' };

    const ctx = await resolveContext(data);
    const bot = ctx.bot || {};
    const position = ctx.position || {};
    const symbol = data.symbol || bot.symbol || position.symbol || '—';
    const side = data.side || position.side || '—';
    const quantity = data.quantity ?? position.originalQuantity ?? position.quantity;
    const stopLoss = data.stopLoss ?? position.stopLoss;
    const leverage = data.leverage ?? ctx.leverage;
    const targets = ctx.targets;

    const lines = ['NOVA TRADE', ''];

    if (event === 'LAYER_TOUCH') {
      lines.push(...commonHeader(`🔔 LEVEL TOUCH — ${data.level || 'LEVEL'}`, data, ctx));
      lines.push(`💰 Price: ${fmt(data.price)}`);
      lines.push('', `🔗 Open Bot: ${botLink(data.instanceId)}`);
    }

    if (event === 'TRADE_OPEN') {
      lines.push(...commonHeader('🟢 TRADE OPEN', data, ctx));
      lines.push(`📈 Direction: ${side}`);
      lines.push(`💰 Entry: ${fmt(data.entryPrice ?? position.entryPrice)}`);
      lines.push(`🛑 Stop Loss: ${fmt(stopLoss)}`);
      lines.push(`📦 Quantity: ${lots(quantity)} LOT · ${btc(quantity)} BTC`);
      lines.push(`⚡ Leverage: ${Number.isFinite(Number(leverage)) ? `${fmt(leverage, 0)}x` : '—'}`);
      if (targetLines(targets).length) lines.push('', '🎯 Targets', ...targetLines(targets));
      lines.push('', `🔗 Open Bot: ${botLink(data.instanceId)}`);
    }

    if (/^TARGET_[123]_EXIT$/.test(event)) {
      const targetNumber = event.match(/^TARGET_(\d)_EXIT$/)?.[1] || '?';
      const remaining = data.remainingQuantity ?? position.quantity;
      lines.push(...commonHeader(`🎯 TARGET ${targetNumber} EXIT`, data, ctx));
      lines.push(`📈 Direction: ${side}`);
      lines.push(`🎯 Target: T${targetNumber}`);
      lines.push(`💰 Exit Price: ${fmt(data.price)}`);
      lines.push(`📦 Closed: ${lots(quantity)} LOT · ${btc(quantity)} BTC`);
      lines.push(`📊 Remaining: ${lots(remaining)} LOT · ${btc(remaining)} BTC`);
      lines.push(`💵 Realized P&L: ${fmt(data.realizedPnl)}`);
      lines.push(`📉 Closed: ${pct(data.exitPercent)}`);
      lines.push('', `🔗 Open Bot: ${botLink(data.instanceId)}`);
    }

    if (event === 'STOP_LOSS') {
      lines.push(...commonHeader('🛑 STOP LOSS', data, ctx));
      lines.push(`📈 Direction: ${side}`);
      lines.push(`💰 Entry: ${fmt(position.entryPrice)}`);
      lines.push(`🛑 SL: ${fmt(stopLoss)}`);
      lines.push(`📉 Exit: ${fmt(data.price)}`);
      lines.push(`📦 Closed: ${lots(quantity)} LOT · ${btc(quantity)} BTC`);
      lines.push(`💵 Realized P&L: ${fmt(data.realizedPnl ?? position.realizedPnl)}`);
      lines.push('', `🔗 Open Bot: ${botLink(data.instanceId)}`);
    }

    if (event === 'TRADE_CLOSED') {
      lines.push(...commonHeader('⚪ POSITION CLOSED', data, ctx));
      lines.push(`📈 Direction: ${side}`);
      lines.push(`💰 Entry: ${fmt(position.entryPrice)}`);
      lines.push(`💰 Exit: ${fmt(data.exitPrice ?? position.currentPrice)}`);
      lines.push(`📦 Closed: ${lots(quantity)} LOT · ${btc(quantity)} BTC`);
      lines.push(`💵 Total Realized P&L: ${fmt(data.realizedPnl ?? position.realizedPnl)}`);
      if (position.openedAt && position.closedAt) {
        const seconds = Math.max(0, (new Date(position.closedAt) - new Date(position.openedAt)) / 1000);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        lines.push(`⏱ Duration: ${h ? `${h}h ` : ''}${m}m ${s}s`);
      }
      lines.push('', `🔗 Open Bot: ${botLink(data.instanceId)}`);
    }

    await client.sendText(setting.recipient, lines.join('\n'));
    return { sent: true };
  } catch (err) {
    // Notification errors must never stop or fail a trade.
    return { sent: false, error: err.message };
  }
}

module.exports = { notify, botLink };
