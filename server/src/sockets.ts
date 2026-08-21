import type { Server, Socket } from 'socket.io';
import {
  type ClientToServerEvents,
  type ServerToClientEvents,
  zHideUpdateReq,
  zRoomCreateReq,
  zRoomJoinReq,
  zSeekClickReq,
  zSetBackgroundReq,
  zSetHiderCountReq,
} from 'shared/protocol';
import { type Emit, RoomEngine, type Scheduler, realRng } from './engine/room-engine';

type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Wires Socket.IO to a RoomEngine: zod-parse every inbound payload, delegate
 * to the engine, and route the engine's `emit` callback back onto sockets.
 *
 * `emit('all', ...)` must reach only the sockets in ONE room, but the engine
 * only tells us the target player (or the literal 'all') -- never a room
 * code. For calls this layer makes directly (create/join/setBackground/start/
 * hideConfirm/click/leave), we already know the room (from the request or
 * from `roomOfPlayer`) so we track it in `activeRoomCode` for the duration of
 * that synchronous call. The two phase transitions that fire from an expired
 * timer (hide->seek, seek timeout) happen with no socket call on the stack at
 * all, so the scheduler below captures the room code at *schedule* time and
 * restores it while the timer callback runs.
 */
export function registerSocketHandlers(io: IoServer): RoomEngine {
  const playerSockets = new Map<string, IoSocket>();
  const roomOfPlayer = new Map<string, string>();
  let activeRoomCode: string | undefined;

  function withRoomContext<T>(code: string | undefined, fn: () => T): T {
    const previous = activeRoomCode;
    activeRoomCode = code;
    try {
      return fn();
    } finally {
      activeRoomCode = previous;
    }
  }

  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => {
      const capturedRoomCode = activeRoomCode;
      return setTimeout(() => withRoomContext(capturedRoomCode, fn), ms);
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  // Emit's event/payload are correlated generically (E / ServerEventPayload<E>),
  // which is exactly type-safe for callers of `emit`, but that generic pairing
  // can't be re-proven against socket.io's own per-literal-event overloads from
  // inside this function body -- hence the one local escape hatch here.
  function emitRaw(emitter: unknown, event: string, payload: unknown): void {
    (emitter as { emit: (event: string, payload: unknown) => unknown }).emit(event, payload);
  }

  const emit: Emit = (target, event, payload) => {
    if (target === 'all') {
      if (activeRoomCode) emitRaw(io.to(activeRoomCode), event, payload);
      return;
    }
    const socket = playerSockets.get(target);
    if (socket) emitRaw(socket, event, payload);
  };

  const engine = new RoomEngine({ scheduler, rng: realRng, emit });

  io.on('connection', (socket: IoSocket) => {
    let myPlayerId: string | undefined;

    function bindPlayer(playerId: string, roomCode: string): void {
      myPlayerId = playerId;
      playerSockets.set(playerId, socket);
      roomOfPlayer.set(playerId, roomCode);
      socket.join(roomCode);
    }

    socket.on('room:create', (req, ack) => {
      const parsed = zRoomCreateReq.safeParse(req);
      if (!parsed.success) return ack({ ok: false, code: 'BAD_PAYLOAD' });

      const { code, playerId } = withRoomContext(undefined, () =>
        engine.createRoom(parsed.data.nickname, {
          name: parsed.data.roomName,
          isPrivate: parsed.data.isPrivate,
          password: parsed.data.password,
        }),
      );
      bindPlayer(playerId, code);
      // `createRoom`'s own broadcastState fires before this socket is bound to a
      // player/room, so nothing receives it (see F2, review r1) -- resend now.
      withRoomContext(code, () => engine.broadcastRoom(code));
      ack({ ok: true, code, playerId });
    });

    socket.on('room:join', (req, ack) => {
      const parsed = zRoomJoinReq.safeParse(req);
      if (!parsed.success) return ack({ ok: false, code: 'BAD_PAYLOAD' });

      const result = withRoomContext(parsed.data.code, () =>
        engine.join(parsed.data.code, parsed.data.nickname, parsed.data.password),
      );
      if (result.ok) {
        bindPlayer(result.playerId, parsed.data.code);
        // join()'s own broadcast fired before this socket entered the room —
        // re-broadcast so the joiner gets the initial state (same class as
        // the room:create fix, review r1 F2).
        withRoomContext(parsed.data.code, () => engine.broadcastRoom(parsed.data.code));
      }
      ack(result);
    });

    socket.on('rooms:list', (ack) => {
      ack({ ok: true, rooms: engine.listRooms() });
    });

    socket.on('room:setBackground', (req, ack) => {
      const parsed = zSetBackgroundReq.safeParse(req);
      if (!parsed.success) return ack({ ok: false, code: 'BAD_PAYLOAD' });
      if (!myPlayerId) return ack({ ok: false, code: 'ROOM_NOT_FOUND' });

      const playerId = myPlayerId;
      ack(withRoomContext(roomOfPlayer.get(playerId), () => engine.setBackground(playerId, parsed.data.background)));
    });

    socket.on('room:setHiderCount', (req, ack) => {
      const parsed = zSetHiderCountReq.safeParse(req);
      if (!parsed.success) return ack({ ok: false, code: 'BAD_PAYLOAD' });
      if (!myPlayerId) return ack({ ok: false, code: 'ROOM_NOT_FOUND' });

      const playerId = myPlayerId;
      ack(withRoomContext(roomOfPlayer.get(playerId), () => engine.setHiderCount(playerId, parsed.data.count)));
    });

    socket.on('game:start', (ack) => {
      if (!myPlayerId) return ack({ ok: false, code: 'ROOM_NOT_FOUND' });

      const playerId = myPlayerId;
      ack(withRoomContext(roomOfPlayer.get(playerId), () => engine.start(playerId)));
    });

    socket.on('hide:update', (req) => {
      const parsed = zHideUpdateReq.safeParse(req);
      if (!parsed.success || !myPlayerId) return;

      const playerId = myPlayerId;
      withRoomContext(roomOfPlayer.get(playerId), () => engine.hideUpdate(playerId, parsed.data.stickman));
    });

    socket.on('hide:confirm', (ack) => {
      if (!myPlayerId) return ack({ ok: false, code: 'ROOM_NOT_FOUND' });

      const playerId = myPlayerId;
      ack(withRoomContext(roomOfPlayer.get(playerId), () => engine.hideConfirm(playerId)));
    });

    socket.on('seek:click', (req, ack) => {
      const parsed = zSeekClickReq.safeParse(req);
      if (!parsed.success) return ack({ ok: false, code: 'BAD_PAYLOAD' });
      if (!myPlayerId) return ack({ ok: false, code: 'ROOM_NOT_FOUND' });

      const playerId = myPlayerId;
      const result = withRoomContext(roomOfPlayer.get(playerId), () =>
        engine.click(playerId, parsed.data.x, parsed.data.y),
      );
      ack({ ok: true, result });
    });

    socket.on('room:leave', (ack) => {
      if (!myPlayerId) return ack({ ok: true });
      const playerId = myPlayerId;
      const roomCode = roomOfPlayer.get(playerId);
      // Unsubscribe BEFORE engine.leave() runs -- it broadcasts the room's
      // final room:state synchronously (io.to(roomCode).emit), and a socket
      // still subscribed at that point would receive its own departure.
      if (roomCode) socket.leave(roomCode);
      withRoomContext(roomCode, () => engine.leave(playerId));
      playerSockets.delete(playerId);
      roomOfPlayer.delete(playerId);
      myPlayerId = undefined;
      ack({ ok: true });
    });

    socket.on('disconnect', () => {
      if (!myPlayerId) return;
      const playerId = myPlayerId;
      const roomCode = roomOfPlayer.get(playerId);
      withRoomContext(roomCode, () => engine.leave(playerId));
      playerSockets.delete(playerId);
      roomOfPlayer.delete(playerId);
    });
  });

  return engine;
}
