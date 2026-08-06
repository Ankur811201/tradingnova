/* global window, document, NovaApi, NovaUI, NovaFormat, NovaSocket */
(function () {
  'use strict';

  const { formatUsd, formatPnl, formatNumber, escapeHtml } = NovaFormat;
  let selectedSide = 'LONG';
  let deltaConfigured = false;
  let liveTradingEnabled = false;

  function updateTradeFormState() {
    const btn = document.getElementById('tradeBtn');
    const hint = document.getElementById('tradeHint');
    if (!deltaConfigured) {
      btn.disabled = true;
      hint.textContent = 'Live Trading Unavailable — Delta Exchange is not connected.';
      return;
    }
    if (!liveTradingEnabled) {
      btn.disabled = true;
      hint.textContent = 'Live trading is currently disabled globally. Enable it from Safety & Settings.';
      return;
    }
    btn.disabled = false;
    hint.textContent = 'This places a REAL-MONEY market order via Delta Exchange.';
  }

  function renderBalances(balances) {
    const body = document.getElementById('balanceBody');
    if (!Array.isArray(balances) || !balances.length) {
      body.innerHTML = '<tr><td colspan="3"><div class="empty-state">No balance data</div></td></tr>';
      return;
    }
    body.innerHTML = balances.map((b) => (
      '<tr>' +
      '<td>' + escapeHtml(b.asset_symbol || b.asset || '—') + '</td>' +
      '<td>' + formatNumber(b.balance) + '</td>' +
      '<td>' + formatNumber(b.available_balance != null ? b.available_balance : b.balance) + '</td>' +
      '</tr>'
    )).join('');
  }

  function renderPositions(positions) {
    const body = document.getElementById('positionsBody');
    if (!positions || !positions.length) {
      body.innerHTML = '<tr><td colspan="8"><div class="empty-state">No open live positions</div></td></tr>';
      return;
    }
    body.innerHTML = positions.map((p) => {
      const pnl = formatPnl(p.realizedPnl);
      return '<tr>' +
        '<td>' + escapeHtml(p.symbol) + '</td>' +
        '<td>' + NovaFormat.sideBadge(p.side) + '</td>' +
        '<td>' + formatUsd(p.entryPrice) + '</td>' +
        '<td>' + formatUsd(p.currentPrice) + '</td>' +
        '<td>' + formatNumber(p.quantity) + '</td>' +
        '<td>' + p.leverage + 'x</td>' +
        '<td class="' + pnl.cls + '">' + pnl.text + '</td>' +
        '<td><button class="btn btn-sm btn-danger" data-close-position="' + p._id + '">Close</button></td>' +
        '</tr>';
    }).join('');

    body.querySelectorAll('[data-close-position]').forEach((btn) => {
      btn.addEventListener('click', NovaApi.withButtonLoading(btn, async () => {
        const ok = await NovaUI.confirmModal({
          title: 'Close LIVE position?',
          message: 'This will place a REAL-MONEY closing order on Delta Exchange. This action cannot be undone.',
          confirmLabel: 'Close Real Position',
          danger: true,
        });
        if (!ok) return;
        try {
          await NovaApi.post('/api/live/positions/' + btn.dataset.closePosition + '/close');
          NovaUI.toast('Live position closed', 'success');
          await loadPortfolio();
        } catch (err) {
          NovaUI.toast(NovaUI.errorMessage(err), 'error');
        }
      }));
    });
  }

  function renderOpenOrders(orders) {
    const body = document.getElementById('openOrdersBody');
    if (!orders || !orders.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty-state">No open orders on Delta</div></td></tr>';
      return;
    }
    body.innerHTML = orders.map((o) => (
      '<tr>' +
      '<td class="mono text-sm">' + escapeHtml(o.id) + '</td>' +
      '<td>' + escapeHtml(o.product_symbol || o.symbol || '—') + '</td>' +
      '<td>' + NovaFormat.sideBadge(o.side) + '</td>' +
      '<td>' + formatNumber(o.size) + '</td>' +
      '<td>' + NovaFormat.statusBadge((o.state || '').toUpperCase()) + '</td>' +
      '</tr>'
    )).join('');
  }

  async function loadStatus() {
    try {
      const status = await NovaApi.get('/api/live/status');
      deltaConfigured = Boolean(status.configured);
    } catch (_err) {
      deltaConfigured = false;
    }
    document.getElementById('lDeltaConfigured').innerHTML = deltaConfigured
      ? '<span class="badge badge-positive">Configured</span>'
      : '<span class="badge badge-neutral">Not configured</span>';

    try {
      const settings = await NovaApi.get('/api/settings');
      liveTradingEnabled = Boolean(settings.liveTradingEnabled);
      const symbols = settings.allowedSymbols || [];
      const select = document.getElementById('tradeSymbol');
      select.innerHTML = symbols.length
        ? symbols.map((s) => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>').join('')
        : '<option value="">No symbols configured</option>';
    } catch (_err) {
      liveTradingEnabled = false;
    }
    document.getElementById('lLiveEnabled').innerHTML = liveTradingEnabled
      ? '<span class="badge badge-live">Enabled</span>'
      : '<span class="badge badge-neutral">Disabled</span>';

    const banner = document.getElementById('liveUnavailable');
    if (!deltaConfigured) {
      banner.textContent = 'Live Trading Unavailable — Delta Exchange is not connected.';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    updateTradeFormState();
  }

  async function loadPortfolio() {
    if (!deltaConfigured) {
      document.getElementById('lDeltaConnected').innerHTML = '<span class="badge badge-neutral">Unavailable</span>';
      renderBalances([]);
      renderPositions([]);
      renderOpenOrders([]);
      return;
    }
    try {
      const portfolio = await NovaApi.get('/api/portfolio/live');
      document.getElementById('lDeltaConnected').innerHTML = '<span class="badge badge-positive">Connected</span>';
      renderBalances(portfolio.exchangeBalances);
      renderPositions(portfolio.localPositions);
      renderOpenOrders(portfolio.openOrders);
    } catch (err) {
      document.getElementById('lDeltaConnected').innerHTML = '<span class="badge badge-error">Disconnected</span>';
      NovaUI.toast('Delta Exchange: ' + NovaUI.errorMessage(err), 'error');
      renderBalances([]);
      renderPositions([]);
      renderOpenOrders([]);
    }
  }

  function setupSideToggle() {
    const longBtn = document.getElementById('sideLongBtn');
    const shortBtn = document.getElementById('sideShortBtn');
    longBtn.addEventListener('click', () => { selectedSide = 'LONG'; longBtn.classList.add('selected'); shortBtn.classList.remove('selected'); });
    shortBtn.addEventListener('click', () => { selectedSide = 'SHORT'; shortBtn.classList.add('selected'); longBtn.classList.remove('selected'); });
  }

  function setupTradeForm() {
    const form = document.getElementById('tradeForm');
    const btn = document.getElementById('tradeBtn');
    const alertBox = document.getElementById('tradeAlert');
    form.addEventListener('submit', NovaApi.withButtonLoading(btn, async (e) => {
      e.preventDefault();
      alertBox.classList.add('hidden');
      const symbol = document.getElementById('tradeSymbol').value;
      const quantity = Number(document.getElementById('tradeQty').value);
      const leverage = Number(document.getElementById('tradeLeverage').value) || 1;
      const slVal = document.getElementById('tradeSL').value;
      const tpVal = document.getElementById('tradeTP').value;
      if (!symbol || !quantity) {
        alertBox.textContent = 'Symbol and quantity are required.';
        alertBox.classList.remove('hidden');
        return;
      }

      const ok = await NovaUI.confirmModal({
        title: 'Place real-money trade?',
        message: 'This action may place a real-money trade on Delta Exchange (' + selectedSide + ' ' + quantity + ' ' + symbol + '). This cannot be undone.',
        confirmLabel: 'Place Live Order',
        danger: true,
      });
      if (!ok) return;

      try {
        await NovaApi.post('/api/live/positions', {
          symbol, side: selectedSide, quantity, leverage,
          stopLoss: slVal ? Number(slVal) : undefined,
          takeProfit: tpVal ? Number(tpVal) : undefined,
        });
        NovaUI.toast('Live order submitted', 'success');
        document.getElementById('tradeQty').value = '';
        await loadPortfolio();
      } catch (err) {
        alertBox.textContent = NovaUI.errorMessage(err);
        alertBox.classList.remove('hidden');
      }
    }));
  }

  document.addEventListener('DOMContentLoaded', async () => {
    setupSideToggle();
    setupTradeForm();
    await loadStatus();
    await loadPortfolio();

    NovaSocket.on('live:portfolio', (portfolio) => {
      renderBalances(portfolio.exchangeBalances);
      renderPositions(portfolio.localPositions);
      renderOpenOrders(portfolio.openOrders);
    });
    NovaSocket.on('position:update', loadPortfolio);

    setInterval(async () => { await loadStatus(); await loadPortfolio(); }, 25000);
  });
})();
