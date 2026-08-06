/* global window */
(function () {
  'use strict';

  function formatUsd(value, opts) {
    opts = opts || {};
    if (value === null || value === undefined || Number.isNaN(Number(value))) return 'Unavailable';
    const n = Number(value);
    return n.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: opts.decimals != null ? opts.decimals : 2,
      maximumFractionDigits: opts.decimals != null ? opts.decimals : 2,
    });
  }

  function formatNumber(value, decimals) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    return Number(value).toLocaleString('en-US', {
      minimumFractionDigits: decimals != null ? decimals : 0,
      maximumFractionDigits: decimals != null ? decimals : 6,
    });
  }

  function formatPnl(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return { text: 'Unavailable', cls: 'pnl-neutral' };
    }
    const n = Number(value);
    const sign = n > 0 ? '+' : '';
    const cls = n > 0 ? 'pnl-positive' : n < 0 ? 'pnl-negative' : 'pnl-neutral';
    return { text: sign + formatUsd(n), cls };
  }

  function formatTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function relativeTime(value) {
    if (!value) return '—';
    const d = new Date(value).getTime();
    if (Number.isNaN(d)) return '—';
    const diffSec = Math.round((Date.now() - d) / 1000);
    if (diffSec < 5) return 'just now';
    if (diffSec < 60) return diffSec + 's ago';
    if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ago';
    if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h ago';
    return Math.floor(diffSec / 86400) + 'd ago';
  }

  function envBadge(environment) {
    if (environment === 'LIVE') return '<span class="badge badge-live">LIVE</span>';
    if (environment === 'PAPER') return '<span class="badge badge-paper">PAPER</span>';
    return '<span class="badge badge-neutral">' + escapeHtml(environment || 'UNKNOWN') + '</span>';
  }

  function statusBadge(status) {
    const map = {
      RUNNING: 'badge-running', PAUSED: 'badge-paused', STOPPED: 'badge-stopped', ERROR: 'badge-error',
      FILLED: 'badge-positive', PENDING: 'badge-warning', SUBMITTED: 'badge-warning',
      PARTIALLY_FILLED: 'badge-warning', REJECTED: 'badge-error', CANCELLED: 'badge-neutral',
      OPEN: 'badge-positive', CLOSED: 'badge-neutral', LIQUIDATED: 'badge-error',
    };
    const cls = map[status] || 'badge-neutral';
    return '<span class="badge ' + cls + '">' + escapeHtml(status || 'UNKNOWN') + '</span>';
  }

  function sideBadge(side) {
    const s = (side || '').toUpperCase();
    if (s === 'LONG' || s === 'BUY') return '<span class="badge badge-positive">' + escapeHtml(s) + '</span>';
    if (s === 'SHORT' || s === 'SELL') return '<span class="badge badge-negative">' + escapeHtml(s) + '</span>';
    return '<span class="badge badge-neutral">' + escapeHtml(s || '—') + '</span>';
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.NovaFormat = {
    formatUsd, formatNumber, formatPnl, formatTime, relativeTime, envBadge, statusBadge, sideBadge, escapeHtml,
  };
})();
