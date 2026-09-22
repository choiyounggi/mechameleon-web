import { io, type Socket } from 'socket.io-client';
import type {
  Background,
  ClientToServerEvents,
  Result,
  RoomCreateAck,
  RoomJoinAck,
  RoomRejoinAck,
  RoomStatePublic,
  RoomSummary,
  SeekClickAck,
  ServerToClientEvents,
  StickmanState,
} from 'shared/protocol';
import { createThrottled } from './util/throttle';

export interface HidePayload {
  background: Background;
  endsAt: number;
  stickman: StickmanState;
}

export interface AppState {
  playerId: string | null;
  role: 'hider' | 'seeker' | null;
  room: RoomStatePublic | null;
  hidePayload: HidePayload | null;
  abortNotice: string | null; // why the last game was aborted, shown in the lobby
  nickname: string | null; // set on room:create/room:join; survives leaveToHome's reset (r1 F1)
}

export interface AppContext {
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  state: AppState;
  // Wired by app.ts bootstrap: emits room:leave, resets state, and force-
  // remounts the lobby home screen.
  leaveToHome?: () => Promise<void>;
}

export function createAppContext(): AppContext {
  return {
    socket: io(),
    state: {
      playerId: null,
      role: null,
      room: null,
      hidePayload: null,
      abortNotice: null,
      nickname: null,
    },
  };
}

// Tab-scoped identity so a refresh/reconnect can room:rejoin the same seat.
const IDENTITY_STORAGE_KEY = 'mc-identity';

interface StoredIdentity {
  playerId: string;
  roomCode: string;
}

function saveIdentity(identity: StoredIdentity): void {
  try {
    window.sessionStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
  } catch {
    /* private mode -- non-fatal */
  }
}

function loadIdentity(): StoredIdentity | null {
  try {
    const raw = window.sessionStorage.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.playerId === 'string' && typeof parsed?.roomCode === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

export function clearIdentity(): void {
  try {
    window.sessionStorage.removeItem(IDENTITY_STORAGE_KEY);
  } catch {
    /* private mode -- non-fatal */
  }
}

export interface CreateRoomOpts {
  roomName: string;
  isPrivate: boolean;
  password?: string;
}

export function createRoom(ctx: AppContext, nickname: string, opts: CreateRoomOpts): Promise<RoomCreateAck> {
  return new Promise((resolve) => {
    ctx.socket.emit('room:create', { nickname, ...opts }, (res) => {
      if (res.ok) saveIdentity({ playerId: res.playerId, roomCode: res.code });
      resolve(res);
    });
  });
}

export function joinRoom(
  ctx: AppContext,
  code: string,
  nickname: string,
  password?: string,
): Promise<RoomJoinAck> {
  return new Promise((resolve) => {
    ctx.socket.emit('room:join', { code, nickname, password }, (res) => {
      if (res.ok) saveIdentity({ playerId: res.playerId, roomCode: code });
      resolve(res);
    });
  });
}

export function rejoinRoom(ctx: AppContext): Promise<RoomRejoinAck> | null {
  const identity = loadIdentity();
  if (!identity) return null;

  // Optimistic: the server's snapshot events (room:state, etc.) arrive
  // BEFORE this ack over the same connection (room:rejoin acks last), so
  // any phase screen reading ctx.state.playerId off those events would
  // otherwise race a playerId set only inside the ack callback.
  ctx.state.playerId = identity.playerId;

  return new Promise((resolve) => {
    ctx.socket.emit('room:rejoin', { playerId: identity.playerId }, (res: RoomRejoinAck) => {
      if (!res.ok) {
        ctx.state.playerId = null;
        clearIdentity();
      }
      resolve(res);
    });
  });
}

export function leaveRoom(ctx: AppContext): Promise<{ ok: true }> {
  return new Promise((resolve) => {
    ctx.socket.emit('room:leave', resolve);
  });
}

export function listRooms(ctx: AppContext): Promise<{ ok: true; rooms: RoomSummary[] }> {
  return new Promise((resolve) => {
    ctx.socket.emit('rooms:list', resolve);
  });
}

export function setBackground(ctx: AppContext, background: Background): Promise<Result> {
  return new Promise((resolve) => {
    ctx.socket.emit('room:setBackground', { background }, resolve);
  });
}

export function setHiderCount(ctx: AppContext, count: number | null): Promise<Result> {
  return new Promise((resolve) => {
    ctx.socket.emit('room:setHiderCount', { count }, resolve);
  });
}

export function startGame(ctx: AppContext): Promise<Result> {
  return new Promise((resolve) => {
    ctx.socket.emit('game:start', resolve);
  });
}

export function hideConfirm(ctx: AppContext): Promise<Result> {
  return new Promise((resolve) => {
    ctx.socket.emit('hide:confirm', resolve);
  });
}

export function seekClick(ctx: AppContext, x: number, y: number): Promise<SeekClickAck> {
  return new Promise((resolve) => {
    ctx.socket.emit('seek:click', { x, y }, resolve);
  });
}

const HIDE_UPDATE_THROTTLE_MS = 100;

// Fresh throttle state per hide-mount (D4/D8): created on PhaseController.mount,
// cancel()'d on unmount so no stale trailing emit fires after leaving the phase.
export function createHideUpdateSender(ctx: AppContext): {
  send: (stickman: StickmanState) => void;
  cancel: () => void;
} {
  return createThrottled((stickman: StickmanState) => {
    ctx.socket.emit('hide:update', { stickman });
  }, HIDE_UPDATE_THROTTLE_MS);
}
