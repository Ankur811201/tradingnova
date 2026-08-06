/* global window, document, NovaApi, NovaUI */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    const logoutBtn = document.getElementById('logoutBtn');
    if (!logoutBtn) return;
    logoutBtn.addEventListener('click', NovaApi.withButtonLoading(logoutBtn, async () => {
      try {
        await NovaApi.post('/api/auth/logout');
        window.location.href = '/login';
      } catch (err) {
        NovaUI.toast(NovaUI.errorMessage(err), 'error');
      }
    }));
  });
})();
