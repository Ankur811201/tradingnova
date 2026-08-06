/* global window, document, NovaApi, NovaUI, NovaFormat, NovaSocket */
(function () {
  'use strict';

  const { formatUsd, formatPnl, formatTime, escapeHtml } = NovaFormat;

  function renderPaperStats(portfolio) {
    document.getElementById('stAvailable').textContent = formatUsd(portfolio.availableBalance);
    document.getElementById('stEquity').textContent = formatUsd(portfolio.equity);
    const realized = formatPnl(portfolio.totalRealizedPnl);
    const unrealized = formatPnl(portfolio.unrealizedPnl);
    const rEl = document.getElementById('stRealized');
    rEl.textContent = realized.text; rEl.className = 'stat-value ' + realized.cls;
    const uEl = document.getElementById('stUnrealized');
    uEl.textContent = unrealized.text; uEl.className = 'stat-value ' + unrealized.cls;
    renderPositions(portfolio.openPositions || []);
  }

  function renderPaperUnavailable() {
    ['stAvailable', 'stEquity', 'stRealized', 'stUnrealized'].forEach((id) => {
      document.getElementById(id).textContent = 'No data yet';
    });
  }

  function renderPositions(positions) {
    const body = document.getElementById('positionsBody');
    if (!positions.length) {
      body.innerHTML = '<tr><td colspan="7"><div class="empty-state">No open positions</div></td></tr>';
      return;
    }
    body.innerHTML = positions.map((p) => {
      const pnl = formatPnl(p.unrealizedPnl);
      return '<tr>' +
        '<td>' + escapeHtml(p.symbol) + '</td>' +
        '<td>' + NovaFormat.sideBadge(p.side) + '</td>' +
        '<td>' + formatUsd(p.entryPrice) + '</td>' +
        '<td>' + formatUsd(p.currentPrice) + '</td>' +
        '<td>' + NovaFormat.formatNumber(p.quantity) + '</td>' +
        '<td>' + p.leverage + 'x</td>' +
        '<td class="' + pnl.cls + '">' + pnl.text + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderOrders(orders) {
    const body = document.getElementById('ordersBody');
    if (!orders.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty-state">No orders yet</div></td></tr>';
      return;
    }
    body.innerHTML = orders.map((o) => (
      '<tr>' +
      '<td>' + escapeHtml(o.symbol) + '</td>' +
      '<td>' + NovaFormat.envBadge(o.environment) + '</td>' +
      '<td>' + NovaFormat.sideBadge(o.side) + '</td>' +
      '<td>' + NovaFormat.statusBadge(o.status) + '</td>' +
      '<td>' + formatTime(o.createdAt) + '</td>' +
      '</tr>'
    )).join('');
  }

  function renderEvents(events) {
    const body = document.getElementById('eventsBody');
    if (!events.length) {
      body.innerHTML = '<tr><td colspan="3"><div class="empty-state">No bot activity yet</div></td></tr>';
      return;
    }
    body.innerHTML = events.map((e) => (
      '<tr>' +
      '<td class="mono text-sm">' + escapeHtml(e.instanceId) + '</td>' +
      '<td>' + escapeHtml(e.eventType) + '</td>' +
      '<td>' + formatTime(e.at) + '</td>' +
      '</tr>'
    )).join('');
  }

  function renderSystem(health) {
    const md = health.marketData;
    document.getElementById('stMarketData').innerHTML = md.configured
      ? (md.connected ? '<span class="badge badge-positive">Connected</span>' : '<span class="badge badge-warning">Configured, not connected</span>')
      : '<span class="badge badge-neutral">Not configured</span>';

    document.getElementById('stDelta').innerHTML = health.delta.configured
      ? '<span class="badge badge-positive">Configured</span>'
      : '<span class="badge badge-neutral">Not configured</span>';

    document.getElementById('stLiveTrading').innerHTML = health.liveTradingEnabled
      ? '<span class="badge badge-live">Enabled</span>'
      : '<span class="badge badge-neutral">Disabled</span>';

    document.getElementById('stRunningBots').textContent = health.botManager.liveInstanceCount;
  }

  async function loadAll() {
    try {
      const portfolio = await NovaApi.get('/api/portfolio/paper');
      renderPaperStats(portfolio);
    } catch (_err) {
      renderPaperUnavailable();
      renderPositions([]);
    }

    try {
      const health = await NovaApi.get('/api/health');
      renderSystem(health);
    } catch (_err) {
      NovaUI.toast('Could not load system status', 'error');
    }

    try {
      const ordersResp = await NovaApi.get('/api/orders?limit=8');
      renderOrders(ordersResp.orders || []);
    } catch (_err) {
      renderOrders([]);
    }

    try {
      const events = await NovaApi.get('/api/logs/strategy-events?limit=8');
      renderEvents(events || []);
    } catch (_err) {
      renderEvents([]);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadAll();

    NovaSocket.on('paper:portfolio', (portfolio) => renderPaperStats(portfolio));
    NovaSocket.on('market:status', () => { /* re-check system status lazily */ });
    NovaSocket.on('bot:event', () => {
      NovaApi.get('/api/logs/strategy-events?limit=8').then(renderEvents).catch(() => {});
    });
    NovaSocket.on('order:update', () => {
      NovaApi.get('/api/orders?limit=8').then((r) => renderOrders(r.orders || [])).catch(() => {});
    });

    setInterval(loadAll, 30000);
  });
})();
