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
    if (value instanceof Date) value = value.getTime();
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
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

  function chartTimeToX(timeSec) {
    const cm = window.NovaBotChartManager;
    if (!cm || !cm.chart || !cm.chart.timeScale) return null;
    const x = cm.chart.timeScale().timeToCoordinate(timeSec);
    return Number.isFinite(x) ? x : null;
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
    const all = recordings.slice().sort((a,b) => (startMs(a)||0) - (startMs(b)||0));
    all.forEach((r, idx) => {
      const s = startMs(r), e = endMs(r);
      if (!s || !e || e < s) return;
      const x1 = chartTimeToX(s / 1000), x2 = chartTimeToX(e / 1000);
      if (x1 == null && x2 == null) return;
      const leftRaw = x1 == null ? (e < s ? width : 0) : x1;
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
