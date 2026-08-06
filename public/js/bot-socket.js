'use strict';

/**
 * Single shared Socket.IO connection for the bot-detail page.
 *
 * Created ONCE here and exposed via window.NovaBotSocket so every other
 * bot-detail script (bot-detail-ws.js, bot-detail-chart.js, and anything
 * added later) reuses the exact same connection and the exact same
 * `bot:<instanceId>` room subscription, instead of each opening its own
 * socket. Must be loaded before those scripts.
 *
 * Reconnects are handled by the Socket.IO client itself; our 'connect'
 * handler below fires again on every reconnect too, so `subscribe:bot` is
 * naturally re-sent and the room membership is restored automatically.
 */
(function () {
  if (window.NovaBotSocket) return; // already created — never open a second connection

  var instanceId = window.BOT_CONFIG && window.BOT_CONFIG.instanceId;
  var socket = io();

  socket.on('connect', function () {
    console.log('✅ Socket connected:', socket.id);
    if (instanceId) {
      socket.emit('subscribe:bot', { instanceId: instanceId });
      console.log('🤖 Subscribed to bot:', instanceId);
    } else {
      console.error('[SOCKET] window.BOT_CONFIG.instanceId missing — cannot subscribe:bot');
    }
  });

  socket.on('disconnect', function (reason) {
    console.log('❌ Socket disconnected:', reason);
  });

  window.NovaBotSocket = socket;
})();
