/* global window, document, NovaApi, NovaUI, NovaFormat, NovaSocket */
(function () {
  'use strict';

  const { escapeHtml, formatTime, relativeTime, formatUsd } = NovaFormat;
  let modelsById = {};

  // Cache of the latest OPEN position (if any) per bot instance, keyed by
  // instanceId. Populated by loadInstances() / socket updates so cards can
  // render "current position / entry / P&L / SL / TP" without inventing
  // fields BotInstance itself doesn't have (see models/BotInstance.js —
  // that data actually lives on the Position document).
  let positionByInstance = {};

  // ---------------------------------------------------------------------
  // Badges (unchanged logic, just kept local to this file as before)
  // ---------------------------------------------------------------------
  function statusBadgeClass(status) {
    return NovaFormat.statusBadge(status);
  }

  function readinessBadge(readiness) {
    if (readiness === 'READY') return '<span class="badge badge-positive">READY</span>';
    if (readiness === 'BLOCKED') return '<span class="badge badge-warning">BLOCKED</span>';
    return '<span class="badge badge-neutral">' + escapeHtml(readiness || 'UNKNOWN') + '</span>';
  }

  function marketDataBadge(marketData) {
    if (!marketData || !marketData.connected) return '<span class="badge badge-neutral">Disconnected</span>';
    return marketData.fresh
      ? '<span class="badge badge-positive">Live</span>'
      : '<span class="badge badge-warning">Stale</span>';
  }

  // ---------------------------------------------------------------------
  // Create Bot modal — same form/fields/handlers as before, just opened
  // from the new header button instead of always being on the page.
  // ---------------------------------------------------------------------
  function openCreateModal() {
    document.getElementById('createBotModal').classList.remove('hidden');
    document.body.classList.add('modal-open');
  }

  function closeCreateModal() {
    document.getElementById('createBotModal').classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  function renderModelParamFields(modelId) {
    const section = document.getElementById('modelParamsSection');
    const container = document.getElementById('modelParamsContainer');
    const model = modelsById[modelId];
    const params = model && model.defaultParameters;
    if (!params || !Object.keys(params).length) {
      section.classList.add('hidden');
      container.innerHTML = '';
      return;
    }
    section.classList.remove('hidden');
    container.innerHTML = Object.keys(params).map((key) => {
      const value = params[key];
      const inputId = 'param_' + key;
      let inputHtml;
      if (typeof value === 'boolean') {
        inputHtml = '<select id="' + inputId + '" data-type="boolean">' +
          '<option value="true"' + (value ? ' selected' : '') + '>true</option>' +
          '<option value="false"' + (!value ? ' selected' : '') + '>false</option></select>';
      } else if (typeof value === 'number') {
        inputHtml = '<input type="number" id="' + inputId + '" data-type="number" step="any" value="' + value + '" />';
      } else {
        inputHtml = '<input type="text" id="' + inputId + '" data-type="string" value="' + escapeHtml(String(value)) + '" />';
      }
      return '<div class="field"><label for="' + inputId + '">' + escapeHtml(key) + '</label>' + inputHtml + '</div>';
    }).join('');
  }

  function collectModelParams() {
    const container = document.getElementById('modelParamsContainer');
    const inputs = container.querySelectorAll('[data-type]');
    const result = {};
    inputs.forEach((el) => {
      const key = el.id.replace(/^param_/, '');
      const type = el.dataset.type;
      if (type === 'boolean') result[key] = el.value === 'true';
      else if (type === 'number') result[key] = Number(el.value);
      else result[key] = el.value;
    });
    return result;
  }

 async function loadModels() {

    const container = document.getElementById('modelsList');
    const select = document.getElementById('instModel');

    try {

        const models = await NovaApi.get('/api/bot-models');

        modelsById = {};

        models.forEach(m => {
            modelsById[m.modelId] = m;
        });

        if (!models.length) {

            if (container) {
                container.innerHTML =
                    '<div class="empty-state">No Bot Models Installed</div>';
            }

            select.innerHTML =
                '<option value="">No models available</option>';

            return;
        }

        // Only update modelsList if it exists
        if (container) {

            container.innerHTML = models.map(m => `
                <div class="model-card">
                    <h3>${escapeHtml(m.name || m.modelId)}</h3>
                    <p>${escapeHtml(m.description || "")}</p>
                </div>
            `).join('');

        }

        select.innerHTML = models.map(m => `
            <option value="${escapeHtml(m.modelId)}">
                ${escapeHtml(m.name || m.modelId)}
            </option>
        `).join('');

        renderModelParamFields(select.value);

    } catch (err) {

        console.error(err);

        if (container) {
            container.innerHTML =
                '<div class="empty-state">Unable to load bot models</div>';
        }

        select.innerHTML =
            '<option value="">Unavailable</option>';
    }

}

  async function loadSymbols() {
    const select = document.getElementById('instSymbol');
    try {
      const settings = await NovaApi.get('/api/settings');
      const symbols = settings.allowedSymbols || [];
      select.innerHTML = symbols.length
        ? symbols.map((s) => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>').join('')
        : '<option value="">No symbols configured</option>';
    } catch (_err) {
      select.innerHTML = '<option value="">Unavailable</option>';
    }
  }

  // ---------------------------------------------------------------------
  // Per-instance data: open position (entry/current price/PnL/SL/TP) and
  // recent strategy events (for the activity timeline). Both come from
  // existing, already-mounted read endpoints — no new routes.
  // ---------------------------------------------------------------------
  async function fetchOpenPosition(instanceId) {
    try {
      const res = await NovaApi.get('/api/positions?instanceId=' + encodeURIComponent(instanceId) + '&status=OPEN&limit=1');
      return (res.positions && res.positions[0]) || null;
    } catch (_err) {
      return null;
    }
  }

  async function fetchLatestPrice(symbol) {
    if (!symbol) return null;
    try {
      return await NovaApi.get('/api/market/price/' + encodeURIComponent(symbol));
    } catch (_err) {
      return null;
    }
  }

  async function fetchStrategyEvents(instanceId) {
    try {
      return await NovaApi.get('/api/logs/strategy-events?instanceId=' + encodeURIComponent(instanceId) + '&limit=15');
    } catch (_err) {
      return [];
    }
  }

  // ---------------------------------------------------------------------
  // Activity timeline — newest first, one row per StrategyEvent. The icon
  // is chosen from the free-form eventType string (Bot Models define their
  // own event types, see models/StrategyEvent.js), so this is a best-effort
  // mapping rather than a fixed enum.
  // ---------------------------------------------------------------------
  function timelineIcon(eventType) {
    const t = (eventType || '').toUpperCase();
    if (t.includes('BUY') || t.includes('ENTRY') || t.includes('LONG')) return '🟢';
    if (t.includes('SELL') || t.includes('EXIT') || t.includes('SHORT')) return '🔴';
    if (t.includes('STOP')) return '🛑';
    if (t.includes('TAKE_PROFIT') || t.includes('TP')) return '🎯';
    if (t.includes('TRAIL')) return '🧵';
    if (t.includes('PATTERN')) return '🔍';
    if (t.includes('CANDLE')) return '🕯️';
    if (t.includes('CROSS') || t.includes('EMA') || t.includes('INDICATOR')) return '📈';
    if (t.includes('POSITION')) return '📌';
    return '•';
  }

  function renderTimeline(instanceId, events) {
    const el = document.getElementById('timeline-' + instanceId);
    if (!el) return;
    if (!events || !events.length) {
      el.innerHTML = '<div class="empty-state">No activity yet</div>';
      return;
    }
    el.innerHTML = events.map((ev) => {
      const desc = ev.payload && Object.keys(ev.payload).length
        ? escapeHtml(Object.entries(ev.payload).slice(0, 3).map(([k, v]) => k + ': ' + v).join(' · '))
        : '';
      return '<div class="timeline-row">' +
        '<span class="timeline-icon">' + timelineIcon(ev.eventType) + '</span>' +
        '<span class="timeline-time">' + formatTime(ev.at) + '</span>' +
        '<span class="timeline-body"><span class="timeline-title">' + escapeHtml(ev.eventType) + '</span>' +
        (desc ? '<span class="timeline-desc">' + desc + '</span>' : '') + '</span>' +
        '</div>';
    }).join('');
  }

  // ---------------------------------------------------------------------
  // Chart — reuses the exact same read-only TradingView "Advanced Chart"
  // embed technique as public/js/chart.js (iframe, no API key, display
  // only). It is instantiated once per bot card instead of once per page.
  //
  // NOTE on overlays: because this is a plain iframe embed (not the
  // TradingView Charting Library / a datafeed-driven library like
  // lightweight-charts), there is no supported way to draw markers
  // (buy/sell/SL/TP/pattern/trailing-stop) directly on top of TradingView's
  // own candles from the parent page — the iframe is cross-origin. Rather
  // than fake this, the "Recent Signals" strip below the chart renders the
  // same events (entry/exit/SL/TP/pattern/trailing-stop) as a compact,
  // time-ordered legend sourced from StrategyEvent. The `buildMarkers()`
  // helper below shapes that data into a `{type, time, payload}` list so it
  // can be dropped straight into a datafeed-based chart later if the chart
  // library is ever upgraded — that upgrade is out of scope here since the
  // instructions are to reuse the existing chart, not replace it.
  // ---------------------------------------------------------------------
  function tradingViewSymbolFor(symbol) {
    if (!symbol) return null;
    const upper = symbol.toUpperCase();
    if (upper.endsWith('USDT')) return 'BINANCE:' + upper;
    if (upper.endsWith('USD')) return 'BINANCE:' + upper.replace('USD', 'USDT');
    return 'BINANCE:' + upper;
  }

  function initCardChart(instanceId, symbol) {
    const container = document.getElementById('chart-' + instanceId);
    if (!container) return;
    const tvSymbol = tradingViewSymbolFor(symbol);
    if (!tvSymbol) {
      container.innerHTML = '<div class="chart-empty">Market data unavailable — no symbol configured</div>';
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.title = 'TradingView chart (read-only) — ' + symbol;
    iframe.src = 'https://s.tradingview.com/widgetembed/?symbol=' + encodeURIComponent(tvSymbol) +
      '&interval=15&theme=dark&style=1&hide_top_toolbar=0&hide_legend=0&saveimage=0';
    iframe.addEventListener('error', () => {
      container.innerHTML = '<div class="chart-empty">Chart unavailable</div>';
    });
    container.innerHTML = '';
    container.appendChild(iframe);
  }

  function buildMarkers(events) {
    // Ready for a future datafeed-based chart: one entry per relevant event.
    return (events || [])
      .filter((ev) => /BUY|SELL|ENTRY|EXIT|STOP|TAKE_PROFIT|TP|PATTERN|TRAIL/i.test(ev.eventType || ''))
      .map((ev) => ({ type: ev.eventType, time: ev.at, payload: ev.payload || {} }));
  }

  function riskReward(entryPrice, stopLoss, takeProfit) {
    if (!entryPrice || !stopLoss || !takeProfit) return null;
    const risk = Math.abs(entryPrice - stopLoss);
    const reward = Math.abs(takeProfit - entryPrice);
    if (!risk) return null;
    return (reward / risk).toFixed(2) + 'R';
  }

  // ---------------------------------------------------------------------
  // Card markup
  // ---------------------------------------------------------------------
  function infoTile(label, value, cls) {
    return '<div class="info-tile"><span class="info-label">' + escapeHtml(label) + '</span>' +
      '<span class="info-value' + (cls ? ' ' + cls : '') + '">' + value + '</span></div>';
  }

  function buildCardHtml(instance, position, latestPrice) {
    const model = modelsById[instance.modelId];
    const strategyName = (model && model.name) || instance.modelId;
    const timeframe = (instance.parameters && instance.parameters.timeframe) || '—';

    const currentPrice = position ? position.currentPrice : (latestPrice && latestPrice.price);
    const pnl = position ? NovaFormat.formatPnl(position.unrealizedPnl) : { text: '—', cls: 'pnl-neutral' };
    const rr = position ? riskReward(position.entryPrice, position.stopLoss, position.takeProfit) : null;
    const botTitle = instance.name || strategyName || instance.modelId;
 return `
  <div class="bot-card" data-instance="${escapeHtml(instance.instanceId)}" data-symbol="${escapeHtml(instance.symbol)}">

    <!-- ===== Header ===== -->
    <div class="bot-card-header">
      <div class="bot-card-title-block">
        <h3>${escapeHtml(botTitle)}</h3>
        <div class="bot-model"><i>${escapeHtml(strategyName)}</i></div>
      </div>
      <div class="bot-card-pnl ${pnl.cls}">
        ${pnl.text}
      </div>
    </div>

    <!-- ===== Badges ===== -->
    <div class="bot-card-badges mt-12">
      ${statusBadgeClass(instance.status)}
      ${NovaFormat.envBadge(instance.environment)}
      <span class="badge badge-neutral">${escapeHtml(instance.symbol)}</span>
      <span class="badge badge-neutral">${escapeHtml(timeframe)}</span>
    </div>

    <!-- ===== Main Info ===== -->
    <div class="info-grid mt-16">
      ${infoTile('Total Profit', pnl.text, pnl.cls)}
      ${infoTile(
        'Current Position',
        position ? NovaFormat.sideBadge(position.side) : 'No Open Position'
      )}
    </div>

    <!-- ===== Bot Message ===== -->
    ${
      instance.status === 'RUNNING'
        ? `
          <div class="bot-status-message mt-16" id="bot-status-${escapeHtml(instance.instanceId)}">
            <div class="bot-thinking">
              <span></span>
              <span></span>
              <span></span>
            </div>
            <span class="bot-thinking-text">Analyzing market...</span>
          </div>

          <script>
            setTimeout(function() {
              var el = document.getElementById("bot-status-${escapeHtml(instance.instanceId)}");
              if (!el) return;
              el.innerHTML = "<span>${
                position
                  ? '📈 Managing open position...'
                  : '👀 Watching market for next trading opportunity.'
              }</span>";
            }, 1800);
          </script>
        `
        : `
          <div class="bot-status-message mt-16">
            ${
              instance.status === 'PAUSED'
                ? '⏸ Bot is paused. Click Resume to continue.'
                : '⏹ Bot is stopped. Click Start to activate.'
            }
          </div>
        `
    }

    <!-- ===== Buttons ===== -->
 <div class="bot-card-controls mt-20">
  ${
    instance.status === 'RUNNING'
      ? '<button class="btn btn-warning btn-sm" data-action="pause">⏸ Pause</button>'
      : `<button class="btn btn-success btn-sm" data-action="start">
            ${instance.status === 'PAUSED' ? '▶ Resume' : '▶ Start'}
         </button>
         <button class="btn btn-danger btn-sm" data-action="delete">🗑 Delete</button>`
  }

  <button class="btn btn-primary btn-sm view-bot-btn"
          data-instance="${instance.instanceId}">
      📊 View Details
  </button>
</div>

    <!-- ===== Error ===== -->
    ${
      instance.lastError
        ? `<div class="alert alert-danger mt-16">${escapeHtml(instance.lastError)}</div>`
        : ''
    }

  </div>
`;
  }

  function wireCardControls(card, instanceId) {
    card.querySelectorAll('[data-action]').forEach((btn) => {
      const action = btn.dataset.action;
      if (action === 'details') {
        btn.addEventListener('click', () => card.classList.toggle('bot-card-expanded'));
        return;
      }else if (action === 'delete') {
    btn.addEventListener('click', async () => {

        if (!confirm('Delete this bot permanently?')) return;

        try {
           await fetch('/api/bot-instances/' + instanceId, {
    method: 'DELETE'
});

            NovaUI.toast('Bot deleted successfully', 'success');

            await loadInstances();

        } catch (err) {

            NovaUI.toast(NovaUI.errorMessage(err), 'error');

        }

    });

    return;
}


      btn.addEventListener('click', NovaApi.withButtonLoading(btn, async () => {
        try {
          await NovaApi.post('/api/bot-instances/' + instanceId + '/' + action);
          NovaUI.toast('Bot ' + (btn.dataset.label || action) + 'ed', 'success');
          await loadInstances();
        } catch (err) {
          NovaUI.toast(NovaUI.errorMessage(err), 'error');
        }
      }));
    });
  }
  

  function renderSignalsStrip(instanceId, events) {
    const el = document.getElementById('signals-' + instanceId);
    if (!el) return;
    const markers = buildMarkers(events).slice(0, 6);
    if (!markers.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = markers.map((m) => (
      '<span class="signal-chip">' + timelineIcon(m.type) + ' ' + escapeHtml(m.type) + ' <span class="signal-time">' + formatTime(m.time) + '</span></span>'
    )).join('');
  }

  async function hydrateCard(instance) {
    const [position, events, latestPrice] = await Promise.all([
      fetchOpenPosition(instance.instanceId),
      fetchStrategyEvents(instance.instanceId),
      positionByInstance[instance.instanceId] ? Promise.resolve(null) : fetchLatestPrice(instance.symbol),
    ]);
    positionByInstance[instance.instanceId] = position;
    renderTimeline(instance.instanceId, events);
    renderSignalsStrip(instance.instanceId, events);
    initCardChart(instance.instanceId, instance.symbol);

    // Backfill the "Current Price" tile once the price/position fetch
    // resolves, in case the initial synchronous render had no position yet.
    if (!position && latestPrice && latestPrice.price != null) {
      const card = document.querySelector('.bot-card[data-instance="' + CSS.escape(instance.instanceId) + '"]');
      const tile = card && card.querySelector('.info-tile .info-value');
      if (tile) tile.textContent = formatUsd(latestPrice.price);
    }
  }

  async function renderInstances(instances) {
    const container = document.getElementById('instancesList');
    if (!instances.length) {
      container.innerHTML = '<div class="empty-state"><div class="icon">⚙️</div>No bot instances yet — create one to get started.</div>';
      return;
    }

    // Render header/info-grid synchronously from data we already have, then
    // hydrate each card's chart/position/timeline without blocking the list.
    container.innerHTML = instances.map((i) => buildCardHtml(i, positionByInstance[i.instanceId] || null, null)).join('');

    container.querySelectorAll('.bot-card').forEach((card) => {
      wireCardControls(card, card.dataset.instance);
    });

    instances.forEach((instance) => { hydrateCard(instance); });
  }

  async function loadInstances() {
    try {
      const instances = await NovaApi.get('/api/bot-instances');
      await renderInstances(instances);
    } catch (_err) {
      document.getElementById('instancesList').innerHTML = '<div class="empty-state">Unable to load bot instances</div>';
    }
  }

  function setupCreateForm() {
    const form = document.getElementById('createForm');
    const btn = document.getElementById('createBtn');
    const alertBox = document.getElementById('createAlert');
    form.addEventListener('submit', NovaApi.withButtonLoading(btn, async (e) => {
      e.preventDefault();
      alertBox.classList.add('hidden');
      const name = document.getElementById('instName').value.trim();
const modelId = document.getElementById('instModel').value;
      const symbol = document.getElementById('instSymbol').value;
      const environment = document.getElementById('instEnv').value;
      const leverage = Number(document.getElementById('instLeverage').value) || 1;
      const capitalAllocation = Number(document.getElementById('instCapital').value);
      if (!modelId || !symbol || !capitalAllocation) {
        alertBox.textContent = 'Model, symbol, and capital allocation are required.';
        alertBox.classList.remove('hidden');
        return;
      }
      // PART 13 -- PHASE C/O: canonical levels/targets/sizing. All optional —
      // omitted entirely (not sent as empty/0) when left blank, so the backend
      // schema defaults (top/bottom null, sizing CAPITAL, targets []) apply,
      // exactly matching pre-Part-13 bot behavior.
      const topLevelRaw = document.getElementById('instTopLevel').value;
      const bottomLevelRaw = document.getElementById('instBottomLevel').value;
      const levels = (topLevelRaw !== '' && bottomLevelRaw !== '')
        ? { top: Number(topLevelRaw), bottom: Number(bottomLevelRaw) }
        : null;

      const targetsRaw = document.getElementById('instTargets').value.trim();
      const targets = targetsRaw
        ? targetsRaw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ price: Number(s) }))
        : null;

      const sizingMode = document.getElementById('instSizingMode').value;
      const lotValueRaw = document.getElementById('instLotValue').value;
      const sizing = sizingMode === 'LOT'
        ? { mode: 'LOT', value: Number(lotValueRaw) }
        : { mode: 'CAPITAL' };

      try {
        const parameters = collectModelParams();
await NovaApi.post('/api/bot-instances', {
    name,
    modelId,
    symbol,
    environment,
    leverage,
    capitalAllocation,
    parameters,
    levels,
    targets,
    sizing
});        NovaUI.toast('Bot instance created', 'success');
        form.reset();
        renderModelParamFields(document.getElementById('instModel').value);
        closeCreateModal();
        await loadInstances();
      } catch (err) {
        alertBox.textContent = NovaUI.errorMessage(err);
        alertBox.classList.remove('hidden');
      }
    }));
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadModels();
    loadSymbols();
    loadInstances();
    setupCreateForm();

    // PART 13 -- PHASE O: only show the Lot/Contract Quantity input when
    // Sizing Mode is LOT; CAPITAL mode uses the existing dynamic sizing.
    const sizingModeEl = document.getElementById('instSizingMode');
    const lotValueFieldEl = document.getElementById('instLotValueField');
    if (sizingModeEl && lotValueFieldEl) {
      sizingModeEl.addEventListener('change', () => {
        lotValueFieldEl.style.display = sizingModeEl.value === 'LOT' ? '' : 'none';
      });
    }

document.getElementById('instModel').addEventListener('change', (e) => {

    const modelId = e.target.value;

    renderModelParamFields(modelId);

    // Find selected model
    const model = registeredModels.find(m => m.modelId === modelId);

    if (!model) return;

    // Update Auto Configuration
    document.getElementById("autoTimeframe").textContent =
        `Auto (${model.defaultConfig?.timeframe || "-"})`;

    document.getElementById("autoStrategy").textContent =
        model.name || model.modelId;

});
    document.getElementById('openCreateModalBtn').addEventListener('click', openCreateModal);
    document.getElementById('closeCreateModalBtn').addEventListener('click', closeCreateModal);
    document.getElementById('createBotModal').addEventListener('click', (e) => {
      if (e.target.id === 'createBotModal') closeCreateModal();
    });

    NovaSocket.on('bot:status', loadInstances);
    NovaSocket.on('bot:event', loadInstances);
    NovaSocket.on('position:update', loadInstances);

    setInterval(loadInstances, 20000);
  });
})();
document.addEventListener('click', function (e) {
    const btn = e.target.closest('.view-bot-btn');
    if (!btn) return;

    e.preventDefault();

    const instanceId = btn.dataset.instance;
    if (!instanceId) return;

    window.open(
        `/bots/${encodeURIComponent(instanceId)}`,
        '_blank',
        'noopener,noreferrer'
    );
});