/* global window, document, NovaApi, NovaFormat, NovaSocket */
(function () {
  'use strict';

  const { formatUsd, formatNumber, formatTime, escapeHtml } = NovaFormat;

  function buildQuery() {
    const params = new URLSearchParams();
    const env = document.getElementById('fEnv').value;
    const source = document.getElementById('fSource').value;
    const symbol = document.getElementById('fSymbol').value.trim();
    const status = document.getElementById('fStatus').value;
    if (env) params.set('environment', env);
    if (source) params.set('source', source);
    if (symbol) params.set('symbol', symbol.toUpperCase());
    if (status) params.set('status', status);
    params.set('limit', '100');
    return params.toString();
  }

  function render(orders) {
    const body = document.getElementById('ordersBody');
    if (!orders.length) {
      body.innerHTML = '<tr><td colspan="12"><div class="empty-state">No orders match these filters</div></td></tr>';
      return;
    }
    body.innerHTML = orders.map((o) => (
      '<tr>' +
      '<td class="mono text-sm">' + escapeHtml(o.internalOrderId) + '</td>' +
      '<td>' + NovaFormat.envBadge(o.environment) + '</td>' +
      '<td><span class="badge badge-neutral">' + escapeHtml(o.source) + '</span></td>' +
      '<td>' + escapeHtml(o.symbol) + '</td>' +
      '<td>' + NovaFormat.sideBadge(o.side) + '</td>' +
      '<td>' + escapeHtml(o.type) + '</td>' +
      '<td>' + formatNumber(o.quantity) + '</td>' +
      '<td>' + (o.requestedPrice != null ? formatUsd(o.requestedPrice) : '—') + '</td>' +
      '<td>' + (o.executedPrice != null ? formatUsd(o.executedPrice) : '—') + '</td>' +
      '<td>' + NovaFormat.statusBadge(o.status) + '</td>' +
      '<td>' + formatUsd(o.fees) + '</td>' +
      '<td>' + formatTime(o.createdAt) + '</td>' +
      '</tr>'
    )).join('');
  }

  async function load() {
    try {
      const resp = await NovaApi.get('/api/orders?' + buildQuery());
      render(resp.orders || []);
    } catch (_err) {
      document.getElementById('ordersBody').innerHTML = '<tr><td colspan="12"><div class="empty-state">Unable to load orders</div></td></tr>';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    load();
    document.getElementById('applyFilters').addEventListener('click', load);
    NovaSocket.on('order:update', load);
    setInterval(load, 20000);
  });
})();
