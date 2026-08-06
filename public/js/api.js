/* global window */
(function () {
  'use strict';

  async function request(method, path, body) {
    let response;
    try {
      response = await fetch(path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        credentials: 'same-origin',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      throw new Error('Network error — could not reach the server. Check your connection.');
    }

    if (response.status === 401) {
      window.location.href = '/login';
      throw new Error('Session expired. Redirecting to login…');
    }

    let json = null;
    try {
      json = await response.json();
    } catch (_e) {
      // no JSON body
    }

    if (!response.ok || !json || json.success === false) {
      const message = (json && (json.message || json.error)) || `Request failed (${response.status})`;
      const err = new Error(message);
      err.status = response.status;
      err.payload = json;
      throw err;
    }

    return json.data;
  }

  const NovaApi = {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body || {}),
    del: (path) => request('DELETE', path),
  };

  /**
   * Wraps an async click handler with a loading spinner + disabled state on
   * the triggering button, and restores it afterwards regardless of outcome.
   * Never marks success until the wrapped promise actually resolves.
   */
  NovaApi.withButtonLoading = function withButtonLoading(button, fn) {
    return async function handler(...args) {
      if (!button || button.disabled) return;
      const originalHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> ' + (button.dataset.loadingText || 'Working…');
      try {
        await fn(...args);
      } finally {
        button.disabled = false;
        button.innerHTML = originalHtml;
      }
    };
  };

  window.NovaApi = NovaApi;
})();
