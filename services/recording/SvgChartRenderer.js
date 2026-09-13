'use strict';

/**
 * NOVA TRADE — server-side recording chart renderer.
 *
 * Replaces the old Chrome/CDP-driven LiveChartRenderer. There is no browser
 * process, no remote debugging protocol and no screen capture involved: every frame
 * is produced deterministically from the same canonical candle/decision
 * state RecordingService already tracks (`_publicState` below is the exact
 * shape the old LiveChartRenderer computed), reproduced directly as SVG,
 * then rasterized to PNG with sharp. FFmpeg (unchanged, in RecordingService)
 * encodes the PNG sequence to WebM.
 *
 * Visual parity target: the SAME candle data, support/resistance lines,
 * MODEL_002 pattern boundaries/body-reference/role markers and side-panel
 * decision readout as the live bot-detail chart (chart-manager.js,
 * candle-series.js, overlay-manager.js, marker-manager.js). Colors, layout
 * proportions (1380x720, 830px chart panel, 502px side panel) and the
 * S1/R1/MANUAL header badge all mirror the previous Chrome-rendered page so
 * a recording still looks like the bot page it was recording.
 */

const sharp = require('sharp');

// ---------------------------------------------------------------------
// Layout constants (mirrors the old renderer HTML/CSS 1:1)
// ---------------------------------------------------------------------
const CANVAS_W = 1380;
const CANVAS_H = 720;
const CHART_X = 15;
const CHART_Y = 66;
const CHART_W = 830;
const CHART_H = 580;
const SIDE_X = 863;
const SIDE_Y = 66;
const SIDE_W = 502;
const SIDE_H = 580;

const PLOT_PAD_LEFT = 10;
const PLOT_PAD_TOP = 14;
const PLOT_PAD_RIGHT = 64; // right price axis
const PLOT_PAD_BOTTOM = 26; // bottom time axis
const RIGHT_OFFSET_CANDLES = 3; // matches timeScale.rightOffset: 3

