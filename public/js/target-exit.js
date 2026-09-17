/* global window, document */
(function () {
  'use strict';

  const state = { position: null, active: false };

  function el(id) { return document.getElementById(id); }
  function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

  function setVisible(id, visible) {
    const node = el(id);
    if (node) node.classList.toggle('hidden', !visible);
  }

  function setText(id, value) {
    const node = el(id);
    if (node) node.textContent = value;
  }

  function updatePercentPreview() {
    const vals = [1, 2, 3].map(i => n(el(`target-percent-${i}`)?.value) || 0);
    const remaining = 100 - vals.reduce((a, b) => a + b, 0);
    const box = el('target-percent-4');
    if (box) box.textContent = remaining > 0 ? `Remaining ${remaining.toFixed(2)}%` : 'Remaining —';
    return { vals, remaining };
  }

  function validate(position) {
    const errors = [];
    if (!position || position.status !== 'OPEN') errors.push('An open position is required.');
    const prices = [1,2,3,4].map(i => n(el(`target-price-${i}`)?.value));
    const { vals, remaining } = updatePercentPreview();
    if (prices.some(x => x == null || x <= 0)) errors.push('Enter all four target prices.');
    if (vals.some(x => x <= 0 || x >= 100)) errors.push('T1–T3 exit percentages must be between 0 and 100.');
    if (remaining <= 0) errors.push('T4 remaining percentage must be greater than 0.');
    if (position && prices.every(x => x != null)) {
      if (position.side === 'LONG') {
        if (!(prices[0] > position.entryPrice)) errors.push('For LONG, T1 must be above entry price.');
        for (let i=1;i<4;i++) if (!(prices[i] > prices[i-1])) errors.push('For LONG, target prices must increase T1 → T4.');
      } else {
        if (!(prices[0] < position.entryPrice)) errors.push('For SHORT, T1 must be below entry price.');
        for (let i=1;i<4;i++) if (!(prices[i] < prices[i-1])) errors.push('For SHORT, target prices must decrease T1 → T4.');
      }
    }
    const message = el('target-exit-validation');
    if (message) {
      message.textContent = errors[0] || `T1 ${vals[0].toFixed(2)}% • T2 ${vals[1].toFixed(2)}% • T3 ${vals[2].toFixed(2)}% • T4 ${Math.max(0,remaining).toFixed(2)}%`;
      message.className = errors.length ? 'mt-3 text-[10px] text-rose-400 min-h-[16px]' : 'mt-3 text-[10px] text-gray-500 min-h-[16px]';
    }
    const btn = el('target-exit-save-btn');
    if (btn) btn.disabled = Boolean(errors.length) || state.active;
    return !errors.length;
  }

  function render(position) {
    state.position = position || null;
    const plan = position && position.targetExitPlan && position.targetExitPlan.enabled ? position.targetExitPlan : null;
    state.active = Boolean(plan);
    const hasOpen = Boolean(position && position.status === 'OPEN');
    setVisible('target-exit-empty', !hasOpen);
    setVisible('target-exit-form-wrap', hasOpen);

    if (!hasOpen) {
      setText('target-exit-status', 'Waiting for open position');
      const status = el('target-exit-status');
      if (status) status.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-white/5 border border-white/10 text-gray-500';
      return;
    }

    setText('target-position-side', position.side || '--');
    setText('target-position-entry', position.entryPrice != null ? Number(position.entryPrice).toLocaleString() : '--');
    setText('target-position-quantity', position.quantity != null ? Number(position.quantity).toString() : '--');
    setText('target-active-timeframe', plan ? '3m' : ((window.BOT_CONFIG && window.BOT_CONFIG.timeframe) || '--'));

    const targets = plan && Array.isArray(plan.targets) ? plan.targets : [];
    [1,2,3,4].forEach(i => {
      const t = targets.find(x => Number(x.index) === i);
      const p = el(`target-price-${i}`);
      if (p && t) p.value = t.price;
      const pct = el(`target-percent-${i}`);
      if (pct && t && i < 4) pct.value = t.exitPercent;
      const st = el(`target-state-${i}`);
      if (st) {
        st.textContent = t && t.executed ? 'Exited' : (t && t.triggered ? 'Armed' : 'Waiting');
        st.className = `text-[9px] uppercase tracking-wide ${t && t.executed ? 'text-emerald-400' : (t && t.triggered ? 'text-amber-400' : 'text-gray-600')}`;
      }
    });
    updatePercentPreview();

    setVisible('target-exit-locked', state.active);
    setText('target-exit-status', state.active ? '3m Target Exit Active' : 'Ready to configure');
    const status = el('target-exit-status');
    if (status) status.className = state.active
      ? 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
      : 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-amber-500/10 border border-amber-500/20 text-amber-300';
    [1,2,3,4].forEach(i => {
      const p = el(`target-price-${i}`); if (p) p.readOnly = state.active;
      const pct = el(`target-percent-${i}`); if (pct) pct.readOnly = state.active;
    });
    validate(position);
    if (window.NovaBotChartManager && window.NovaBotChartManager.overlayManager) {
      window.NovaBotChartManager.overlayManager.syncPositionOverlays(position);
    }
  }

  async function save() {
    if (!state.position || !validate(state.position)) return;
    const button = el('target-exit-save-btn');
    if (!button) return;
    button.disabled = true;
    button.dataset.original = button.innerHTML;
    button.innerHTML = '<span class="animate-pulse">Activating…</span>';

    const targets = [1,2,3,4].map(i => ({
      price: n(el(`target-price-${i}`).value),
      exitPercent: i < 4 ? n(el(`target-percent-${i}`).value) : undefined,
    }));

    try {
      const response = await fetch(`/api/bot-instances/${window.BOT_CONFIG.instanceId}/target-exit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ enabled: true, targets }),
      });
      let body = {};
      try { body = await response.json(); } catch (_) {}
      if (!response.ok || !body.success) throw new Error(body.message || `Request failed (${response.status})`);
      const data = body.data || {};
      window.BOT_CONFIG.activeTimeframe = '3m';
      render(data.position || Object.assign({}, state.position, { targetExitPlan: data.position?.targetExitPlan }));
      if (window.NovaBotChartManager && window.NovaBotChartManager.overlayManager) {
        window.NovaBotChartManager.overlayManager.syncPositionOverlays(data.position || state.position);
      }
    } catch (err) {
      const message = el('target-exit-validation');
      if (message) {
        message.textContent = err.message;
        message.className = 'mt-3 text-[10px] text-rose-400 min-h-[16px]';
      }
      button.disabled = false;
      button.innerHTML = '<i data-lucide="target" class="w-3.5 h-3.5"></i> Activate Targets';
      if (window.lucide) window.lucide.createIcons();
    }
  }

  window.renderTargetExitForPosition = render;

  document.addEventListener('DOMContentLoaded', function () {
    [1,2,3].forEach(i => {
      const node = el(`target-percent-${i}`);
      if (node) node.addEventListener('input', () => validate(state.position));
    });
    [1,2,3,4].forEach(i => {
      const node = el(`target-price-${i}`);
      if (node) node.addEventListener('input', () => validate(state.position));
    });
    const button = el('target-exit-save-btn');
    if (button) button.addEventListener('click', save);
    render(window.INITIAL_TARGET_POSITION || null);
    if (window.lucide) window.lucide.createIcons();
  });
})();
