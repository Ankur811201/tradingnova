/* global window, document, NovaApi, NovaUI, NovaFormat, NovaSocket */
(function () {
  'use strict';

  const { formatUsd, formatNumber, formatPnl, escapeHtml } = NovaFormat;

  function buildQuery() {
    const params = new URLSearchParams();
    const env = document.getElementById('fEnv').value;
    const status = document.getElementById('fStatus').value;
    const symbol = document.getElementById('fSymbol').value.trim();
    if (env) params.set('environment', env);
    if (status) params.set('status', status);
    if (symbol) params.set('symbol', symbol.toUpperCase());
    params.set('limit', '100');
    return params.toString();
  }

  function render(positions) {
    const body = document.getElementById('positionsBody');
    if (!positions.length) {
      body.innerHTML = '<tr><td colspan="15"><div class="empty-state">No positions match these filters</div></td></tr>';
      return;
    }
    body.innerHTML = positions.map((p) => {
      const uPnl = formatPnl(p.unrealizedPnl);
      const rPnl = formatPnl(p.realizedPnl);
      const closeBtn = p.status === 'OPEN'
        ? '<button class="btn btn-sm ' + (p.environment === 'LIVE' ? 'btn-danger' : 'btn-secondary') + '" data-close="' + p._id + '" data-env="' + p.environment + '">Close</button>'
        : '—';
      return '<tr>' +
        '<td>' + NovaFormat.envBadge(p.environment) + '</td>' +
        '<td><span class="badge badge-neutral">' + escapeHtml(p.source) + '</span></td>' +
        '<td class="text-sm">' + escapeHtml(p.instanceId || '—') + '</td>' +
        '<td>' + escapeHtml(p.symbol) + '</td>' +
        '<td>' + NovaFormat.sideBadge(p.side) + '</td>' +
        '<td>' + formatUsd(p.entryPrice) + '</td>' +
        '<td>' + formatUsd(p.currentPrice) + '</td>' +
        '<td>' + formatNumber(p.quantity) + '</td>' +
        '<td>' + p.leverage + 'x</td>' +
        '<td>' + (p.stopLoss != null ? formatUsd(p.stopLoss) : '—') + '</td>' +
        '<td>' + (p.takeProfit != null ? formatUsd(p.takeProfit) : '—') + '</td>' +
        '<td class="' + uPnl.cls + '">' + uPnl.text + '</td>' +
        '<td class="' + rPnl.cls + '">' + rPnl.text + '</td>' +
        '<td>' + NovaFormat.statusBadge(p.status) + '</td>' +
        '<td>' + closeBtn + '</td>' +
        '</tr>';
    }).join('');

    body.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', NovaApi.withButtonLoading(btn, async () => {
        const env = btn.dataset.env;
        const isLive = env === 'LIVE';
        const ok = await NovaUI.confirmModal({
          title: isLive ? 'Close LIVE position?' : 'Close paper position?',
          message: isLive
            ? 'This will place a REAL-MONEY closing order via LiveTradingEngine → DeltaAdapter. This cannot be undone.'
            : 'This will close the position via the Paper Trading Engine at the current market price.',
          confirmLabel: 'Close Position',
          danger: isLive,
        });
        if (!ok) return;
        try {
          const path = isLive ? '/api/live/positions/' : '/api/paper/positions/';
          await NovaApi.post(path + btn.dataset.close + '/close');
          NovaUI.toast('Position closed', 'success');
          await load();
        } catch (err) {
          NovaUI.toast(NovaUI.errorMessage(err), 'error');
        }
      }));
    });
  }

  async function load() {
    try {
      const resp = await NovaApi.get('/api/positions?' + buildQuery());
      render(resp.positions || []);
    } catch (_err) {
      document.getElementById('positionsBody').innerHTML = '<tr><td colspan="15"><div class="empty-state">Unable to load positions</div></td></tr>';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    load();
    document.getElementById('applyFilters').addEventListener('click', load);
    NovaSocket.on('position:update', load);
    setInterval(load, 20000);
  });
})();
