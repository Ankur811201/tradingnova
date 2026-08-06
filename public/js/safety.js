/* global window, document, NovaApi, NovaUI, NovaFormat */
(function () {
  'use strict';

  const { formatTime } = NovaFormat;

  async function loadStatus() {
    try {
      const status = await NovaApi.get('/api/safety/status');
      document.getElementById('sLiveTrading').innerHTML = status.liveTradingEnabled
        ? '<span class="badge badge-live">Enabled</span>'
        : '<span class="badge badge-neutral">Disabled</span>';
      document.getElementById('sEnabledAt').textContent = status.liveTradingEnabledAt ? formatTime(status.liveTradingEnabledAt) : 'Never';
      document.getElementById('sStoppedAt').textContent = status.allBotsStoppedAt ? formatTime(status.allBotsStoppedAt) : 'Never';
    } catch (_err) {
      document.getElementById('sLiveTrading').textContent = 'Unavailable';
    }
  }

  function wire(id, handler) {
    const btn = document.getElementById(id);
    btn.addEventListener('click', NovaApi.withButtonLoading(btn, handler));
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadStatus();

    wire('stopOneBtn', async () => {
      const instanceId = document.getElementById('stopInstanceId').value.trim();
      if (!instanceId) { NovaUI.toast('Enter a Bot Instance ID first', 'error'); return; }
      const ok = await NovaUI.confirmModal({ title: 'Stop this bot?', message: 'Instance ' + instanceId + ' will stop. Open positions are not affected.', confirmLabel: 'Stop Bot' });
      if (!ok) return;
      try {
        await NovaApi.post('/api/safety/bots/' + encodeURIComponent(instanceId) + '/stop');
        NovaUI.toast('Bot stopped', 'success');
      } catch (err) { NovaUI.toast(NovaUI.errorMessage(err), 'error'); }
    });

    wire('stopAllBtn', async () => {
      const ok = await NovaUI.confirmModal({ title: 'Stop ALL bots?', message: 'Every running bot instance will stop. Open positions are not affected.', confirmLabel: 'Stop All Bots', danger: true });
      if (!ok) return;
      try {
        await NovaApi.post('/api/safety/bots/stop-all');
        NovaUI.toast('All bots stopped', 'success');
      } catch (err) { NovaUI.toast(NovaUI.errorMessage(err), 'error'); }
    });

    wire('disableLiveBtn', async () => {
      const ok = await NovaUI.confirmModal({ title: 'Disable new live trades?', message: 'No new LIVE trades will be accepted. Existing positions are not affected.', confirmLabel: 'Disable Live Trading' });
      if (!ok) return;
      try {
        await NovaApi.post('/api/safety/live-trading/disable');
        NovaUI.toast('Live trading disabled', 'success');
        await loadStatus();
      } catch (err) { NovaUI.toast(NovaUI.errorMessage(err), 'error'); }
    });

    wire('enableLiveBtn', async () => {
      const ok = await NovaUI.confirmModal({ title: 'Enable live trading?', message: 'This allows REAL-MONEY orders to be placed on Delta Exchange from now on. Only proceed if credentials and risk settings are verified.', confirmLabel: 'Enable Live Trading', danger: true });
      if (!ok) return;
      try {
        await NovaApi.post('/api/safety/live-trading/enable', { confirm: 'CONFIRM' });
        NovaUI.toast('Live trading enabled', 'success');
        await loadStatus();
      } catch (err) { NovaUI.toast(NovaUI.errorMessage(err), 'error'); }
    });

    wire('closeOneBtn', async () => {
      const positionId = document.getElementById('closeOnePositionId').value.trim();
      if (!positionId) { NovaUI.toast('Enter a Position ID first', 'error'); return; }
      const ok = await NovaUI.confirmModal({ title: 'Close this position?', message: 'Position ' + positionId + ' will be closed via the correct Paper/Live execution path. This cannot be undone.', confirmLabel: 'Close Position', danger: true });
      if (!ok) return;
      try {
        await NovaApi.post('/api/safety/positions/' + encodeURIComponent(positionId) + '/close', { confirm: 'CONFIRM' });
        NovaUI.toast('Position closed', 'success');
      } catch (err) { NovaUI.toast(NovaUI.errorMessage(err), 'error'); }
    });

    wire('closeAllBtn', async () => {
      const ok = await NovaUI.confirmModal({ title: 'Close ALL positions?', message: 'Every open PAPER and LIVE position will be closed immediately, including real-money Delta positions. This cannot be undone.', confirmLabel: 'Close Everything', danger: true });
      if (!ok) return;
      try {
        await NovaApi.post('/api/safety/positions/close-all', { confirm: 'CONFIRM' });
        NovaUI.toast('All positions closed', 'success');
      } catch (err) { NovaUI.toast(NovaUI.errorMessage(err), 'error'); }
    });
  });
})();