const UP_COLOR = '#089981';
const DOWN_COLOR = '#f23645';
const GRID_COLOR = '#e0e3eb';
const AXIS_BORDER = '#d1d4dc';
const AXIS_TEXT = '#131722';

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fmtPrice(value) {
  const n = num(value);
  return n == null ? '--' : n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

function fmtTime(unixSeconds) {
  const n = num(unixSeconds);
  if (n == null) return '--:--';
  const d = new Date(n * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Ports Model002LevelState.getBoundaryLabels (public/js/renderers/model002-level-state.js). */
function getBoundaryLabels(direction) {
  if (direction === 'BUY') return { upper: 'UPPER (BUY>)', lower: 'LOWER (INVALID<)' };
  if (direction === 'SELL') return { upper: 'UPPER (INVALID>)', lower: 'LOWER (SELL<)' };
  return { upper: 'UPPER', lower: 'LOWER' };
}

/** Ports Model002LevelState.getBoundaryRoles. */
function getBoundaryRoles(direction) {
  if (direction === 'BUY') return { upper: 'TRIGGER', lower: 'INVALIDATION' };
  if (direction === 'SELL') return { upper: 'INVALIDATION', lower: 'TRIGGER' };
  return { upper: 'NEUTRAL', lower: 'NEUTRAL' };
}

/** Word-wraps `text` to roughly `maxChars` per line, capped at `maxLines`. */
function wrapText(text, maxChars, maxLines) {
  const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(0, maxChars - 1))}\u2026`;
  }
  return lines.length ? lines : ['--'];
}

function validCandle(c) {
  if (!c) return false;
  const [t, o, h, l, cl] = [c.time, c.open, c.high, c.low, c.close].map(Number);
  return Number.isFinite(t) && Number.isFinite(o) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(cl) &&
    o > 0 && h > 0 && l > 0 && cl > 0 && h >= Math.max(o, cl) && l <= Math.min(o, cl);
}

// ---------------------------------------------------------------------
// Chart geometry
// ---------------------------------------------------------------------
function buildGeometry(candles) {
  const plotX = CHART_X + PLOT_PAD_LEFT;
  const plotY = CHART_Y + PLOT_PAD_TOP;
  const plotW = CHART_W - PLOT_PAD_LEFT - PLOT_PAD_RIGHT;
  const plotH = CHART_H - PLOT_PAD_TOP - PLOT_PAD_BOTTOM;

  const n = candles.length;
  const totalSlots = Math.max(n + RIGHT_OFFSET_CANDLES, 1);
  const slotWidth = plotW / totalSlots;

  let lo = Infinity;
  let hi = -Infinity;
  candles.forEach((c) => {
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
  });
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    const mid = Number.isFinite(hi) ? hi : (Number.isFinite(lo) ? lo : 1);
    lo = mid * 0.995;
    hi = mid * 1.005;
    if (hi <= lo) { lo = mid - 1; hi = mid + 1; }
  }
  const pad = (hi - lo) * 0.08 || Math.max(Math.abs(hi), 1) * 0.01;
  const min = lo - pad;
  const max = hi + pad;

  const xCenter = (i) => plotX + (i + 0.5) * slotWidth;
  const yPrice = (price) => {
    const p = num(price);
    if (p == null) return null;
    return plotY + ((max - p) / (max - min)) * plotH;
  };
  const inRange = (price) => {
    const p = num(price);
    return p != null && p >= min && p <= max;
  };

  return { plotX, plotY, plotW, plotH, slotWidth, min, max, xCenter, yPrice, inRange };
}

function niceTicks(min, max, count) {
  const range = max - min || 1;
  const rawStep = range / count;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  let step;
  if (norm < 1.5) step = 1 * mag;
  else if (norm < 3) step = 2 * mag;
  else if (norm < 7) step = 5 * mag;
  else step = 10 * mag;

  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max; v += step) ticks.push(v);
  return ticks;
}

// ---------------------------------------------------------------------
// SVG fragment builders
// ---------------------------------------------------------------------
function svgHeader(state) {
  const level = state.level || {};
  const isManual = !state.level || state.direction === 'MANUAL';
  const side = level.side === 'SUPPORT' ? 'S' : 'R';
  const index = level.index || 1;
  const badge = isManual ? '\u25CF RECORDING 1 FPS \u2022 MANUAL' : `\u25CF RECORDING 1 FPS \u2022 ${side}${index}`;
  const subtitle = `${esc(state.symbol || '--')} \u2022 ${esc(state.timeframe || '--')} \u2022 MODEL_002`;

  return `
  <text x="${CHART_X}" y="34" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700" fill="#e5e7eb">NOVA TRADE</text>
  <text x="${CHART_X + 118}" y="34" font-family="monospace" font-size="12" fill="#60a5fa">${subtitle}</text>
  <text x="${SIDE_X + SIDE_W}" y="34" font-family="monospace" font-size="11" font-weight="700" fill="#fb7185" text-anchor="end">${esc(badge)}</text>`;
}

function svgChartPanelBg() {
  return `<rect x="${CHART_X}" y="${CHART_Y}" width="${CHART_W}" height="${CHART_H}" rx="16" fill="#ffffff"/>`;
}

function svgGridAndAxes(geo, candles) {
  const parts = [];
  const priceTicks = niceTicks(geo.min, geo.max, 5);
  priceTicks.forEach((price) => {
    const y = geo.yPrice(price);
    if (y == null) return;
    parts.push(`<line x1="${geo.plotX}" y1="${y.toFixed(1)}" x2="${geo.plotX + geo.plotW}" y2="${y.toFixed(1)}" stroke="${GRID_COLOR}" stroke-width="1"/>`);
    parts.push(`<text x="${geo.plotX + geo.plotW + 6}" y="${(y + 3.5).toFixed(1)}" font-family="JetBrains Mono, monospace" font-size="10" fill="${AXIS_TEXT}">${fmtPrice(price)}</text>`);
  });

  // Vertical grid + time axis, one label roughly every ~1/6th of the candles.
  const n = candles.length;
  const step = Math.max(1, Math.round(n / 6));
  for (let i = 0; i < n; i += step) {
    const x = geo.xCenter(i);
    parts.push(`<line x1="${x.toFixed(1)}" y1="${geo.plotY}" x2="${x.toFixed(1)}" y2="${geo.plotY + geo.plotH}" stroke="${GRID_COLOR}" stroke-width="1"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${geo.plotY + geo.plotH + 16}" font-family="JetBrains Mono, monospace" font-size="9" fill="#787b86" text-anchor="middle">${fmtTime(candles[i].time)}</text>`);
  }

  // Axis borders.
  parts.push(`<line x1="${geo.plotX + geo.plotW}" y1="${CHART_Y + 4}" x2="${geo.plotX + geo.plotW}" y2="${CHART_Y + CHART_H - 4}" stroke="${AXIS_BORDER}" stroke-width="1"/>`);
  parts.push(`<line x1="${CHART_X + 4}" y1="${geo.plotY + geo.plotH}" x2="${CHART_X + CHART_W - 4}" y2="${geo.plotY + geo.plotH}" stroke="${AXIS_BORDER}" stroke-width="1"/>`);
  return parts.join('\n');
}

