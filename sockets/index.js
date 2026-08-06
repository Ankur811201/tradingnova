'use strict';

const { Server } = require('socket.io');
const { env } = require('../config/env');

/**
 * Socket.IO wiring.
 *
 * Rooms:
 *  room:market          - market price/status
 *  room:paper:<userId>  - paper trading updates
 *  room:live            - live trading updates
 *  room:bots            - general bot events
 *  room:logs            - logs
 *  bot:<instanceId>     - SINGLE BOT detail page events
 */

function resolveSocketCorsOrigin() {
  if (!env.CORS_ALLOWED_ORIGIN) {
    return true;
  }

  return env.CORS_ALLOWED_ORIGIN
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}


function initSockets(httpServer, sessionMiddleware) {

  // =========================================================
  // CREATE SOCKET.IO SERVER
  // =========================================================

  const io = new Server(httpServer, {
    cors: {
      origin: resolveSocketCorsOrigin(),
      credentials: true
    }
  });


  // =========================================================
  // EXPRESS SESSION → SOCKET.IO
  // =========================================================

  const wrap = (middleware) => {
    return (socket, next) => {
      middleware(socket.request, {}, next);
    };
  };

  io.use(wrap(sessionMiddleware));


  // =========================================================
  // AUTHENTICATION
  // =========================================================

  io.use((socket, next) => {

    const session = socket.request.session;

    if (!session || !session.userId) {

      console.warn(
        '[SOCKET] Rejected unauthenticated connection'
      );

      return next(
        new Error('UNAUTHENTICATED')
      );
    }

    socket.userId = session.userId;

    return next();
  });


  // =========================================================
  // CONNECTION
  // =========================================================

  io.on('connection', (socket) => {

    console.log(
      `[SOCKET] Connected: ${socket.id} user=${socket.userId}`
    );


    // =======================================================
    // DEFAULT ROOMS
    // =======================================================

    socket.join('room:market');

    socket.join(
      `room:paper:${socket.userId}`
    );

    socket.join('room:live');

    socket.join('room:bots');

    socket.join('room:logs');


    // =======================================================
    // SYSTEM CONNECTION STATUS
    // =======================================================

    socket.emit('system:status', {
      connected: true,
      at: new Date().toISOString()
    });


    // =======================================================
    // SINGLE BOT DETAIL PAGE
    // =======================================================

    socket.on(
      'subscribe:bot',
      ({ instanceId } = {}) => {

        if (
          !instanceId ||
          typeof instanceId !== 'string'
        ) {

          console.warn(
            '[SOCKET] Invalid subscribe:bot request',
            {
              socketId: socket.id,
              instanceId
            }
          );

          return;
        }


        const room =
          `bot:${instanceId}`;


        socket.join(room);


        console.log(
          `[SOCKET] ${socket.id} joined ${room}`
        );


        // Tell frontend subscription succeeded
        socket.emit(
          'bot:subscribed',
          {
            instanceId,
            room
          }
        );
      }
    );


    // =======================================================
    // OPTIONAL UNSUBSCRIBE
    // =======================================================

    socket.on(
      'unsubscribe:bot',
      ({ instanceId } = {}) => {

        if (
          !instanceId ||
          typeof instanceId !== 'string'
        ) {
          return;
        }


        const room =
          `bot:${instanceId}`;


        socket.leave(room);


        console.log(
          `[SOCKET] ${socket.id} left ${room}`
        );
      }
    );


    // =======================================================
    // DISCONNECT
    // =======================================================

    socket.on(
      'disconnect',
      (reason) => {

        console.log(
          `[SOCKET] Disconnected: ${socket.id}`,
          reason
        );

        // Socket.IO automatically removes
        // the socket from all rooms.
      }
    );

  });


  // =========================================================
  // RETURN IO
  // =========================================================

  return io;
}


module.exports = {
  initSockets
};