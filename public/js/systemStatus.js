/* global window, document, NovaApi, NovaFormat, NovaSocket */
(function () {
  'use strict';

  const { escapeHtml, formatTime } = NovaFormat;

  function row(label, desc, statusHtml) {
    return '<div class="status-row"><div><div class="label">' + escapeHtml(label) + '</div>' +
      (desc ? '<div class="desc">' + escapeHtml(desc) + '</div>' : '') + '</div>' + statusHtml + '</div>';
  }

  function badge(ok, onText, offText) {
    return ok
      ? '<span class="badge badge-positive">' + onText + '</span>'
      : '<span class="badge badge-neutral">' + offText + '</span>';
  }

  async function loadFreshness() {
    try {
      const settings = await NovaApi.get('/api/settings');
      const symbols = settings.allowedSymbols || [];
      if (!symbols.length) return { checked: false };
      const results = await Promise.all(symbols.map((s) =>
        NovaApi.get('/api/market/fresh/' + encodeURIComponent(s)).catch(() => ({ symbol: s, fresh: false }))
      ));
      const allFresh = results.every((r) => r.fresh);
      const anyFresh = results.some((r) => r.fresh);
      return { checked: true, allFresh, anyFresh, results };
    } catch (_err) {
      return { checked: false };
    }
  }

  async function load() {
    const list = document.getElementById('statusList');
    let health;
    try {
      health = await NovaApi.get('/api/health');
    } catch (_err) {
      list.innerHTML = row('Server', '', '<span class="badge badge-error">Unreachable</span>');
      return;
    }

    const freshness = await loadFreshness();
    let freshnessHtml;
    if (!freshness.checked) freshnessHtml = badge(false, 'FRESH', 'UNAVAILABLE');
    else if (freshness.allFresh) freshnessHtml = '<span class="badge badge-positive">FRESH</span>';
    else if (freshness.anyFresh) freshnessHtml = '<span class="badge badge-warning">PARTIALLY STALE</span>';
    else freshnessHtml = '<span class="badge badge-error">STALE</span>';

    list.innerHTML =
      row('Server', 'Environment: ' + health.server.env + ' · Uptime: ' + Math.floor(health.server.uptimeSeconds) + 's', badge(health.server.status === 'ok', 'CONNECTED', 'DISCONNECTED')) +
      row('MongoDB', health.database.state, badge(health.database.connected, 'CONNECTED', 'DISCONNECTED')) +
      row('Market Data Provider', health.marketData.providerName || 'none', badge(health.marketData.connected, 'CONNECTED', 'DISCONNECTED')) +
      row('Market Data Freshness', freshness.checked ? '' : 'No symbols configured', freshnessHtml) +
      row('Delta Exchange — Configured', 'API credentials present in server config', badge(health.delta.configured, 'CONFIGURED', 'NOT CONFIGURED')) +
      row('Delta Exchange — Authenticated', health.delta.configured ? 'Verified via a live private API call' : 'Not checked — not configured', health.delta.configured ? badge(health.delta.authenticated, 'AUTHENTICATED', 'AUTH FAILED') : '<span class="badge badge-neutral">UNAVAILABLE</span>') +
      row('Live Trading', '', health.liveTradingEnabled ? '<span class="badge badge-live">ENABLED</span>' : '<span class="badge badge-neutral">DISABLED</span>') +
      row('Bot Manager', 'Registered models: ' + health.botManager.registeredModels.length + ' · Running instances: ' + health.botManager.liveInstanceCount, badge(true, 'AVAILABLE', 'UNAVAILABLE')) +
      row('Socket.IO', '', '<span class="badge badge-neutral" id="socketStatusBadge">CHECKING…</span>');

    NovaSocket.on('connect', () => {
      const el = document.getElementById('socketStatusBadge');
      if (el) { el.textContent = 'CONNECTED'; el.className = 'badge badge-positive'; }
    });
    NovaSocket.on('disconnect', () => {
      const el = document.getElementById('socketStatusBadge');
      if (el) { el.textContent = 'DISCONNECTED'; el.className = 'badge badge-error'; }
    });
  }

  async function loadLogs() {
    const body = document.getElementById('logsBody');
    try {
      const logs = await NovaApi.get('/api/logs/system?limit=25');
      if (!logs.length) {
        body.innerHTML = '<tr><td colspan="4"><div class="empty-state">No logs yet</div></td></tr>';
        return;
      }
      body.innerHTML = logs.map((l) => (
        '<tr>' +
        '<td><span class="badge ' + (l.level === 'error' ? 'badge-error' : l.level === 'warn' ? 'badge-warning' : 'badge-neutral') + '">' + escapeHtml(l.level) + '</span></td>' +
        '<td class="text-sm">' + escapeHtml(l.category) + '</td>' +
        '<td class="text-sm">' + escapeHtml(l.message) + '</td>' +
        '<td>' + formatTime(l.at) + '</td>' +
        '</tr>'
      )).join('');
    } catch (_err) {
      body.innerHTML = '<tr><td colspan="4"><div class="empty-state">Unable to load logs</div></td></tr>';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    load();
    loadLogs();
    NovaSocket.on('log:new', loadLogs);
    setInterval(() => { load(); loadLogs(); }, 20000);
  });
})();
