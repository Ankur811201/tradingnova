'use strict';

(function () {
  const wrap = document.getElementById('recording-timeline-wrap');
  const timeline = document.getElementById('recording-timeline');
  const empty = document.getElementById('recording-timeline-empty');
  if (!wrap || !timeline) return;

  let recordings = [];
  let active = null;
  let retryTimer = null;
  let tooltip = null;

  function validMs(value) {
    if (value == null || value === '') return null;

    let n;
    if (value instanceof Date) {
      n = value.getTime();
    } else if (typeof value === 'number') {
      n = value;
    } else if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return null;

      // Numeric timestamps may be in seconds or milliseconds. ISO/date strings
      // must be parsed as dates, not passed to Number() (which yields NaN).
      if (/^\d+(?:\.\d+)?$/.test(text)) {
        n = Number(text);
      } else {
        n = Date.parse(text);
      }
    } else {
      return null;
    }

    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1e12) n *= 1000;

    // Do not plot Unix-epoch/default timestamps as real recording times.
    if (n < Date.UTC(2000, 0, 1)) return null;
    return n;
  }

  function startMs(r) { return validMs(r && (r.chunkStartedAt || r.triggerTime)); }
  function endMs(r) {
    const explicit = validMs(r && r.chunkEndedAt);
    if (explicit) return explicit;
    const start = startMs(r);
    const duration = Number(r && r.durationSeconds);
    if (start && Number.isFinite(duration) && duration > 0) return start + duration * 1000;
    if (active && active.recordingId === (r && r.recordingId)) return Date.now();
    return null;
  }

  function labelLevel(r) {
    return r && r.level && r.level.index ? `${r.level.side === 'SUPPORT' ? 'S' : 'R'}${r.level.index}` : 'MANUAL';
  }

  function fmt(ms, withDate) {
    if (!ms) return '--';
    return new Date(ms).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: withDate ? '2-digit' : undefined, month: withDate ? '2-digit' : undefined,
      year: withDate ? 'numeric' : undefined, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  }

  function ensureTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.className = 'recording-timeline-tooltip hidden';
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function showTooltip(event, r) {
    const el = ensureTooltip();
    const s = startMs(r), e = endMs(r);
    const dur = s && e ? Math.max(0, (e - s) / 1000) : Number(r.durationSeconds || 0);
    el.innerHTML = `<strong>🎥 ${escapeHtml(r.direction || 'RECORDING')} • ${escapeHtml(labelLevel(r))}</strong><br>${escapeHtml(fmt(s, true))} → ${escapeHtml(fmt(e, false))}<br>Duration: ${dur.toFixed(0)}s • ${escapeHtml(r.symbol || '')} • ${escapeHtml(r.timeframe || '')}<br><span style="color:#a78bfa">Click to watch this recording</span>`;
    el.classList.remove('hidden');
    positionTooltip(event);
  }

  function positionTooltip(event) {
    if (!tooltip) return;
    const pad = 12, rect = tooltip.getBoundingClientRect();
    let left = event.clientX + 12, top = event.clientY + 12;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
    if (top + rect.height > window.innerHeight - pad) top = event.clientY - rect.height - 12;
    tooltip.style.left = `${Math.max(pad, left)}px`;
    tooltip.style.top = `${Math.max(pad, top)}px`;
  }

  function hideTooltip() { if (tooltip) tooltip.classList.add('hidden'); }

  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function toEpochSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value && typeof value === 'object' && Number.isFinite(value.year) && Number.isFinite(value.month) && Number.isFinite(value.day)) {
      return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 1000);
    }
    return null;
  }

  // Lightweight Charts only returns a coordinate for times represented by a
  // chart point. Recording timestamps are arbitrary milliseconds, so map them
  // between adjacent candle points instead of requiring an exact candle match.
  function chartTimeToX(timeSec, cm, timelineWidth) {
    if (!cm || !cm.chart || !cm.chart.timeScale) return null;
    const scale = cm.chart.timeScale();
    const direct = scale.timeToCoordinate(timeSec);
    if (Number.isFinite(direct)) return direct;

    const series = cm.candleSeries && cm.candleSeries.candlestickSeries;
    if (!series || typeof series.data !== 'function') return null;
    let data;
    try { data = series.data(); } catch (_) { return null; }
    if (!Array.isArray(data) || data.length < 2) return null;

    const points = data.map(c => ({ time: toEpochSeconds(c.time), x: null }))
      .filter(p => Number.isFinite(p.time));
    if (points.length < 2) return null;
    for (const point of points) {
      const x = scale.timeToCoordinate(point.time);
      point.x = Number.isFinite(x) ? x : null;
    }

    // Find the closest pair of candles surrounding the requested timestamp.
    let before = null, after = null;
    for (const point of points) {
      if (point.time <= timeSec && (!before || point.time > before.time)) before = point;
      if (point.time >= timeSec && (!after || point.time < after.time)) after = point;
    }
    if (before && after && before.time !== after.time && Number.isFinite(before.x) && Number.isFinite(after.x)) {
      const ratio = (timeSec - before.time) / (after.time - before.time);
      return before.x + (after.x - before.x) * ratio;
    }

    // For endpoints outside the visible plot, use the visible range boundary
    // so the renderer can clip the recording bar correctly.
    let visible;
    try { visible = scale.getVisibleRange(); } catch (_) { visible = null; }
    if (!visible) return null;
    const from = toEpochSeconds(visible.from), to = toEpochSeconds(visible.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    const xFrom = scale.timeToCoordinate(visible.from);
    const xTo = scale.timeToCoordinate(visible.to);
    if (!Number.isFinite(xFrom) || !Number.isFinite(xTo) || to <= from) return null;
    if (timeSec < from) return 0;
    if (timeSec > to) return timelineWidth;
    return xFrom + ((timeSec - from) / (to - from)) * (xTo - xFrom);
  }

  function visibleTimeRange(cm) {
    try {
      const range = cm.chart.timeScale().getVisibleRange();
      if (!range) return null;
      const from = toEpochSeconds(range.from), to = toEpochSeconds(range.to);
      return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null;
    } catch (_) { return null; }
  }

  function render() {
    const cm = window.NovaBotChartManager;
    const width = timeline.clientWidth;
    if (!cm || !cm.chart || !width) {
      if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; render(); }, 250);
      return;
    }
    timeline.querySelectorAll('.recording-timeline-bar,.recording-timeline-time,.recording-timeline-axis').forEach(el => el.remove());
    const axis = document.createElement('div'); axis.className = 'recording-timeline-axis'; timeline.appendChild(axis);

    let visibleCount = 0;
    const range = visibleTimeRange(cm);
    const all = recordings.slice().sort((a,b) => (startMs(a)||0) - (startMs(b)||0));
    all.forEach((r, idx) => {
      const s = startMs(r), e = endMs(r);
      if (!s || !e || e < s) return;
      const startSec = s / 1000, endSec = e / 1000;
      // Do not show recordings that truly do not overlap the chart's visible
      // time window. For overlaps, clip off-screen endpoints to the plot edge.
      if (range && (endSec < range.from || startSec > range.to)) return;
      let x1 = chartTimeToX(startSec, cm, width);
      let x2 = chartTimeToX(endSec, cm, width);
      if (x1 == null && range && startSec < range.from) x1 = 0;
      if (x2 == null && range && endSec > range.to) x2 = width;
      if (x1 == null && x2 == null) return;
      const leftRaw = x1 == null ? 0 : x1;
      const rightRaw = x2 == null ? width : x2;
      const left = Math.max(0, Math.min(width, Math.min(leftRaw, rightRaw)));
      const right = Math.max(0, Math.min(width, Math.max(leftRaw, rightRaw)));
      if (right <= 0 || left >= width || right - left < 2) return;
      visibleCount++;

      const bar = document.createElement('button');
      bar.type = 'button'; bar.className = 'recording-timeline-bar' + (active && active.recordingId === r.recordingId ? ' active' : '');
      bar.style.left = `${left}px`; bar.style.width = `${Math.max(8, right-left)}px`;
      bar.setAttribute('role','listitem'); bar.setAttribute('aria-label', `Recording ${idx+1}, ${labelLevel(r)}`);
      if (active && active.recordingId === r.recordingId) bar.disabled = true;
      bar.innerHTML = `<span class="recording-timeline-cap start"></span><span class="recording-timeline-cap end"></span><span class="recording-timeline-label">🎥 ${escapeHtml(labelLevel(r))} • ${escapeHtml(r.direction || 'REC')}</span>`;
      bar.addEventListener('mouseenter', ev => showTooltip(ev, r));
      bar.addEventListener('mousemove', positionTooltip);
      bar.addEventListener('mouseleave', hideTooltip);
      bar.addEventListener('click', () => {
        if (r.status !== 'READY' || !r.recordingId) return;
        const url = `/bots/${encodeURIComponent((window.BOT_CONFIG || {}).instanceId)}/recordings/${encodeURIComponent(r.recordingId)}`;
        window.location.href = url;
      });
      timeline.appendChild(bar);

      const timeLabel = document.createElement('div');
      timeLabel.className = 'recording-timeline-time'; timeLabel.style.left = `${Math.max(0, Math.min(width, left))}px`; timeLabel.textContent = fmt(s, false);
      timeline.appendChild(timeLabel);
    });
    if (empty) empty.classList.toggle('hidden', visibleCount > 0);
  }

  function update(data) {
    recordings = Array.isArray(data && data.recordings) ? data.recordings : [];
    active = data && data.active ? data.active : null;
    render();
  }

  function bindChart() {
    const cm = window.NovaBotChartManager;
    if (!cm || !cm.chart || !cm.chart.timeScale) {
      if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; bindChart(); }, 250);
      return;
    }
    const ts = cm.chart.timeScale();
    const redraw = () => render();
    try { ts.subscribeVisibleLogicalRangeChange(redraw); } catch (_) {}
    window.addEventListener('resize', redraw);
    window.NovaRecordingTimeline = { update, render, redraw };
    render();
  }

  bindChart();
  window.NovaRecordingTimeline = { update, render, redraw: render };
})();