function svgCandles(geo, candles) {
  const bodyW = Math.max(1, geo.slotWidth * 0.6);
  const parts = [];
  candles.forEach((c, i) => {
    const x = geo.xCenter(i);
    const up = c.close >= c.open;
    const color = up ? UP_COLOR : DOWN_COLOR;
    const yHigh = geo.yPrice(c.high);
    const yLow = geo.yPrice(c.low);
    const yOpen = geo.yPrice(c.open);
    const yClose = geo.yPrice(c.close);
    if (yHigh == null || yLow == null || yOpen == null || yClose == null) return;
    const bodyTop = Math.min(yOpen, yClose);
    const bodyBottom = Math.max(yOpen, yClose);
    const bodyHeight = Math.max(1, bodyBottom - bodyTop);
    parts.push(`<line x1="${x.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${color}" stroke-width="1"/>`);
    parts.push(`<rect x="${(x - bodyW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyHeight.toFixed(1)}" fill="${color}"/>`);
  });
  return parts.join('\n');
}

/** Support/resistance full-width dashed price lines, same keys/colors as OverlayManager.setPriceLine. */
function svgLevelLines(geo, state) {
  const parts = [];
  const draw = (price, color, label) => {
    if (!geo.inRange(price)) return;
    const y = geo.yPrice(price);
    parts.push(`<line x1="${geo.plotX}" y1="${y.toFixed(1)}" x2="${geo.plotX + geo.plotW}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="4,3"/>`);
    parts.push(`<rect x="${(geo.plotX + geo.plotW + 1).toFixed(1)}" y="${(y - 7).toFixed(1)}" width="60" height="14" fill="${color}"/>`);
    parts.push(`<text x="${(geo.plotX + geo.plotW + 31).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-family="monospace" font-size="9" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(label)}</text>`);
  };
  (state.support || []).forEach((price, idx) => draw(price, '#089981', `S${idx + 1}`));
  (state.resistance || []).forEach((price, idx) => draw(price, '#f23645', `R${idx + 1}`));
  return parts.join('\n');
}

/** MODEL_002 pattern boundaries (Candle 2's fixed upper/lower), matches NovaChartPatternOverlay.setBoundaries. */
function svgBoundaries(geo, checks) {
  const boundaries = checks && checks.boundaries;
  if (!boundaries) return '';
  const direction = checks.patternVisual && checks.patternVisual.direction;
  const labels = getBoundaryLabels(direction);
  const roles = getBoundaryRoles(direction);
  const upperIsTrigger = roles.upper === 'TRIGGER';
  const parts = [];
  const draw = (price, color, label) => {
    if (price == null || !geo.inRange(price)) return;
    const y = geo.yPrice(price);
    parts.push(`<line x1="${geo.plotX}" y1="${y.toFixed(1)}" x2="${geo.plotX + geo.plotW}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="1.4" stroke-dasharray="2,2"/>`);
    parts.push(`<text x="${(geo.plotX + 4).toFixed(1)}" y="${(y - 3).toFixed(1)}" font-family="monospace" font-size="9" font-weight="700" fill="${color}">${esc(label)}</text>`);
  };
  if (num(boundaries.upper) != null) draw(num(boundaries.upper), upperIsTrigger ? '#22c55e' : '#f43f5e', labels.upper);
  if (num(boundaries.lower) != null) draw(num(boundaries.lower), upperIsTrigger ? '#f43f5e' : '#22c55e', labels.lower);
  return parts.join('\n');
}

