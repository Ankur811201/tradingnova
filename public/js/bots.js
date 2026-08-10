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

 async function loadModels() {

    const container = document.getElementById('modelsList');

    try {

        const models = await NovaApi.get('/api/bot-models');

        modelsById = {};

        models.forEach(m => {
            modelsById[m.modelId] = m;
        });

        // Only update modelsList if it exists
        if (container) {
            container.innerHTML = models.length
                ? models.map(m => `
                    <div class="model-card">
                        <h3>${escapeHtml(m.name || m.modelId)}</h3>
                        <p>${escapeHtml(m.description || "")}</p>
                    </div>
                `).join('')
                : '<div class="empty-state">No Bot Models Installed</div>';
        }

    } catch (err) {

        console.error(err);

        if (container) {
            container.innerHTML =
                '<div class="empty-state">Unable to load bot models</div>';
        }
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

  // MODEL_002-only display (confirmed requirement §8): trend, support/
  // resistance configuration, leverage, and max capital, sourced entirely
  // from instance.parameters/capitalAllocation/leverage — nothing invented,
  // nothing shown for any other (e.g. obsolete MODEL_001) model.
  function buildModel002InfoBlock(instance) {
    if (instance.modelId !== 'MODEL_002') return '';
    const p = instance.parameters || {};
    const trend = p.trend || '—';
    const support = Array.isArray(p.support) ? p.support.join(' / ') : '—';
    const resistance = Array.isArray(p.resistance) ? p.resistance.join(' / ') : '—';
    const trendCls = trend === 'BULLISH' ? 'pnl-positive' : trend === 'BEARISH' ? 'pnl-negative' : '';
    return `
    <div class="info-grid mt-16">
      ${infoTile('Trend', escapeHtml(trend), trendCls)}
      ${infoTile('Leverage', escapeHtml(String(instance.leverage || 1)) + 'x')}
      ${infoTile('Max Capital', formatUsd(instance.capitalAllocation))}
      ${infoTile('Support', escapeHtml(support))}
      ${infoTile('Resistance', escapeHtml(resistance))}
    </div>`;
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

    ${buildModel002InfoBlock(instance)}

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

  function readNumberField(id) {
    const raw = document.getElementById(id).value;
    return raw === '' ? NaN : Number(raw);
  }

  /** Validates the MODEL_002-specific fields; returns {parameters} or {error}. */
  function collectAndValidateModel002Fields() {
    const trendEl = document.querySelector('input[name="instTrend"]:checked');
    const timeframeEl = document.querySelector('input[name="instTimeframe"]:checked');
    const trend = trendEl ? trendEl.value : null;
    const timeframe = timeframeEl ? timeframeEl.value : null;

    if (trend !== 'BULLISH' && trend !== 'BEARISH') {
      return { error: 'Select a market trend (Bullish or Bearish).' };
    }
    if (timeframe !== '1m' && timeframe !== '3m') {
      return { error: 'Select an execution timeframe (1 Minute or 3 Minutes).' };
    }

    const resistance = [
      readNumberField('instResistance1'),
      readNumberField('instResistance2'),
      readNumberField('instResistance3'),
    ];
    const support = [
      readNumberField('instSupport1'),
      readNumberField('instSupport2'),
      readNumberField('instSupport3'),
    ];

    for (const level of resistance) {
      if (!Number.isFinite(level) || level <= 0) return { error: 'All 3 Resistance Levels are required and must be positive numbers.' };
    }
    for (const level of support) {
      if (!Number.isFinite(level) || level <= 0) return { error: 'All 3 Support Levels are required and must be positive numbers.' };
    }

    // Field names match the existing MODEL_002 parameter contract exactly
    // (bot-models/model-002/config.js / validators.js: `trend`, `support`,
    // `resistance`, `timeframe`) — no new backend parameter names invented.
    return { parameters: { trend, support, resistance, timeframe } };
  }

  function setupCreateForm() {
    const form = document.getElementById('createForm');
    const btn = document.getElementById('createBtn');
    const alertBox = document.getElementById('createAlert');
    form.addEventListener('submit', NovaApi.withButtonLoading(btn, async (e) => {
      e.preventDefault();
      alertBox.classList.add('hidden');

      const name = document.getElementById('instName').value.trim();
      // Bot Model is fixed/readonly — always MODEL_002. No dropdown, no
      // possibility of MODEL_001 (or anything else) ever being submitted.
      const modelId = 'MODEL_002';
      const symbol = document.getElementById('instSymbol').value;
      const environment = document.getElementById('instEnv').value;
      const leverage = readNumberField('instLeverage');
      const capitalAllocation = readNumberField('instCapital');

      if (!name) {
        alertBox.textContent = 'Bot name is required.';
        alertBox.classList.remove('hidden');
        return;
      }
      if (!symbol || !environment) {
        alertBox.textContent = 'Trading pair and trading mode are required.';
        alertBox.classList.remove('hidden');
        return;
      }
      if (!Number.isFinite(capitalAllocation) || capitalAllocation <= 0) {
        alertBox.textContent = 'Maximum Capital must be a positive number.';
        alertBox.classList.remove('hidden');
        return;
      }
      if (!Number.isFinite(leverage) || leverage < 1 || leverage > 200) {
        alertBox.textContent = 'Leverage must be between 1x and 200x.';
        alertBox.classList.remove('hidden');
        return;
      }

      // MODEL_002 payload: ONLY the fields this model uses. No levels/
      // targets/sizing/legacy technical parameters exist anywhere in this
      // form, so there is nothing legacy left to accidentally include.
      const result = collectAndValidateModel002Fields();
      if (result.error) {
        alertBox.textContent = result.error;
        alertBox.classList.remove('hidden');
        return;
      }

      const payload = { name, modelId, symbol, environment, leverage, capitalAllocation, parameters: result.parameters };

      try {
        await NovaApi.post('/api/bot-instances', payload);
        NovaUI.toast('Bot instance created', 'success');
        form.reset();
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