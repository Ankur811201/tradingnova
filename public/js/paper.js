/* global window, document, NovaApi, NovaUI, NovaFormat, NovaSocket */
(function () {
  'use strict';

  const { formatUsd, formatPnl, formatTime, formatNumber, escapeHtml } = NovaFormat;
  let selectedSide = 'LONG';

  function renderStats(portfolio) {
    document.getElementById('pAvailable').textContent = formatUsd(portfolio.availableBalance);
    document.getElementById('pEquity').textContent = formatUsd(portfolio.equity);
    const realized = formatPnl(portfolio.totalRealizedPnl);
    const unrealized = formatPnl(portfolio.unrealizedPnl);
    const rEl = document.getElementById('pRealized'); rEl.textContent = realized.text; rEl.className = 'stat-value ' + realized.cls;
    const uEl = document.getElementById('pUnrealized'); uEl.textContent = unrealized.text; uEl.className = 'stat-value ' + unrealized.cls;
    renderPositions(portfolio.openPositions || []);
  }

  function renderPositions(positions) {
    const body = document.getElementById('positionsBody');
    if (!positions.length) {
      body.innerHTML = '<tr><td colspan="10"><div class="empty-state">No open paper positions</div></td></tr>';
      return;
    }
    body.innerHTML = positions.map((p) => {
      const pnl = formatPnl(p.unrealizedPnl);
      return '<tr>' +
        '<td>' + escapeHtml(p.symbol) + '</td>' +
        '<td>' + NovaFormat.sideBadge(p.side) + '</td>' +
        '<td>' + formatUsd(p.entryPrice) + '</td>' +
        '<td>' + formatUsd(p.currentPrice) + '</td>' +
        '<td>' + formatNumber(p.quantity) + '</td>' +
        '<td>' + p.leverage + 'x</td>' +
        '<td>' + (p.stopLoss != null ? formatUsd(p.stopLoss) : '—') + '</td>' +
        '<td>' + (p.takeProfit != null ? formatUsd(p.takeProfit) : '—') + '</td>' +
        '<td class="' + pnl.cls + '">' + pnl.text + '</td>' +
        '<td><button class="btn btn-sm btn-danger" data-close-position="' + p._id + '">Close</button></td>' +
        '</tr>';
    }).join('');

    body.querySelectorAll('[data-close-position]').forEach((btn) => {
      btn.addEventListener('click', NovaApi.withButtonLoading(btn, async () => {
        const ok = await NovaUI.confirmModal({
          title: 'Close paper position?',
          message: 'This will close the position at the current market price via the Paper Trading Engine.',
          confirmLabel: 'Close Position',
        });
        if (!ok) return;
        try {
          await NovaApi.post('/api/paper/positions/' + btn.dataset.closePosition + '/close');
          NovaUI.toast('Position closed', 'success');
          await loadPortfolio();
          await loadOrders();
        } catch (err) {
          NovaUI.toast(NovaUI.errorMessage(err), 'error');
        }
      }));
    });
  }

  function renderOrders(orders) {
    const body = document.getElementById('ordersBody');
    if (!orders.length) {
      body.innerHTML = '<tr><td colspan="8"><div class="empty-state">No paper orders yet</div></td></tr>';
      return;
    }
    body.innerHTML = orders.map((o) => (
      '<tr>' +
      '<td>' + escapeHtml(o.symbol) + '</td>' +
      '<td>' + NovaFormat.sideBadge(o.side) + '</td>' +
      '<td>' + escapeHtml(o.type) + '</td>' +
      '<td>' + formatNumber(o.quantity) + '</td>' +
      '<td>' + (o.executedPrice != null ? formatUsd(o.executedPrice) : '—') + '</td>' +
      '<td>' + formatUsd(o.fees) + '</td>' +
      '<td>' + NovaFormat.statusBadge(o.status) + '</td>' +
      '<td>' + formatTime(o.createdAt) + '</td>' +
      '</tr>'
    )).join('');
  }

  async function loadPortfolio() {
    try {
      const portfolio = await NovaApi.get('/api/portfolio/paper');
      renderStats(portfolio);
    } catch (_err) {
      document.getElementById('pAvailable').textContent = 'No data yet';
      document.getElementById('pEquity').textContent = 'No data yet';
      renderPositions([]);
    }
  }

  async function loadOrders() {
    try {
      const resp = await NovaApi.get('/api/orders?environment=PAPER&limit=15');
      renderOrders(resp.orders || []);
    } catch (_err) {
      renderOrders([]);
    }
  }

  async function loadSymbols() {
    const select = document.getElementById('tradeSymbol');
    try {
      const settings = await NovaApi.get('/api/settings');
      const symbols = settings.allowedSymbols && settings.allowedSymbols.length ? settings.allowedSymbols : [];
      if (!symbols.length) {
        select.innerHTML = '<option value="">No symbols configured</option>';
        return;
      }
      select.innerHTML = symbols.map((s) => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>').join('');
    } catch (_err) {
      select.innerHTML = '<option value="">Unavailable</option>';
    }
  }

  function setupSideToggle() {
    const longBtn = document.getElementById('sideLongBtn');
    const shortBtn = document.getElementById('sideShortBtn');
    longBtn.addEventListener('click', () => {
      selectedSide = 'LONG';
      longBtn.classList.add('selected'); shortBtn.classList.remove('selected');
    });
    shortBtn.addEventListener('click', () => {
      selectedSide = 'SHORT';
      shortBtn.classList.add('selected'); longBtn.classList.remove('selected');
    });
  }

  function setupFundsForm() {
    const form = document.getElementById('fundsForm');
    const btn = document.getElementById('fundsBtn');
    const alertBox = document.getElementById('fundsAlert');
    form.addEventListener('submit', NovaApi.withButtonLoading(btn, async (e) => {
      e.preventDefault();
      alertBox.classList.add('hidden');
      const amount = Number(document.getElementById('fundsAmount').value);
      const reason = document.getElementById('fundsReason').value.trim();
      try {
        await NovaApi.post('/api/paper/account/add-funds', { amount, reason: reason || undefined });
        NovaUI.toast('Virtual funds added', 'success');
        form.reset();
        await loadPortfolio();
      } catch (err) {
        alertBox.textContent = NovaUI.errorMessage(err);
        alertBox.classList.remove('hidden');
      }
    }));
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
      if (!symbol) {
        alertBox.textContent = 'No symbol selected.';
        alertBox.classList.remove('hidden');
        return;
      }
      try {
        await NovaApi.post('/api/paper/positions', {
          symbol, side: selectedSide, quantity, leverage,
          stopLoss: slVal ? Number(slVal) : undefined,
          takeProfit: tpVal ? Number(tpVal) : undefined,
        });
        NovaUI.toast('Paper position opened', 'success');
        document.getElementById('tradeQty').value = '';
        await loadPortfolio();
        await loadOrders();
      } catch (err) {
        alertBox.textContent = NovaUI.errorMessage(err);
        alertBox.classList.remove('hidden');
      }
    }));
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupSideToggle();
    setupFundsForm();
    setupTradeForm();
    loadSymbols();
    loadPortfolio();
    loadOrders();

    NovaSocket.on('paper:portfolio', renderStats);
    NovaSocket.on('order:update', loadOrders);

    setInterval(() => { loadPortfolio(); loadOrders(); }, 20000);
  });
})();
