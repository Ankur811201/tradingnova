'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..', '..');
const RUNTIME_DIR = path.join(ROOT, 'storage', 'recording-runtime');


function findBrowser() {
  const configured = process.env.CHROME_PATH || process.env.CHROMIUM_PATH;
  if (configured && fs.existsSync(configured)) return configured;

  const candidates = process.platform === 'win32'
    ? [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : [
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
        '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
      ];

  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function loadLightweightChartsScript() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js'),
    path.join(ROOT, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.development.js'),
  ];
  const file = candidates.find(p => fs.existsSync(p));
  if (!file) {
    throw new Error('lightweight-charts package not installed. Run npm install.');
  }
  return fs.readFileSync(file, 'utf8');
}

function buildRendererHtml() {
  const assets = (name) => pathToFileURL(path.join(ROOT, name)).href;
  const lightweightChartsScript = loadLightweightChartsScript();
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=1380,height=720,initial-scale=1">
<title>NOVA TRADE Recording Renderer</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1380px; height: 720px; overflow: hidden; background: #05060a; }
  body { font-family: Inter, Arial, sans-serif; color: #e5e7eb; }
  #root { position: relative; width: 1380px; height: 720px; background: #05060a; }
  #chart-panel { position: absolute; left: 15px; top: 66px; width: 830px; height: 580px; background: #fff; border-radius: 16px; overflow: hidden; }
  #bot-chart-panel { position: relative; width: 100%; height: 100%; }
  #bot-chart-container { position: absolute; inset: 0; width: 100%; height: 100%; }
  #bot-chart-state { display: none; }
  #chart-price-label { position: absolute; right: 0; z-index: 10; pointer-events: none; transform: translateY(-50%); border-radius: 6px; border: 1px solid rgba(52,211,153,.30); background: rgba(11,18,32,.95); padding: 4px 8px; text-align: center; line-height: 1.1; font-family: 'JetBrains Mono', monospace; }
  #header { position: absolute; left: 15px; right: 15px; top: 15px; height: 38px; display: flex; align-items: center; justify-content: space-between; }
  #title { font-size: 18px; font-weight: 700; }
  #subtitle { color: #60a5fa; font-family: monospace; font-size: 12px; margin-left: 10px; }
  #rec { color: #fb7185; font-family: monospace; font-size: 11px; font-weight: 700; }
  #side { position: absolute; left: 863px; top: 66px; width: 502px; height: 580px; background: #0b0f17; border: 1px solid rgba(255,255,255,.07); border-radius: 16px; padding: 22px; }
  .side-label { color: #64748b; font-size: 10px; text-transform: uppercase; margin-top: 24px; }
  .side-value { color: #e2e8f0; font-family: monospace; font-size: 15px; margin-top: 6px; }
  #decision { font-size: 34px; font-weight: 700; margin-top: 12px; }
  #reason { color: #cbd5e1; font-family: monospace; font-size: 12px; margin-top: 8px; line-height: 1.45; }
</style>
</head>
<body>
<div id="root">
  <div id="header"><div><span id="title">NOVA TRADE</span><span id="subtitle">BTCUSD • 1m • MODEL_002</span></div><div id="rec">● RECORDING 1 FPS • S1</div></div>
  <div id="chart-panel">
    <div id="bot-chart-panel">
      <div id="bot-chart-container"></div>
      <div id="bot-chart-state"></div>
      <div id="chart-price-label" class="hidden">
        <div style="font-size:12px;font-weight:700;color:#fff" id="chart-current-price">--</div>
        <div style="font-size:10px;font-weight:600;color:#34d399" id="chart-next-candle">--:--</div>
      </div>
    </div>
  </div>
  <div id="side">
    <div style="color:#94a3b8;font-size:11px;font-weight:700">BOT DECISION ENGINE</div>
    <div class="side-label">Trend</div><div class="side-value" id="trend">--</div>
    <div class="side-label">Support</div><div class="side-value" id="support">--</div>
    <div class="side-label">Resistance</div><div class="side-value" id="resistance">--</div>
    <div class="side-label">Pattern State</div><div class="side-value" id="pattern">--</div>
    <div class="side-label">Final Decision</div><div id="decision">WAIT</div>
    <div id="reason">--</div>
    <div class="side-label">Touched Level</div><div class="side-value" id="level">--</div>
    <div class="side-label">Recording</div><div class="side-value" id="elapsed">● 0s • 1 FPS</div>
  </div>
</div>

<!-- The recording page intentionally loads the production chart modules in
     the same order/combination as bot-detail.ejs. No replacement chart is
     implemented here. -->
<script>
  window.BOT_RECORDINGS_ENABLED = true;
  window.NOVA_RECORDING_MODE = true;
  window.BOT_CONFIG = __NOVA_BOT_CONFIG__;
  window.BOT_INITIAL_DECISION = __NOVA_INITIAL_DECISION__;
  window.BOT_INITIAL_POSITION = null;
  window.BOT_INITIAL_TRADES = [];
  window.BOT_PERFORMANCE = null;
  window.NovaBotSocket = { on: function () {} };

  // bot-detail-chart.js normally gets its 300-candle snapshot from the
  // authenticated REST endpoint. The headless recorder is intentionally
  // offline from that endpoint, so provide the exact server snapshot through
  // the browser fetch contract. The chart code itself remains production
  // code and performs the same sanitation + setData + fitContent flow.
  window.__NOVA_RECORDING_CANDLES__ = __NOVA_CANDLES__;
  const __novaRealFetch = window.fetch;
  // Keep fetch available for unrelated production modules. bot-detail-chart.js
  // reads __NOVA_RECORDING_CANDLES__ directly when recording mode is enabled.
</script>
<script>${lightweightChartsScript}</script>
<script src="${assets('public/js/chart-manager.js')}"></script>
<script src="${assets('public/js/candle-series.js')}"></script>
<script src="${assets('public/js/overlay-manager.js')}"></script>
<script src="${assets('public/js/marker-manager.js')}"></script>
<script src="${assets('public/js/execution-markers.js')}"></script>
<script src="${assets('public/js/chart-price-label.js')}"></script>
<script src="${assets('public/js/renderers/model002-level-state.js')}"></script>
<script src="${assets('public/js/bot-detail-chart.js')}"></script>
<script src="${assets('services/recording/live-chart-renderer-client.js')}"></script>
</body></html>`;
}

class LiveChartRenderer {
  constructor() {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    this.rendererHtmlPath = path.join(RUNTIME_DIR, `live-chart-renderer-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(this.rendererHtmlPath, buildRendererHtml(), 'utf8');
    this.browser = null;
    this.ws = null;
    this.sessionId = null;
    this.nextId = 1;
    this.recordingUpdateObjectId = null;
  }

  async start(session) {
    const browserPath = findBrowser();
    if (!browserPath) {
      throw new Error('Chrome/Chromium not found. Set CHROME_PATH to a Chrome/Chromium executable.');
    }
    const port = await freePort();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-recording-'));
    this.browser = spawn(browserPath, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--mute-audio', `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    this.browser.on('error', err => console.error(`[RECORDING] browser error: ${err.message}`));
    this.browser.on('exit', (code, signal) => {
      if (this.ws && !this.ws.readyState) return;
      if (code !== 0) console.warn(`[RECORDING] chromium exited code=${code} signal=${signal || '--'}`);
    });

    const started = Date.now();
    let wsUrl = null;
    while (Date.now() - started < 10000) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const info = await response.json();
          wsUrl = info.webSocketDebuggerUrl;
          if (wsUrl) break;
        }
      } catch (_) {}
      await sleep(100);
    }
    if (!wsUrl) throw new Error('Chromium remote debugging endpoint did not start');

    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });

    // Surface renderer-side failures. Previously a blank/headless page could
    // leave startup apparently stuck with only Chromium's DevTools message.
    this.ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (message.method === 'Runtime.consoleAPICalled') {
        const args = (message.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
        if (message.params.type === 'error' || message.params.type === 'warning') {
          console.warn(`[RECORDING][BROWSER] ${message.params.type}: ${args}`);
        }
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const d = message.params.exceptionDetails || {};
        console.error(`[RECORDING][BROWSER] exception: ${d.text || d.exception?.description || 'unknown'}`);
      }
    });

    const initialState = this._publicState(session);
    let rendererHtml = fs.readFileSync(this.rendererHtmlPath, 'utf8');
    const botConfig = {
      instanceId: session.instanceId,
      modelId: 'MODEL_002',
      pair: session.symbol,
      timeframe: session.timeframe || '',
      activeTimeframe: session.timeframe || '',
      timeframeSwitched: false,
      status: 'RUNNING',
      createdAtMs: Number.isFinite(Number(session.createdAtMs)) ? Number(session.createdAtMs) : null,
      levels: null,
      targets: [],
      support: session.support || [],
      resistance: session.resistance || [],
      levelTouch: {
        supportTouched: session.level?.side === 'SUPPORT',
        supportTouchedAt: session.level?.side === 'SUPPORT' ? session.startedAt : null,
        supportTouchedLevel: session.level?.side === 'SUPPORT' ? session.level?.price : null,
        supportTouchedIndex: session.level?.side === 'SUPPORT' ? session.level?.index : null,
        resistanceTouched: session.level?.side === 'RESISTANCE',
        resistanceTouchedAt: session.level?.side === 'RESISTANCE' ? session.startedAt : null,
        resistanceTouchedLevel: session.level?.side === 'RESISTANCE' ? session.level?.price : null,
        resistanceTouchedIndex: session.level?.side === 'RESISTANCE' ? session.level?.index : null,
      },
    };
    rendererHtml = rendererHtml
      .replace('__NOVA_BOT_CONFIG__', JSON.stringify(botConfig))
      .replace('__NOVA_INITIAL_DECISION__', JSON.stringify(initialState.decision || null))
      .replace('__NOVA_CANDLES__', JSON.stringify(initialState.candles || []));
    fs.writeFileSync(this.rendererHtmlPath, rendererHtml, 'utf8');

    console.log(`[RECORDING] renderer page starting: ${this.rendererHtmlPath}`);
    const target = await this.command('Target.createTarget', { url: pathToFileURL(this.rendererHtmlPath).href });
    const attached = await this.command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    this.sessionId = attached.sessionId;

    await this.command('Page.enable', {}, this.sessionId);
    await this.command('Runtime.enable', {}, this.sessionId);
    await this.command('Emulation.setDeviceMetricsOverride', {
      width: 1380, height: 720, deviceScaleFactor: 1, mobile: false,
    }, this.sessionId);

    await this.waitForExpression('typeof window.LightweightCharts !== "undefined"');
    console.log('[RECORDING] chart library ready');
    await this.waitForExpression('Boolean(window.NovaBotChartManager && window.NovaBotChartManager.chart)');
    console.log('[RECORDING] ChartManager ready');
    await this.waitForExpression('window.__novaBotChartReady === true');
    console.log('[RECORDING] live chart history/render ready');

    // Apply the first live state only after the production chart has completed
    // its historical setData/fitContent pass. This guarantees the first frame
    // cannot be captured with an empty series or a temporary 0-based scale.
    this.recordingUpdateObjectId = await this._resolveWindowFunction('NovaRecordingUpdate');
    await this.callRecordingFunction('NovaRecordingUpdate', initialState);
    await sleep(100);
  }

  _publicState(session) {
    const candles = Array.from(session.candles.values())
      .filter(c => {
        if (!c || typeof c !== 'object') return false;
        const values = [c.timestamp, c.open, c.high, c.low, c.close].map(Number);
        if (!values.every(Number.isFinite)) return false;
        const [ts, open, high, low, close] = values;
        return ts > 0 && open > 0 && high > 0 && low > 0 && close > 0 &&
          high >= Math.max(open, close) && low <= Math.min(open, close);
      })
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
      .slice(-300)
      .map(c => ({ time: Number(c.timestamp) / 1000, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }));

    if (session.currentCandle) {
      const values = [session.currentCandle.timestamp, session.currentCandle.open, session.currentCandle.high, session.currentCandle.low, session.currentCandle.close].map(Number);
      const [ts, open, high, low, close] = values;
      const valid = values.every(Number.isFinite) && ts > 0 && open > 0 && high > 0 && low > 0 && close > 0 &&
        high >= Math.max(open, close) && low <= Math.min(open, close);
      if (valid) {
        const current = { time: ts / 1000, open, high, low, close };
        const idx = candles.findIndex(c => c.time === current.time);
        if (idx >= 0) candles[idx] = current; else candles.push(current);
      }
    }

    return {
      symbol: session.symbol,
      timeframe: session.timeframe,
      startedAt: session.startedAt,
      direction: session.direction,
      currentPrice: Number(session.currentPrice),
      support: (Array.isArray(session.support) ? session.support : []).map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0),
      resistance: (Array.isArray(session.resistance) ? session.resistance : []).map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0),
      level: session.level || null,
      trend: session.trend || '',
      decision: session.decision || {},
      candles,
    };
  }

  async update(session) {
    if (!this.ws || !this.sessionId) return;
    await this.callRecordingFunction('NovaRecordingUpdate', this._publicState(session));
  }

  async callRecordingFunction(functionName, state) {
    // Pass the state as a structured CDP argument instead of embedding a
    // large JSON string inside Runtime.evaluate(). This avoids Chromium's
    // "Object reference chain is too long" failures during long recordings
    // and keeps each update bounded to one plain serializable value.
    if (functionName === 'NovaRecordingUpdate' && !this.recordingUpdateObjectId) {
      this.recordingUpdateObjectId = await this._resolveWindowFunction(functionName);
    }
    const objectId = functionName === 'NovaRecordingUpdate'
      ? this.recordingUpdateObjectId
      : await this._resolveWindowFunction(functionName);
    try {
      await this.command('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(state) { return this(state); }',
        arguments: [{ value: state }],
        returnByValue: true,
        awaitPromise: true,
      }, this.sessionId);
    } finally {
      // Keep the cached function object for the recording page lifetime. It
      // is released together with the browser target on stop().
    }
  }

  async _resolveWindowFunction(functionName) {
    const result = await this.command('Runtime.evaluate', {
      expression: `window.${functionName}`,
      returnByValue: false,
    }, this.sessionId);
    if (!result.result || !result.result.objectId) {
      throw new Error(`Recording function not available: ${functionName}`);
    }
    return result.result.objectId;
  }

  async screenshot(filePath) {
    if (!this.ws || !this.sessionId) throw new Error('Live chart renderer is not started');
    const result = await this.command('Page.captureScreenshot', { format: 'png', fromSurface: true }, this.sessionId);
    fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
  }

  async waitForExpression(expression) {
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const result = await this.command('Runtime.evaluate', { expression, returnByValue: true }, this.sessionId);
      if (result.result && result.result.value) return true;
      await sleep(100);
    }
    throw new Error(`Renderer timeout waiting for: ${expression}`);
  }

  async stop() {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionId) {
        try { await this.command('Target.detachFromTarget', { sessionId: this.sessionId }); } catch (_) {}
      }
    } catch (_) {}

    try { if (this.ws) this.ws.close(); } catch (_) {}
    this.ws = null;
    this.sessionId = null;
    this.recordingUpdateObjectId = null;

    try { if (this.browser && !this.browser.killed) this.browser.kill(); } catch (_) {}
    this.browser = null;

    try {
      if (this.rendererHtmlPath) fs.rmSync(this.rendererHtmlPath, { force: true });
    } catch (_) {}
  }

  command(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onMessage = raw => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch (_) { return; }
        if (message.id !== id) return;
        this.ws.off('message', onMessage);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result || {});
      };
      this.ws.on('message', onMessage);
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async stop() {
    try {
      if (this.ws && this.sessionId) {
        try { await this.command('Target.detachFromTarget', { sessionId: this.sessionId }); } catch (_) {}
      }
    } finally {
      try { if (this.ws) this.ws.close(); } catch (_) {}
      try { if (this.browser) this.browser.kill(); } catch (_) {}
      this.ws = null;
      this.browser = null;
      this.sessionId = null;
    }
  }
}

module.exports = LiveChartRenderer;