/** Candle 1 body-reference segment, matches NovaChartPatternOverlay.setBodyReference. */
function svgBodyReference(geo, checks, candles) {
  const ref = checks && checks.bodyReference;
  if (!ref || ref.price == null) return '';
  const price = num(ref.price);
  if (price == null || !geo.inRange(price)) return '';

  const from = ref.fromTimestamp != null ? ref.fromTimestamp : ref.candleTimestamp;
  const fromMs = num(from);
  if (fromMs == null) return '';
  const fromSec = fromMs > 100000000000 ? Math.floor(fromMs / 1000) : Math.floor(fromMs);
  let fromIdx = candles.findIndex((c) => c.time === fromSec);
  if (fromIdx < 0) return '';

  let toIdx = candles.length - 1;
  if (ref.toTimestamp != null) {
    const toMs = num(ref.toTimestamp);
    const toSec = toMs != null ? (toMs > 100000000000 ? Math.floor(toMs / 1000) : Math.floor(toMs)) : null;
    const found = toSec != null ? candles.findIndex((c) => c.time === toSec) : -1;
    if (found >= 0) toIdx = found;
  }

  const x1 = geo.xCenter(fromIdx);
  const x2 = geo.xCenter(Math.max(toIdx, fromIdx));
  const y = geo.yPrice(price);
  const isBodyHigh = ref.side !== 'BODY_LOW';
  const color = isBodyHigh ? '#a78bfa' : '#f0abfc';
  const label = isBodyHigh ? 'C1 BODY HIGH' : 'C1 BODY LOW';
  return [
    `<line x1="${x1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="1.2" stroke-dasharray="1,2"/>`,
    `<text x="${x1.toFixed(1)}" y="${(y - 3).toFixed(1)}" font-family="monospace" font-size="8" fill="${color}">${esc(label)}</text>`,
  ].join('\n');
}

/** C1/C2/C3 pattern role badges, matches buildPatternRoleMarkers in bot-detail-chart.js. */
function svgPatternMarkers(geo, checks, candles) {
  const visual = checks && checks.patternVisual;
  if (!visual || !Array.isArray(visual.labels) || !visual.labels.length) return '';
  const aboveBar = visual.placement === 'aboveBar';
  const colors = {
    CANDLE_1: '#94a3b8',
    CANDLE_2: '#3b82f6',
    CANDLE_3: visual.direction === 'SELL' ? '#f43f5e' : '#22c55e',
  };
  const parts = [];
  visual.labels.forEach((label) => {
    const ms = num(label.timestamp);
    if (ms == null) return;
    const sec = ms > 100000000000 ? Math.floor(ms / 1000) : Math.floor(ms);
    const idx = candles.findIndex((c) => c.time === sec);
    if (idx < 0) return;
    const x = geo.xCenter(idx);
    const candle = candles[idx];
    const anchorPrice = aboveBar ? candle.high : candle.low;
    const y0 = geo.yPrice(anchorPrice);
    if (y0 == null) return;
    const y = aboveBar ? y0 - 12 : y0 + 12;
    const color = colors[label.role] || '#94a3b8';
    let text = `${label.badge ? `${label.badge} ` : ''}${label.trigger || label.code || ''}`;
    if (label.touch) text += ' \u2022 TOUCH';
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${(aboveBar ? y - 6 : y + 14).toFixed(1)}" font-family="monospace" font-size="9" font-weight="700" fill="${color}" text-anchor="middle">${esc(text)}</text>`);
  });
  return parts.join('\n');
}

/** Current price axis label, matches chart-price-label.js. */
function svgCurrentPriceLabel(geo, state) {
  const price = num(state.currentPrice);
  if (price == null || !geo.inRange(price)) return '';
  const y = geo.yPrice(price);
  const boxW = 78;
  const boxH = 30;
  const boxX = geo.plotX + geo.plotW - boxW - 4;
  const boxY = Math.min(Math.max(y - boxH / 2, CHART_Y + 2), CHART_Y + CHART_H - boxH - 2);
  const tf = timeframeSeconds(state.timeframe);
  const nowSec = Math.floor(Date.now() / 1000);
  const next = Math.max(0, tf - (nowSec % tf));
  const countdown = `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`;
  return [
    `<line x1="${geo.plotX}" y1="${y.toFixed(1)}" x2="${geo.plotX + geo.plotW}" y2="${y.toFixed(1)}" stroke="#34d399" stroke-width="0.75" stroke-dasharray="2,2" opacity="0.6"/>`,
    `<rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW}" height="${boxH}" rx="6" fill="#0b1220" stroke="#34d39955"/>`,
    `<text x="${(boxX + boxW / 2).toFixed(1)}" y="${(boxY + 13).toFixed(1)}" font-family="monospace" font-size="11" font-weight="700" fill="#ffffff" text-anchor="middle">${fmtPrice(price)}</text>`,
    `<text x="${(boxX + boxW / 2).toFixed(1)}" y="${(boxY + 25).toFixed(1)}" font-family="monospace" font-size="9" font-weight="600" fill="#34d399" text-anchor="middle">${countdown}</text>`,
  ].join('\n');
}

