/* global window, document, NovaApi */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('loginForm');
    const alertBox = document.getElementById('loginAlert');
    const btn = document.getElementById('loginBtn');

    function showError(message) {
      alertBox.textContent = message;
      alertBox.classList.remove('hidden');
    }
    function hideError() {
      alertBox.classList.add('hidden');
    }

    form.addEventListener('submit', NovaApi.withButtonLoading(btn, async (e) => {
      e.preventDefault();
      hideError();
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      if (!username || !password) {
        showError('Please enter your username and password.');
        return;
      }
      try {
        await NovaApi.post('/api/auth/login', { username, password });
        window.location.href = '/dashboard';
      } catch (err) {
        showError(err.message || 'Invalid credentials.');
      }
    }));
  });
})();
