document.addEventListener('DOMContentLoaded', () => {
  // =========================================================
  // CONFIG
  // =========================================================

  const { instanceId, modelId, pair } = window.BOT_CONFIG;

  // =========================================================
  // SOCKET CONNECTION — shared across the page (see bot-socket.js).
  // bot-detail-chart.js reuses this exact same connection/subscription
  // for live candle updates instead of opening a second socket.
  // =========================================================

  const socket = window.NovaBotSocket;


  if (!socket) {
    console.error('[BOT DETAIL] window.NovaBotSocket is missing — was bot-socket.js loaded before bot-detail-ws.js?');
    return;
  }

  // =========================================================
  // CHART
  // =========================================================
  //
  // Historical candle rendering now lives in bot-detail-chart.js (real
  // MongoDB-backed candles via ChartManager/Lightweight Charts). This file
  // no longer creates the chart itself. `chartBridge` stays null here — it
  // previously pointed at the TradingView widget bridge (now removed from
  // this page) and position/SL/TP overlays on the new chart are a later
  // part, not Part 4.

  const chartBridge = null;


  // =========================================================
  // GLOBAL MARKET PRICE
  // =========================================================

  socket.on('market:price', (data) => {

    // Ignore ETHUSD etc.
    if (!data || data.symbol !== pair) {
      return;
    }

    const price = Number(data.price);

    if (!Number.isFinite(price)) {
      return;
    }

    const priceEl = document.getElementById('market-price');

    if (priceEl) {
      priceEl.textContent = `$${price.toFixed(2)}`;
    }


    // Chart price-axis label (#chart-price-label): the SAME live Delta price
    // from this SAME handler -- no extra socket, no extra poll. The label
    // module writes the text and re-derives its Y coordinate from the
    // chart's own priceToCoordinate() so it stays pinned to the price level.
    // Before the chart has finished initialising this is a no-op, and the
    // dashboard CURRENT PRICE metric above is unaffected either way.
    if (window.NovaChartPriceLabel) {
      window.NovaChartPriceLabel.setPrice(price);
    }


    // Update current position price if position exists
    const positionPriceEl =
      document.getElementById('pos-current-price');

    if (positionPriceEl) {
      positionPriceEl.textContent = `$${price.toFixed(2)}`;
    }
  });


  // =========================================================
  // MARKET STATUS
  // =========================================================





 socket.on('market:status', (data) => {
  if (!data) return;

  const marketEl = document.getElementById('stat-market-condition');
  const connectionEl = document.getElementById('chart-connection-status');

  if (marketEl) {
    marketEl.textContent = data.connected ? 'LIVE' : 'OFFLINE';

    marketEl.className = data.connected
      ? 'text-sm font-bold text-emerald-400'
      : 'text-sm font-bold text-rose-400';
  }

  if (connectionEl) {
    connectionEl.innerHTML = data.connected
      ? '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Delta Live'
      : '<span class="w-2 h-2 rounded-full bg-rose-500"></span> Disconnected';
  }
});


  // =========================================================
  // BOT TICK — TELEMETRY ONLY, NEVER AUTHORITATIVE
  // =========================================================
  //
  // NOVA TRADE -- PART 9: bot:tick is emitted by the legacy
  // BotEngineManager (services/BotEngineManager.js), which has had zero
  // trading authority since Part 7 and always carries
  // `instance.currentPosition = null` in practice (handleTradeExecution is
  // a documented no-op). Even so, per the Part 9 authority rule, this
  // handler must NEVER again write to Current Position / Current PnL /
  // Trade History / Performance — those are owned exclusively by the
  // authoritative `bot:execution` handler below. Only a harmless heartbeat
  // price mirror remains (market:price already covers this in practice).
  socket.on('bot:tick', (data) => {

    if (!data || data.instanceId !== instanceId) {
      return;
    }


    const price = Number(data.price);

    if (Number.isFinite(price)) {
      const priceEl = document.getElementById('market-price');
      if (priceEl) {
        priceEl.textContent = `$${price.toFixed(2)}`;
      }
    }
  });


  // =========================================================
  // AUTHORITATIVE EXECUTION UPDATES (Current Position / Trade
  // History / Performance)
  // =========================================================
  //
  // NOVA TRADE -- PART 9: `bot:execution` is emitted ONLY by
  // services/botManager/BotManager.js, and only strictly AFTER
  // ExecutionRouter has successfully routed a command to
  // PaperEngine/LiveEngine (see BotManager._emitExecutionUpdate). It is
  // never emitted for a RiskEngine rejection and never derived from a
  // MODEL_001 decision alone — a BUY/SELL decision must NOT change this
  // panel until execution actually succeeds.
  //
  // performanceState mirrors window.BOT_PERFORMANCE (server-computed on
  // page load) and is updated in place as new authoritative closed trades
  // arrive, so the Performance tab/quick-stats stay correct without
  // requiring a page reload (Test K).
  const performanceState = window.BOT_PERFORMANCE
    ? Object.assign({}, window.BOT_PERFORMANCE)
    : {
        totalTrades: 0, winningTrades: 0, losingTrades: 0,
        totalProfit: 0, grossProfit: 0, grossLoss: 0,
        winRate: null, profitFactor: null, todayProfit: 0, maxDrawdown: 0,
      };

  // PART 14 -- PHASE H: running peak of cumulative realized PnL for live
  // drawdown tracking. The client only has the server-computed summary
  // (totalProfit, maxDrawdown) at page load, not the full per-trade curve,
  // so the true historical peak is reconstructed as totalProfit +
  // maxDrawdown -- the minimum peak consistent with the server's own
  // computeMaxDrawdown result (peak - trough = maxDrawdown, current
  // cumulative = totalProfit). This never understates the real peak, so a
  // live update this session can only report a drawdown >= the true one,
  // never a falsely small one. A hard page refresh always shows the exact
  // server-computed value regardless.
  if (!Number.isFinite(performanceState.maxDrawdown)) performanceState.maxDrawdown = 0;
  let drawdownPeak = (Number.isFinite(performanceState.totalProfit) ? performanceState.totalProfit : 0)
    + performanceState.maxDrawdown;

  function renderCurrentPosition(position) {
    const content = document.getElementById('position-card-content');
    if (!content) return;

    if (!position) {
      content.innerHTML =
        '<div id="position-card-empty" class="text-center py-6 text-gray-500 italic flex flex-col items-center gap-2">' +
        'No Active Open Position</div>';
      const pnlMirror = document.getElementById('pos-pnl-mirror');
      if (pnlMirror) pnlMirror.textContent = '--';
      return;
    }

    const pnl = Number(position.unrealizedPnl);
    const pnlCls = pnl >= 0 ? 'text-emerald-400' : 'text-rose-400';
    const pnlPct = position.margin ? (pnl / position.margin) * 100 : null;

    content.innerHTML = `
      <div class="flex justify-between items-center">
        <span class="text-gray-400">Side</span>
        <span class="font-bold ${position.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}">${position.side} ${position.leverage}x</span>
      </div>
      <div class="flex justify-between"><span class="text-gray-400">Symbol</span><span class="font-mono">${position.symbol}</span></div>
      <div class="flex justify-between"><span class="text-gray-400">Quantity</span><span class="font-mono">${position.quantity}</span></div>
      <div class="flex justify-between"><span class="text-gray-400">Entry Price</span><span class="font-mono">$${position.entryPrice}</span></div>
      <div class="flex justify-between"><span class="text-gray-400">Current Price</span><span id="pos-current-price" class="font-mono">$${position.currentPrice}</span></div>
      <div class="flex justify-between"><span class="text-gray-400">Unrealized PnL</span>
        <span id="pos-pnl" class="font-mono font-bold ${pnlCls}">$${Number.isFinite(pnl) ? pnl.toFixed(2) : '0.00'}${pnlPct != null ? ` (${pnlPct.toFixed(2)}%)` : ''}</span>
      </div>
      <div class="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-white/5">
        <div><span class="text-gray-500">TP:</span> <span class="font-mono text-emerald-400">${position.takeProfit != null ? `$${position.takeProfit}` : 'N/A'}</span></div>
        <div><span class="text-gray-500">SL:</span> <span class="font-mono text-rose-400">${position.stopLoss != null ? `$${position.stopLoss}` : 'N/A'}</span></div>
      </div>
      <div class="text-[10px] text-gray-500 pt-1">Opened ${position.openedAt ? new Date(position.openedAt).toLocaleString() : 'N/A'}</div>
    `;

    const pnlMirror = document.getElementById('pos-pnl-mirror');
    if (pnlMirror) {
      pnlMirror.innerHTML = `<span class="${pnlCls}">$${Number.isFinite(pnl) ? pnl.toFixed(2) : '0.00'}</span>`;
    }
  }

  function prependTradeHistoryRow(trade) {
    const tbody = document.getElementById('trade-history-body');
    if (!tbody) return;

    const emptyRow = tbody.querySelector('td[colspan]');
    if (emptyRow) tbody.innerHTML = '';

    const pnl = Number(trade.realizedPnl);
    const sideCls = trade.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400';
    const pnlCls = pnl >= 0 ? 'text-emerald-400' : 'text-rose-400';

    const row = document.createElement('tr');
    row.className = 'hover:bg-white/[0.03] transition';
    row.innerHTML = `
      <td class="py-2.5 pr-3 font-bold ${sideCls}">${trade.side}</td>
      <td class="py-2.5 pr-3">$${trade.entryPrice}</td>
      <td class="py-2.5 pr-3">$${trade.exitPrice}</td>
      <td class="py-2.5 pr-3 font-bold ${pnlCls}">$${Number.isFinite(pnl) ? pnl.toFixed(2) : '0.00'}</td>
      <td class="py-2.5 text-gray-400 text-[10px]">${trade.reason || 'N/A'}</td>
    `;
    tbody.insertBefore(row, tbody.firstChild);
  }

  function isToday(dateVal) {
    const d = new Date(dateVal);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
  }

  function applyTradeToPerformance(trade) {
    const pnl = Number(trade.realizedPnl);
    if (!Number.isFinite(pnl)) return;

    performanceState.totalTrades = (performanceState.totalTrades || 0) + 1;
    performanceState.totalProfit = (performanceState.totalProfit || 0) + pnl;
    if (pnl > 0) {
      performanceState.winningTrades = (performanceState.winningTrades || 0) + 1;
      performanceState.grossProfit = (performanceState.grossProfit || 0) + pnl;
    } else if (pnl < 0) {
      performanceState.losingTrades = (performanceState.losingTrades || 0) + 1;
      performanceState.grossLoss = (performanceState.grossLoss || 0) + Math.abs(pnl);
    }
    performanceState.winRate = performanceState.totalTrades > 0
      ? (performanceState.winningTrades / performanceState.totalTrades) * 100
      : null;
    performanceState.profitFactor = performanceState.grossLoss > 0
      ? performanceState.grossProfit / performanceState.grossLoss
      : (performanceState.grossProfit > 0 ? Infinity : null);
    if (trade.closedAt && isToday(trade.closedAt)) {
      performanceState.todayProfit = (performanceState.todayProfit || 0) + pnl;
    }

    // PART 14 -- PHASE H: walk the running peak/drawdown forward by this
    // one real closed trade, same formula as utils/performance.js's
    // computeMaxDrawdown.
    if (performanceState.totalProfit > drawdownPeak) drawdownPeak = performanceState.totalProfit;
    const currentDrawdown = drawdownPeak - performanceState.totalProfit;
    if (currentDrawdown > performanceState.maxDrawdown) performanceState.maxDrawdown = currentDrawdown;

    renderPerformance();
  }

  function renderPerformance() {
    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    const totalProfitEl = document.getElementById('perf-total-pnl');
    if (totalProfitEl) {
      totalProfitEl.textContent = `$${performanceState.totalProfit.toFixed(2)}`;
      totalProfitEl.className = `text-lg font-bold font-mono ${performanceState.totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'} mt-1`;
    }

    setText('perf-winrate', performanceState.winRate != null ? `${performanceState.winRate.toFixed(1)}%` : '--');

    const pf = performanceState.profitFactor;
    setText('perf-profit-factor', pf == null ? '--' : (pf === Infinity ? '∞' : pf.toFixed(2)));

    setText('perf-total-trades', String(performanceState.totalTrades || 0));
    setText('perf-winning-trades', String(performanceState.winningTrades || 0));
    setText('perf-losing-trades', String(performanceState.losingTrades || 0));
    setText('perf-drawdown', `$${(Number.isFinite(performanceState.maxDrawdown) ? performanceState.maxDrawdown : 0).toFixed(2)}`);

    const todayEl = document.getElementById('stat-today-profit');
    if (todayEl) {
      todayEl.textContent = `$${(performanceState.todayProfit || 0).toFixed(2)}`;
      todayEl.className = `text-sm font-bold font-mono ${(performanceState.todayProfit || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
    }
  }

  // =========================================================
  // NOVA TRADE -- PART 15 PHASE B/STEP 4-5: Live Trade Story
  // =========================================================
  //
  // Appends a real lifecycle step to #trade-timeline. Reuses the exact
  // timeline DOM structure the server already renders (see
  // views/bot-detail.ejs / utils/tradeStory.js) so live steps are visually
  // identical to the server-rendered history, and appends to the RIGHT
  // (newest-last), matching the chronological-ascending order the server
  // renders in. This is a distinct concern from bot:execution's job
  // (Position card / Trade History / Performance / Markers) -- it never
  // re-renders those, only adds a narrative entry, so nothing here
  // duplicates bot:execution's work.
  const TIMELINE_TONE_CLASS = {
    buy: 'bg-emerald-400', sell: 'bg-rose-400',
    profit: 'bg-emerald-400', loss: 'bg-rose-400',
    reject: 'bg-amber-400',
  };

  function appendTradeStoryStep(label, detail, tone) {
    const track = document.getElementById('trade-timeline');
    if (!track) return;

    const empty = track.querySelector('.italic');
    if (empty && track.children.length === 1) {
      track.innerHTML = '';
    }

    // Any previously-last step needs its connector chevron restored, since
    // the new step becomes the true last one.
    const prevStep = track.lastElementChild;
    if (prevStep && !prevStep.querySelector('[data-story-chevron]')) {
      const chevron = document.createElement('i');
      chevron.setAttribute('data-lucide', 'chevron-right');
      chevron.setAttribute('data-story-chevron', '1');
      chevron.className = 'hidden sm:block w-4 h-4 text-gray-600 shrink-0';
      prevStep.appendChild(chevron);
    }

    const wrap = document.createElement('div');
    wrap.className = 'relative flex items-center gap-2 sm:flex-1';

    const dot = document.createElement('span');
    dot.className = `w-2.5 h-2.5 rounded-full shrink-0 -ml-6 sm:ml-0 ${TIMELINE_TONE_CLASS[tone] || 'bg-amber-400'}`;

    const card = document.createElement('div');
    card.className = 'glass-tight rounded-lg px-3 py-2 flex-1';
    const labelEl = document.createElement('div');
    labelEl.className = 'text-gray-200 font-semibold';
    labelEl.textContent = label;
    const detailEl = document.createElement('div');
    detailEl.className = 'text-gray-500 text-[10px] truncate max-w-[160px]';
    detailEl.textContent = detail || '';
    card.appendChild(labelEl);
    card.appendChild(detailEl);

    wrap.appendChild(dot);
    wrap.appendChild(card);
    track.appendChild(wrap);

    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try { window.lucide.createIcons(); } catch (err) { /* icon refresh is cosmetic only */ }
    }
  }

  // Five events with no prior frontend consumer (see Part 15 Phase B Step
  // 1 matrix) -- each becomes exactly one Live Trade Story step. None of
  // these touch the Position card, Trade History, or Performance, since
  // bot:execution already owns that state authoritatively; wiring them
  // there too would be a duplicate/conflicting write path.
  socket.on('position:opened', (data) => {
    if (!data || data.instanceId !== instanceId || !data.position) return;
    const p = data.position;
    appendTradeStoryStep('Position Open', `${p.side} @ $${p.entryPrice}`, p.side === 'LONG' ? 'buy' : 'sell');
  });

  socket.on('position:closed', (data) => {
    if (!data || data.instanceId !== instanceId || !data.position) return;
    const p = data.position;
    appendTradeStoryStep('Position Closed', p.closeReason || 'CLOSE', 'sell');
  });

  socket.on('trade:created', (data) => {
    if (!data || data.instanceId !== instanceId || !data.trade) return;
    const t = data.trade;
    const pnl = Number(t.realizedPnl);
    const pnlText = Number.isFinite(pnl) ? `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}` : '';
    appendTradeStoryStep('Trade Recorded', `${t.reason || 'CLOSE'} · ${pnlText}`, Number.isFinite(pnl) && pnl >= 0 ? 'profit' : 'loss');
  });

  socket.on('risk:rejected', (data) => {
    if (!data || data.instanceId !== instanceId) return;
    appendTradeStoryStep('Risk Rejected', data.reason || `${data.action || ''} ${data.symbol || ''}`.trim(), 'reject');
  });

  socket.on('trade:rejected', (data) => {
    if (!data || data.instanceId !== instanceId) return;
    appendTradeStoryStep('Execution Rejected', data.reason || `${data.action || ''} ${data.symbol || ''}`.trim(), 'reject');
  });

  socket.on('bot:execution', (data) => {

    if (!data || data.instanceId !== instanceId) {
      return;
    }


    renderCurrentPosition(data.position);

    if (data.trade) {
      prependTradeHistoryRow(data.trade);
      applyTradeToPerformance(data.trade);
    }

    // Chart position overlays — Part 9 does not add markers/lines yet
    // (see "DO NOT ADD CHART ARROWS YET"); left as a hook only.
    if (chartBridge && typeof chartBridge.syncPositionLayers === 'function') {
      try {
        chartBridge.syncPositionLayers(data.position);
      } catch (err) {
        console.error('[CHART] Position overlay failed:', err);
      }
    }

    // NOVA TRADE -- PART 10: real executed BUY/SELL/EXIT markers. Reuses
    // this same authoritative bot:execution event (never bot:decision --
    // see execution-markers.js docstring) and the shared chart instance
    // exposed by bot-detail-chart.js (window.NovaBotChartManager). Markers
    // are derived, not fabricated: deriveLiveMarkers() only ever produces
    // an entry from a real OPEN position or an entry+exit from a real
    // closed Trade.
    if (window.NovaBotChartManager && typeof window.NovaBotChartManager.addExecutionMarker === 'function' &&
        typeof window.NovaExecutionMarkers !== 'undefined') {
      try {
        // PART 13.1 -- PHASE D: no '5m' fallback. A bot cannot be RUNNING
        // (and therefore cannot emit a real bot:execution event) unless it
        // already has an explicit configured timeframe (see
        // bot-models/model-001/validators.js), so this is a defensive
        // bail-out only, never a guess.
        // ACTIVE analysis timeframe (one-time opposite-market switch): equals
        // BOT_CONFIG.timeframe unless this bot switched to 1m.
        const timeframe = window.BOT_CONFIG && (window.BOT_CONFIG.activeTimeframe || window.BOT_CONFIG.timeframe);
        if (!timeframe) throw new Error('No configured timeframe for this bot; cannot bucket execution marker');
        const liveMarkers = window.NovaExecutionMarkers.deriveLiveMarkers(data, timeframe);
        liveMarkers.forEach((marker) => window.NovaBotChartManager.addExecutionMarker(marker));
      } catch (err) {
        console.error('[CHART] Execution marker update failed:', err);
      }
    }
  });


  // =========================================================
  // REAL DECISION ENGINE (model-agnostic, authoritative)
  // =========================================================
  //
  // NOVA TRADE -- PART 8 (later extended for MODEL_002): `bot:decision`
  // (emitted by BotManager only when a real StrategyEvent of eventType
  // 'DECISION' is produced by whichever model is actually running — see
  // services/botManager/BotManager.js and each model's own
  // onMarketData/_emitDecision, e.g. bot-models/model-001/Model001.js or
  // bot-models/model-002/Model002.js) is the ONLY source that writes to
  // the Decision Engine panel. This is called both for the server-rendered
  // initial decision on page load (window.BOT_INITIAL_DECISION) and for
  // every live event. The `modelId` used below to select a renderer comes
  // from window.BOT_CONFIG.modelId — the actual bot's real model, never
  // hardcoded or defaulted to MODEL_001.

  function renderDecision(data) {
    if (!data) return;

    // Mark latest engine update
    lastDecisionUpdate = Date.now();

    // Strategy checks — real analysis from whichever model produced this
    // decision, or null (unavailable). Rendered via ModelThinkingRegistry,
    // which picks the renderer matching the bot's actual modelId.
    const checksContainer =
      document.getElementById('thinking-checks');

    if (checksContainer && window.ModelThinkingRegistry) {
      try {
        window.ModelThinkingRegistry.render(
          modelId,
          checksContainer,
          data.checks || null
        );
      } catch (err) {
        console.error('[DECISION] Renderer failed:', err);
      }
    }

    // MODEL_002 same-side pattern chart overlay — draws the real, fixed
    // Candle2 upper/lower boundaries the strategy is actually watching, and
    // clears them once the pattern resolves (BUY/SELL/INVALID/back to
    // IDLE). Uses only what the backend actually computed
    // (data.checks.boundaries) — no invented lines.
    if (modelId === 'MODEL_002' && window.NovaChartPatternOverlay) {
      try {
        var boundaries = data.checks && data.checks.boundaries;
        if (boundaries && boundaries.upper != null && boundaries.lower != null) {
          window.NovaChartPatternOverlay.setBoundaries(boundaries.upper, boundaries.lower);
        } else {
          window.NovaChartPatternOverlay.clearBoundaries();
        }
      } catch (err) {
        console.error('[DECISION] Pattern boundary overlay failed:', err);
      }
    }

    // Final Decision (WAIT / BUY / SELL)
    const decisionEl =
      document.getElementById('thinking-decision');

    if (decisionEl) {
      decisionEl.textContent = data.decision || 'WAIT';
      decisionEl.className =
        'text-2xl font-display font-bold uppercase leading-none mb-2 ' +
        (data.decision === 'BUY' ? 'text-emerald-400'
          : data.decision === 'SELL' ? 'text-rose-400'
          : 'text-blue-400');
    }

    // Reason — the real reason from the actual decision event, never a
    // fabricated one. MODEL_002's own reason field is an internal
    // snake_case code (e.g. candle1_support_touch_awaiting_candle2) —
    // routed through the single shared formatter (model002-reason-map.js,
    // also used server-side for Decision History) so live and
    // server-rendered text always match. MODEL_001's reason strings are
    // already human-readable sentences and are left untouched.
    const reasonEl =
      document.getElementById('thinking-reason');

    if (reasonEl) {
      const rawReason = data.reason || '';
      const formattedReason = (modelId === 'MODEL_002' && window.Model002ReasonMap)
        ? window.Model002ReasonMap.formatModel002Reason(rawReason)
        : rawReason;
      reasonEl.textContent = formattedReason || 'Monitoring market conditions...';
    }

    prependDecisionHistoryRow(data);

    // PART 15 PHASE B/STEP 5: BUY/SELL decisions are also a Live Trade
    // Story beat. Reuses this existing bot:decision handler rather than
    // adding a second `socket.on('bot:decision', ...)` listener. WAIT is
    // intentionally excluded -- it isn't a story beat, just monitoring.
    if (data.decision === 'BUY' || data.decision === 'SELL') {
      const storyReason = (modelId === 'MODEL_002' && window.Model002ReasonMap)
        ? window.Model002ReasonMap.formatModel002Reason(data.reason)
        : (data.reason || '');
      appendTradeStoryStep(data.decision, storyReason, data.decision === 'BUY' ? 'buy' : 'sell');
    }
  }

  // Prepend a live row to the Decision History tab so it doesn't require a
  // page reload to see a just-produced decision (Phase G).
  function prependDecisionHistoryRow(data) {
    const container = document.getElementById('signal-history-container');
    if (!container) return;

    // Clear the "no decisions yet" empty state, if present.
    const empty = container.querySelector('.italic');
    if (empty && container.children.length === 1) {
      container.innerHTML = '';
    }

    const row = document.createElement('div');
    row.className = 'flex justify-between items-center py-2 px-2 rounded-lg hover:bg-white/[0.03] border-b border-white/5';

    const decisionColor = data.decision === 'BUY' ? 'text-emerald-400'
      : data.decision === 'SELL' ? 'text-rose-400'
      : 'text-amber-400';

    const time = document.createElement('span');
    time.className = 'text-gray-500 shrink-0';
    time.textContent = new Date().toLocaleTimeString();

    const decisionSpan = document.createElement('span');
    decisionSpan.className = 'font-bold ' + decisionColor + ' shrink-0';
    decisionSpan.textContent = data.decision || '--';

    const reasonSpan = document.createElement('span');
    reasonSpan.className = 'text-gray-400 truncate max-w-[280px] text-right';
    reasonSpan.textContent = (modelId === 'MODEL_002' && window.Model002ReasonMap)
      ? window.Model002ReasonMap.formatModel002Reason(data.reason)
      : (data.reason || '');

    row.appendChild(time);
    row.appendChild(decisionSpan);
    row.appendChild(reasonSpan);

    container.insertBefore(row, container.firstChild);
  }

  // Render the server-loaded latest real decision immediately (Phase E) —
  // before the first live bot:decision event, if any, arrives.
  if (window.BOT_INITIAL_DECISION) {
    renderDecision(window.BOT_INITIAL_DECISION);
  }

  socket.on('bot:decision', (data) => {

    if (!data || data.instanceId !== instanceId) {
      return;
    }


    renderDecision(data);
  });

  // =========================================================
  // LEGACY bot:thinking — TELEMETRY ONLY, NEVER AUTHORITATIVE
  // =========================================================
  //
  // NOVA TRADE -- PART 8: bot:thinking is emitted by the legacy
  // BotEngineManager/TechnicalAnalysisService mock (see services/
  // TechnicalAnalysisService.js — it literally computes checks from
  // currentPrice * 0.98/0.95/1.05). It must NEVER write to the Decision
  // Engine panel again — the real MODEL_001 bot:decision handler above is
  // the only writer. This listener is intentionally a no-op kept only so a
  // stale/legacy client wiring doesn't throw; remove entirely once nothing
  // else depends on bot:thinking being emitted at all.
  socket.on('bot:thinking', (data) => {
    if (!data || data.instanceId !== instanceId) {
      return;
    }
  });

// Update "Xs ago" every second
setInterval(() => {
  if (!lastDecisionUpdate) return;

  const seconds = Math.floor(
    (Date.now() - lastDecisionUpdate) / 1000
  );

  const el = document.getElementById('decision-last-update');

  if (el) {
    el.textContent = `Updated ${seconds}s ago`;
  }
}, 1000);


  // =========================================================
  // BOT LOG
  // =========================================================

  socket.on('bot:log', (data) => {

    if (!data || data.instanceId !== instanceId) {
      return;
    }


    const terminal =
      document.getElementById('log-terminal');

    if (!terminal) return;


    const logNode =
      document.createElement('div');

    logNode.className =
      'text-gray-300 font-mono';


    const time =
      data.timestamp
        ? new Date(data.timestamp).toLocaleTimeString()
        : new Date().toLocaleTimeString();


    logNode.textContent =
      `[${time}] ` +
      `[${data.level || 'BOT'}] ` +
      `${data.message || ''}`;


    terminal.appendChild(logNode);

    terminal.scrollTop =
      terminal.scrollHeight;
  });


  // =========================================================
  // BOT HEALTH
  // =========================================================

  socket.on('bot:health', (health) => {


    if (!health) return;

    const healthGrid =
      document.getElementById('health-grid');

    if (!healthGrid) return;


    healthGrid.innerHTML =
      Object.entries(health)
        .map(([subsystem, status]) => {

          const isOK =
            status === 'OK';

          return `
            <div class="p-2 bg-gray-950 border border-gray-800 rounded">

              <div class="text-[10px] text-gray-500 uppercase">
                ${subsystem}
              </div>

              <div
                class="
                  font-bold
                  font-mono
                  text-xs
                  ${
                    isOK
                      ? 'text-emerald-400'
                      : 'text-rose-400'
                  }
                "
              >
                ${status}
              </div>

            </div>
          `;

        })
        .join('');
  });


  // =========================================================
  // SYSTEM STATUS — DEBUG EXISTING BACKEND EVENT
  // =========================================================

  socket.on('system:status', (data) => {


  });

});


// ===========================================================
// OVERLAY MODAL
// ===========================================================

window.showOverlayModal = function(metaData) {

  const modal =
    document.getElementById('overlay-modal');

  const modalTitle =
    document.getElementById('modal-title');

  const modalBody =
    document.getElementById('modal-body');


  if (!modal || !modalTitle || !modalBody) {
    return;
  }


  modalTitle.textContent =
    metaData.title || 'Overlay Detail';


  modalBody.innerHTML =
    Object.entries(metaData)

      .filter(([key]) =>
        key !== 'entityId' &&
        key !== 'title'
      )

      .map(([key, val]) => `

        <div class="flex justify-between border-b border-gray-800/50 py-1">

          <span class="text-gray-500 capitalize">
            ${key}:
          </span>

          <span class="text-gray-200">
            ${
              typeof val === 'object'
                ? JSON.stringify(val)
                : val
            }
          </span>

        </div>

      `)

      .join('');


  modal.classList.remove('hidden');
  modal.classList.add('flex');
};


// ===========================================================
// CLOSE MODAL
// ===========================================================

window.closeOverlayModal = function() {

  const modal =
    document.getElementById('overlay-modal');

  if (!modal) return;

  modal.classList.add('hidden');
  modal.classList.remove('flex');
};
