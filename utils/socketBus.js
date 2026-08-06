'use strict';

/**
 * socketBus — a minimal accessor so REST controllers can broadcast real-time
 * updates (e.g. after a paper/live trade mutates state) without any core
 * service (PaperEngine, LiveEngine, RiskEngine, BotManager, DeltaAdapter)
 * needing to know about Socket.IO. This keeps Part 1's execution engines
 * transport-agnostic; only the HTTP layer (controllers) pushes UI events.
 *
 * Added for Part 2 because Part 1 shipped Socket.IO plumbing (rooms, auth)
 * but only market data / bot / log events were ever broadcast — there was
 * no event for paper/live portfolio, order, or position changes, which the
 * dashboard needs for real-time updates. No existing event names or rooms
 * were changed; this only adds new emits using the existing room scheme
 * documented in sockets/index.js.
 */
let ioRef = null;

function attachIO(io) {
  ioRef = io;
}

function getIO() {
  return ioRef;
}

/** Emits to the given room only if the socket server has been attached (no-op otherwise, e.g. in tests). */
function emitTo(room, event, payload) {
  if (ioRef) ioRef.to(room).emit(event, payload);
}

module.exports = { attachIO, getIO, emitTo };
