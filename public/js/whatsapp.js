'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let formDirty = false;
  let saveInProgress = false;

  const fields = ['waLayerTouch','waTradeOpen','waT1','waT2','waT3','waSL','waClosed'];
  fields.forEach((id) => $(id)?.addEventListener('change', () => { formDirty = true; }));
  $('waRecipient')?.addEventListener('input', () => { formDirty = true; });

  const setChecked = (id, value) => {
    const el = $(id);
    if (el) el.checked = Boolean(value);
  };

  function applySettings(s, wa) {
    if (formDirty || saveInProgress) return;
    $('waRecipient').value = s.recipient || wa.user?.phone || '';
    setChecked('waLayerTouch', s.enabled?.layerTouch);
    setChecked('waTradeOpen', s.enabled?.tradeOpen);
    setChecked('waT1', s.enabled?.target1Exit);
    setChecked('waT2', s.enabled?.target2Exit);
    setChecked('waT3', s.enabled?.target3Exit);
    setChecked('waSL', s.enabled?.stopLoss);
    setChecked('waClosed', s.enabled?.tradeClosed);
  }

  async function load() {
    try {
      const r = await fetch('/api/whatsapp/status', { credentials: 'include' });
      const body = await r.json();
      const d = body.data || body;
      const wa = d.whatsapp || {};
      const s = d.settings || {};
      if ($('waStatus')) $('waStatus').textContent = `Status: ${wa.connection || 'unknown'}`;
      if ($('waUser')) $('waUser').textContent = wa.user?.phone ? `Connected number: +${wa.user.phone}` : '';
      if ($('waQr')) $('waQr').innerHTML = wa.qr
        ? `<img src="${wa.qr}" alt="WhatsApp QR code" style="width:320px;max-width:100%;margin:auto;border-radius:12px">`
        : (wa.connection === 'open' ? '✓ WhatsApp connected' : 'Waiting for QR…');
      applySettings(s, wa);
    } catch (err) {
      if ($('waStatus')) $('waStatus').textContent = 'Status: unavailable';
    }
  }

  async function save() {
    if (saveInProgress) return;
    saveInProgress = true;
    const enabled = {
      layerTouch: $('waLayerTouch').checked,
      tradeOpen: $('waTradeOpen').checked,
      target1Exit: $('waT1').checked,
      target2Exit: $('waT2').checked,
      target3Exit: $('waT3').checked,
      stopLoss: $('waSL').checked,
      tradeClosed: $('waClosed').checked
    };
    const recipient = $('waRecipient').value.trim();
    const button = $('waSave');
    if (button) button.disabled = true;
    try {
      const r = await fetch('/api/whatsapp/settings', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        credentials: 'include',
        body: JSON.stringify({ recipient, enabled })
      });
      const b = await r.json();
      if ($('waMessage')) $('waMessage').textContent = b.message || (r.ok ? 'WhatsApp settings saved' : 'Unable to save');
      if (r.ok) formDirty = false;
    } catch (err) {
      if ($('waMessage')) $('waMessage').textContent = 'Unable to save WhatsApp settings';
    } finally {
      saveInProgress = false;
      if (button) button.disabled = false;
    }
  }

  $('waSave')?.addEventListener('click', save);
  $('waLogout')?.addEventListener('click', async () => {
    await fetch('/api/whatsapp/logout', {method:'POST', credentials:'include'});
    formDirty = false;
    await load();
  });

  // Status/QR refresh only; it never overwrites unsaved settings.
  // 15 seconds is sufficient because WhatsApp connection changes are not trading ticks.
  load();
  setInterval(load, 15000);
})();
