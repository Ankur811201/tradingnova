/**
 * Terminal UI Controller orchestrating REST fetch operations and UI renders.
 */
document.addEventListener('DOMContentLoaded', async () => {
  const chartManager = new ChartManager('chart-element');

  const sync = new ChartSync(chartManager, {
    onHealthChange: (key, status) => updateHealthIndicator(key, status),
    onCandle: (data) => updateCountdownAndHeader(data),
    onDecision: (decision) => renderDecisionMatrix(decision),
    onPosition: (data) => renderActivePosition(data),
    onLog: (log) => appendConsoleLog(log),
  });

  // Load Initial API Data
  await fetchHistoricalData(chartManager);
  await fetchBotState();
  await fetchPerformanceMetrics();

  // Establish WS Stream
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  sync.connect(`${protocol}//${window.location.host}/ws`);

  // Bind Actions
  bindControlButtons();
  bindConfigForm();
});

async function fetchHistoricalData(chartManager) {
  try {
    const res = await fetch('/api/candles?symbol=BTCUSDT&timeframe=1m');
    const json = await res.json();
    chartManager.loadHistoricalData(json.candles, json.indicators);
  } catch (err) {
    appendConsoleLog({ level: 'ERROR', message: 'Failed loading historical candles' });
  }
}

async function fetchBotState() {
  try {
    const res = await fetch('/api/bot/state');
    const state = await res.json();
    renderBotState(state);
  } catch (err) {
    appendConsoleLog({ level: 'ERROR', message: 'Failed loading bot state' });
  }
}

async function fetchPerformanceMetrics() {
  try {
    const res = await fetch('/api/bot/performance');
    const perf = await res.json();
    renderPerformancePanel(perf);
  } catch (err) {
    appendConsoleLog({ level: 'ERROR', message: 'Failed performance update' });
  }
}

function renderDecisionMatrix(data) {
  const container = document.getElementById('decision-matrix');
  if (!container || !data.rules) return;

  container.innerHTML = data.rules.map(rule => `
    <div class="matrix-row">
      <span>${rule.name}</span>
      <span class="status-pill ${rule.status.toLowerCase()}">${rule.status}</span>
    </div>
  `).join('') + `
    <div style="margin-top:10px; font-weight:bold; font-family:var(--font-mono)">
      DECISION: <span style="color:${data.decision === 'BUY' ? 'var(--green)' : data.decision === 'SELL' ? 'var(--red)' : 'var(--yellow)'}">${data.decision}</span>
      <div style="font-size:10px; color:var(--text-muted); margin-top:4px;">${data.reason}</div>
    </div>
  `;
}

function renderActivePosition(data) {
  const container = document.getElementById('active-position-panel');
  const pos = data.position;
  
  if (!pos || pos.side === 'NONE') {
    container.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding:20px;">NO OPEN POSITION</div>`;
    return;
  }

  const pnlColor = pos.profit >= 0 ? 'var(--green)' : 'var(--red)';
  container.innerHTML = `
    <div style="font-family:var(--font-mono); display:grid; grid-template-columns:1fr 1fr; gap:8px;">
      <div>SIDE: <strong style="color:${pos.side === 'LONG' ? 'var(--green)' : 'var(--red)'}">${pos.side}</strong></div>
      <div>ENTRY: <strong>${pos.entryPrice}</strong></div>
      <div>PRICE: <strong>${pos.currentPrice}</strong></div>
      <div>PNL: <strong style="color:${pnlColor}">${pos.profit} (${pos.profitPct}%)</strong></div>
      <div>SL: <strong>${pos.stopLoss}</strong></div>
      <div>TP: <strong>${pos.takeProfit}</strong></div>
    </div>
    <button class="btn btn-red" style="width:100%; margin-top:10px;" onclick="closePosition()">CLOSE POSITION</button>
  `;
}

function renderPerformancePanel(perf) {
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerText = val;
  };
  setVal('perf-today-pnl', perf.todayPnL);
  setVal('perf-total-pnl', perf.totalPnL);
  setVal('perf-win-rate', `${perf.winRate}%`);
  setVal('perf-profit-factor', perf.profitFactor);
  setVal('perf-max-drawdown', `${perf.maxDrawdown}%`);
}

function appendConsoleLog(log) {
  const container = document.getElementById('console-logs');
  if (!container) return;
  const timeStr = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line ${log.level || 'INFO'}`;
  line.innerHTML = `<span class="log-time">[${timeStr}]</span> <span class="log-text">${log.message}</span>`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

function updateHealthIndicator(key, isOk) {
  const el = document.getElementById(`health-${key}`);
  if (el) el.className = `dot ${isOk ? 'dot-green' : 'dot-red'}`;
}

function bindControlButtons() {
  document.getElementById('btn-start')?.addEventListener('click', () => sendBotCommand('/api/bot/start'));
  document.getElementById('btn-pause')?.addEventListener('click', () => sendBotCommand('/api/bot/pause'));
  document.getElementById('btn-stop')?.addEventListener('click', () => sendBotCommand('/api/bot/stop'));
  document.getElementById('btn-restart')?.addEventListener('click', () => sendBotCommand('/api/bot/restart'));
}

async function sendBotCommand(endpoint) {
  try {
    await fetch(endpoint, { method: 'POST' });
    fetchBotState();
  } catch (err) {
    appendConsoleLog({ level: 'ERROR', message: `Command ${endpoint} failed` });
  }
}

function bindConfigForm() {
  document.getElementById('config-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const body = Object.fromEntries(formData.entries());

    try {
      await fetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      appendConsoleLog({ level: 'INFO', message: 'Config updated successfully' });
    } catch (err) {
      appendConsoleLog({ level: 'ERROR', message: 'Config update failed' });
    }
  });
}