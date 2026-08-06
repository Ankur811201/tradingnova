/* global window, document */
(function () {
  'use strict';

  function toast(message, type) {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s';
      setTimeout(() => el.remove(), 260);
    }, 4200);
  }

  /**
   * Shows a confirmation modal. Resolves true/false. Used for dangerous
   * actions (enable live trading, close positions) that require explicit
   * confirmation before hitting the backend.
   */
  function confirmModal({ title, message, confirmLabel, danger }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML =
        '<div class="modal">' +
        '<h3>' + (title || 'Confirm action') + '</h3>' +
        '<p>' + (message || 'Are you sure?') + '</p>' +
        '<div class="modal-actions">' +
        '<button class="btn btn-ghost" data-role="cancel">Cancel</button>' +
        '<button class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" data-role="confirm">' + (confirmLabel || 'Confirm') + '</button>' +
        '</div></div>';
      document.body.appendChild(overlay);

      function cleanup(result) {
        overlay.remove();
        resolve(result);
      }
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
      overlay.querySelector('[data-role="cancel"]').addEventListener('click', () => cleanup(false));
      overlay.querySelector('[data-role="confirm"]').addEventListener('click', () => cleanup(true));
    });
  }

  function errorMessage(err) {
    if (!err) return 'Something went wrong.';
    return err.message || 'Something went wrong.';
  }

  function setupMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const toggle = document.getElementById('menuToggle');
    if (!sidebar || !toggle) return;
    function open() { sidebar.classList.add('open'); overlay && overlay.classList.add('open'); }
    function close() { sidebar.classList.remove('open'); overlay && overlay.classList.remove('open'); }
    toggle.addEventListener('click', () => {
      sidebar.classList.contains('open') ? close() : open();
    });
    overlay && overlay.addEventListener('click', close);
    sidebar.querySelectorAll('.nav-item').forEach((a) => a.addEventListener('click', close));
  }

  document.addEventListener('DOMContentLoaded', setupMobileSidebar);

  window.NovaUI = { toast, confirmModal, errorMessage };
})();
