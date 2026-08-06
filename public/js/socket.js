/* global window, document, io */
(function () {
  'use strict';

  const indicator = document.getElementById('connIndicator');
  const label = document.getElementById('connLabel');

  function setStatus(online) {
    if (!indicator || !label) return;
    indicator.classList.remove('online', 'offline');
    indicator.classList.add(online ? 'online' : 'offline');
    label.textContent = online ? 'Connected' : 'Disconnected';
  }

  let socket = null;
  try {
    socket = io({ withCredentials: true });
  } catch (_e) {
    socket = null;
  }

  if (socket) {
    socket.on('connect', () => setStatus(true));
    socket.on('disconnect', () => setStatus(false));
    socket.on('connect_error', () => setStatus(false));
  } else {
    setStatus(false);
  }

  /**
   * Thin wrapper so page scripts can do NovaSocket.on('market:price', fn)
   * without worrying about whether the socket connected successfully.
   * Only forwards events Part 1 actually emits (see sockets/index.js):
   * market:price, market:status, bot:status, bot:event, log:new,
   * system:status, plus Part 2 additions paper:portfolio, live:portfolio,
   * position:update, order:update.
   */
  window.NovaSocket = {
    on(event, handler) {
      if (socket) socket.on(event, handler);
    },
    off(event, handler) {
      if (socket) socket.off(event, handler);
    },
  };
})();