function timeframeSeconds(tf) {
  const m = String(tf || '1m').match(/^(\d+)(m|h|d)$/i);
  if (!m) return 60;
  const n = Number(m[1]);
  return n * ({ m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()] || 60);
}

function svgEmptyChart() {
  return `<text x="${CHART_X + CHART_W / 2}" y="${CHART_Y + CHART_H / 2}" font-family="monospace" font-size="14" fill="#94a3b8" text-anchor="middle">Waiting for candle data\u2026</text>`;
}

function svgSidePanel(state) {
  const level = state.level || {};
  const isManual = !state.level || state.direction === 'MANUAL';
  const side = level.side === 'SUPPORT' ? 'S' : 'R';
  const index = level.index || 1;
  const decision = state.decision || {};
  const decisionValue = decision.decision || 'WAIT';
  const decisionColor = decisionValue === 'SELL' ? '#fb7185' : decisionValue === 'BUY' ? '#34d399' : '#60a5fa';
  const reasonLines = wrapText(decision.reason || (isManual ? 'Manual recording' : `${side}${index} touched`), 46, 4);
  const startedAt = num(state.startedAt);
  const elapsedSec = startedAt != null ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;

  const supportText = (state.support || []).map((p, i) => `S${i + 1} ${fmtPrice(p)}`).join(' \u2022 ') || '--';
  const resistanceText = (state.resistance || []).map((p, i) => `R${i + 1} ${fmtPrice(p)}`).join(' \u2022 ') || '--';
  const touchedText = level.side ? `${level.side} ${level.index} \u2022 ${fmtPrice(level.price)}` : '--';
  const patternState = decision.patternState || 'IDLE';

  let y = SIDE_Y + 22;
  const rows = [];
  rows.push(`<text x="${SIDE_X + 22}" y="${y}" font-family="monospace" font-size="11" font-weight="700" fill="#94a3b8">BOT DECISION ENGINE</text>`);

  const field = (label, value, opts = {}) => {
    y += 24;
    rows.push(`<text x="${SIDE_X + 22}" y="${y}" font-family="Inter, Arial, sans-serif" font-size="10" fill="#64748b">${esc(label)}</text>`);
    y += 18;
    rows.push(`<text x="${SIDE_X + 22}" y="${y}" font-family="monospace" font-size="${opts.size || 13}" font-weight="${opts.weight || 400}" fill="${opts.color || '#e2e8f0'}">${esc(value)}</text>`);
  };

  field('Trend', state.trend || '--');
  field('Support', supportText);
  field('Resistance', resistanceText);
  field('Pattern State', patternState);

  y += 30;
  rows.push(`<text x="${SIDE_X + 22}" y="${y}" font-family="Inter, Arial, sans-serif" font-size="10" fill="#64748b">Final Decision</text>`);
  y += 32;
  rows.push(`<text x="${SIDE_X + 22}" y="${y}" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="700" fill="${decisionColor}">${esc(decisionValue)}</text>`);

  y += 20;
  reasonLines.forEach((line) => {
    y += 15;
    rows.push(`<text x="${SIDE_X + 22}" y="${y}" font-family="monospace" font-size="11" fill="#cbd5e1">${esc(line)}</text>`);
  });

  y += 10;
  field('Touched Level', touchedText);
  field('Recording', `\u25CF ${elapsedSec}s \u2022 1 FPS`, { color: '#e2e8f0' });

  return `<rect x="${SIDE_X}" y="${SIDE_Y}" width="${SIDE_W}" height="${SIDE_H}" rx="16" fill="#0b0f17" stroke="#ffffff12"/>\n${rows.join('\n')}`;
}

// ---------------------------------------------------------------------
// Full frame
// ---------------------------------------------------------------------

/**
 * Deterministic frame builder: candle/decision state in, one complete SVG
 * document out. Never returns a partial document — a state with no candles
 * still renders a complete (placeholder) frame rather than throwing.
 */
