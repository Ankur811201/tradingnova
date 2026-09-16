'use strict';

(function () {
  const config = window.BOT_CONFIG || {};
  const enabled = window.BOT_RECORDINGS_ENABLED === true;
  const listEl = document.getElementById('trade-recordings-list');
  const liveEl = document.getElementById('recording-live-status');
  const chartLiveEl = document.getElementById('chart-recording-status');
  const socket = window.NovaBotSocket;
  const startBtn = document.getElementById('recording-start-btn');
  const stopBtn = document.getElementById('recording-stop-btn');
  const deleteAllBtn = document.getElementById('recording-delete-all-btn');
  if (!enabled || !listEl || !config.instanceId) return;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function setLive(status, data) {
    const active = status === 'STARTED';
    const level = data && data.level ? `${data.level.side === 'SUPPORT' ? 'S' : 'R'}${data.level.index}` : 'MANUAL';
    if (liveEl) {
      liveEl.textContent = active ? `● RECORDING 0.5 FPS • ${level}` : '● RECORDING 0.5 FPS';
      liveEl.classList.toggle('hidden', !active);
      liveEl.classList.toggle('animate-pulse', active);
    }
    if (startBtn) startBtn.disabled = active;
    if (stopBtn) stopBtn.disabled = !active;
    if (chartLiveEl) {
      chartLiveEl.textContent = active ? `● RECORDING 0.5 FPS • ${level}` : '● RECORDING 0.5 FPS';
      chartLiveEl.classList.toggle('hidden', !active);
    }
  }

  function render(recordings) {
    if (!recordings.length) {
      listEl.innerHTML = '<div class="text-gray-500 italic text-xs py-4">No S1/R1 recordings yet.</div>';
      return;
    }
    listEl.innerHTML = recordings.map((r) => {
      const time = r.triggerTime ? new Date(r.triggerTime).toLocaleString() : '--';
      const level = r.level && r.level.index ? `${r.level.side === 'SUPPORT' ? 'S' : 'R'}${r.level.index}` : '--';
      const duration = Number(r.durationSeconds || 0).toFixed(0);
      const chunk = Number(r.chunkIndex || 1);
      const start = r.chunkStartedAt ? new Date(r.chunkStartedAt).toLocaleTimeString() : time;
      const end = r.chunkEndedAt ? new Date(r.chunkEndedAt).toLocaleTimeString() : '--';
      const directionClass = r.direction === 'SELL' ? 'text-rose-400' : 'text-emerald-400';
      const playerUrl = `/bots/${encodeURIComponent(config.instanceId)}/recordings/${encodeURIComponent(r.recordingId)}`;
      return `
        <div class="glass-tight rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 text-xs font-mono">
              <span class="font-bold ${directionClass}">${escapeHtml(r.direction || '--')}</span>
              <span class="text-gray-500">•</span>
              <span class="text-gray-300">${escapeHtml(level)}</span>
              <span class="text-gray-600">•</span>
              <span class="text-gray-500">${escapeHtml(time)}</span>
            </div>
            <div class="text-[10px] text-gray-500 mt-1">Chunk ${chunk} • ${escapeHtml(r.symbol)} • ${escapeHtml(r.timeframe)} • ${escapeHtml(start)} → ${escapeHtml(end)} • ${duration}s • 1 FPS</div>
          </div>
          <div class="flex items-center gap-2">
            <a href="${playerUrl}" class="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/25 text-blue-400 hover:bg-blue-500/20 text-xs font-semibold">▶ Watch</a>
            <button type="button" data-recording-delete="${escapeHtml(r.recordingId)}" class="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-400 hover:bg-rose-500/20 text-xs font-semibold">🗑 Delete</button>
          </div>
        </div>`;
    }).join('');
  }

  async function deleteRecording(recordingId, button) {
    if (!window.confirm('Delete this recording permanently?')) return;
    button.disabled = true;
    button.textContent = 'Deleting...';
    try {
      const response = await fetch(`/api/recordings/${encodeURIComponent(config.instanceId)}/${encodeURIComponent(recordingId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to delete recording');
      await load();
    } catch (err) {
      button.disabled = false;
      button.textContent = '🗑 Delete';
      window.alert(err.message);
    }
  }

  async function deleteAllRecordings() {
    if (!deleteAllBtn) return;
    const confirmed = window.confirm(
      'Delete ALL recordings, videos, and temporary recording frame files for this bot? This cannot be undone.'
    );
    if (!confirmed) return;

    deleteAllBtn.disabled = true;
    deleteAllBtn.textContent = 'Deleting...';
    try {
      const response = await fetch(`/api/recordings/${encodeURIComponent(config.instanceId)}/all`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to delete all recordings');
      await load();
      window.alert(`Deleted ${Number(data.deletedRecordings || 0)} recording(s) and cleaned temporary recording files.`);
    } catch (err) {
      window.alert(err.message);
    } finally {
      deleteAllBtn.disabled = false;
      deleteAllBtn.textContent = '🗑 Delete All';
    }
  }

  async function startRecording() {
    if (!startBtn) return;
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
    try {
      const response = await fetch(`/api/recordings/${encodeURIComponent(config.instanceId)}/start`, {
        method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to start recording');
      setLive('STARTED', data.active || {});
      await load();
    } catch (err) {
      startBtn.disabled = false;
      window.alert(err.message);
    } finally {
      startBtn.textContent = '▶ Start';
    }
  }

  async function stopRecording() {
    if (!stopBtn) return;
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stopping...';
    try {
      const response = await fetch(`/api/recordings/${encodeURIComponent(config.instanceId)}/stop`, {
        method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to stop recording');
      await load();
    } catch (err) {
      window.alert(err.message);
    } finally {
      stopBtn.textContent = '■ Stop';
      await load();
    }
  }

  async function load() {
    try {
      const response = await fetch(`/api/recordings/${encodeURIComponent(config.instanceId)}`, {
        credentials: 'same-origin', headers: { Accept: 'application/json' },
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to load recordings');
      render(Array.isArray(data.recordings) ? data.recordings : []);
      if (data.active) setLive('STARTED', data.active);
      else {
        if (liveEl) liveEl.classList.add('hidden');
        if (chartLiveEl) chartLiveEl.classList.add('hidden');
        if (startBtn) { startBtn.disabled = false; startBtn.textContent = '▶ Start'; }
        if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = '■ Stop'; }
      }
    } catch (err) {
      listEl.innerHTML = `<div class="text-rose-400 text-xs py-4">${escapeHtml(err.message)}</div>`;
    }
  }

  if (socket) {
    socket.on('bot:recording', (data) => {
      if (!data || data.instanceId !== config.instanceId) return;
      setLive(data.status, data);
      if (data.status === 'CHUNK_READY' || data.status === 'STOPPED') load();
    });
  }

  listEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-recording-delete]');
    if (!button) return;
    deleteRecording(button.getAttribute('data-recording-delete'), button);
  });

  if (startBtn) startBtn.addEventListener('click', startRecording);
  if (stopBtn) stopBtn.addEventListener('click', stopRecording);
  if (deleteAllBtn) deleteAllBtn.addEventListener('click', deleteAllRecordings);

  document.addEventListener('DOMContentLoaded', load);
  window.NovaTradeRecordings = { refresh: load };
})();
