/* global window, document, NovaApi, NovaFormat */
(function () {
  'use strict';

  const { formatUsd, formatNumber, formatPnl, formatTime, escapeHtml } = NovaFormat;

  function buildQuery() {
    const params = new URLSearchParams();
    const env = document.getElementById('fEnv').value;
    const source = document.getElementById('fSource').value;
    const symbol = document.getElementById('fSymbol').value.trim();
    if (env) params.set('environment', env);
    if (source) params.set('source', source);
    if (symbol) params.set('symbol', symbol.toUpperCase());
    params.set('limit', '100');
    return params.toString();
  }

  function render(trades) {
    const body = document.getElementById('tradesBody');
    if (!trades.length) {
      body.innerHTML = '<tr><td colspan="11"><div class="empty-state">No trades match these filters</div></td></tr>';
      return;
    }
    body.innerHTML = trades.map((t) => {
      const pnl = formatPnl(t.realizedPnl);
      return '<tr>' +
        '<td class="mono text-sm">' + escapeHtml(t._id) + '</td>' +
        '<td>' + NovaFormat.envBadge(t.environment) + '</td>' +
        '<td><span class="badge badge-neutral">' + escapeHtml(t.source) + '</span></td>' +
        '<td>' + escapeHtml(t.symbol) + '</td>' +
        '<td>' + NovaFormat.sideBadge(t.side) + '</td>' +
        '<td>' + formatUsd(t.entryPrice) + '</td>' +
        '<td>' + formatUsd(t.exitPrice) + '</td>' +
        '<td>' + formatNumber(t.quantity) + '</td>' +
        '<td>' + formatUsd(t.fees) + '</td>' +
        '<td class="' + pnl.cls + '">' + pnl.text + '</td>' +
        '<td>' + formatTime(t.closedAt) + '</td>' +
        '</tr>';
    }).join('');
  }

  async function load() {
    try {
      const resp = await NovaApi.get('/api/trades?' + buildQuery());
      render(resp.trades || []);
    } catch (_err) {
      document.getElementById('tradesBody').innerHTML = '<tr><td colspan="11"><div class="empty-state">Unable to load trade history</div></td></tr>';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    load();
    document.getElementById('applyFilters').addEventListener('click', load);
  });
})();