function renderChartFrame(state) {
  const candles = Array.isArray(state.candles) ? state.candles.filter(validCandle) : [];
  const geo = buildGeometry(candles);
  const checks = (state.decision && state.decision.checks) || null;

  const body = candles.length
    ? [
      svgGridAndAxes(geo, candles),
      svgLevelLines(geo, state),
      checks ? svgBoundaries(geo, checks) : '',
      checks ? svgBodyReference(geo, checks, candles) : '',
      svgCandles(geo, candles),
      checks ? svgPatternMarkers(geo, checks, candles) : '',
      svgCurrentPriceLabel(geo, state),
    ].join('\n')
    : svgEmptyChart();

  return `<svg viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
<rect x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" fill="#05060a"/>
${svgHeader(state)}
${svgChartPanelBg()}
<clipPath id="chartClip"><rect x="${CHART_X}" y="${CHART_Y}" width="${CHART_W}" height="${CHART_H}" rx="16"/></clipPath>
<g clip-path="url(#chartClip)">
${body}
</g>
${svgSidePanel(state)}
</svg>`;
}

// ---------------------------------------------------------------------
// Renderer class — drop-in replacement for the old LiveChartRenderer.
// Same interface RecordingService already calls: start/update/screenshot/stop.
// ---------------------------------------------------------------------
class SvgChartRenderer {
  constructor() {
    this.state = null; // last-known-GOOD state (always has candles, once any frame had candles)
  }

  async start(session) {
    this.state = this._publicState(session);
  }

  async update(session) {
    const next = this._publicState(session);
    // Never let a temporarily-empty candle set blank out a frame: keep the
    // previous good state until real candle data returns.
    if (next.candles.length > 0 || !this.state) {
      this.state = next;
    } else {
      // Still refresh the non-chart fields (decision/price/etc.) so the side
      // panel and price label stay live even while candles are unavailable.
      this.state = { ...next, candles: this.state.candles };
    }
  }

  async screenshot(filePath) {
    if (!this.state) throw new Error('SvgChartRenderer has no state to render yet');
    const svg = renderChartFrame(this.state);
    await sharp(Buffer.from(svg)).png().toFile(filePath);
  }

  async stop() {
    this.state = null;
  }

  _publicState(session) {
    const candles = Array.from(session.candles.values())
      .filter((c) => {
        if (!c || typeof c !== 'object') return false;
        const values = [c.timestamp, c.open, c.high, c.low, c.close].map(Number);
        if (!values.every(Number.isFinite)) return false;
        const [ts, open, high, low, close] = values;
        return ts > 0 && open > 0 && high > 0 && low > 0 && close > 0 &&
          high >= Math.max(open, close) && low <= Math.min(open, close);
      })
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
      .slice(-300)
      .map((c) => ({ time: Number(c.timestamp) / 1000, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }));

    if (session.currentCandle) {
      const values = [session.currentCandle.timestamp, session.currentCandle.open, session.currentCandle.high, session.currentCandle.low, session.currentCandle.close].map(Number);
      const [ts, open, high, low, close] = values;
      const valid = values.every(Number.isFinite) && ts > 0 && open > 0 && high > 0 && low > 0 && close > 0 &&
        high >= Math.max(open, close) && low <= Math.min(open, close);
      if (valid) {
        const current = { time: ts / 1000, open, high, low, close };
        const idx = candles.findIndex((c) => c.time === current.time);
        if (idx >= 0) candles[idx] = current; else candles.push(current);
      }
    }

    return {
      symbol: session.symbol,
      timeframe: session.timeframe,
      startedAt: session.startedAt,
      direction: session.direction,
      currentPrice: Number(session.currentPrice),
      support: (Array.isArray(session.support) ? session.support : []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0),
      resistance: (Array.isArray(session.resistance) ? session.resistance : []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0),
      level: session.level || null,
      trend: session.trend || '',
      decision: session.decision || {},
      candles,
    };
  }
}

module.exports = SvgChartRenderer;
module.exports.renderChartFrame = renderChartFrame;
module.exports.getBoundaryLabels = getBoundaryLabels;
module.exports.getBoundaryRoles = getBoundaryRoles;
module.exports.wrapText = wrapText;
module.exports.buildGeometry = buildGeometry;
