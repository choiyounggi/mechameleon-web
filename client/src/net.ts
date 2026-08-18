import { io, type Socket } from 'socket.io-client';
import type {
  Background,
  ClientToServerEvents,
  Result,
  RoomCreateAck,
  RoomJoinAck,
  RoomStatePublic,
  SeekClickAck,
  ServerToClientEvents,
  StickmanState,
} from 'shared/protocol';
import { createThrottled } from './util/throttle';

export interface HidePayload {
  background: Background;
  endsAt: number;
}

export interface AppState {
  playerId: string | null;
  role: 'hider' | 'seeker' | null;
  room: RoomStatePublic | null;
  hidePayload: HidePayload | null;
}

export interface AppContext {
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  state: AppState;
}

export function createAppContext(): AppContext {
  return {
    socket: io(),
    state: {
      playerId: null,
      role: null,
      room: null,
      hidePayload: null,
    },
  };
}

export function createRoom(ctx: AppContext, nickname: string): Promise<RoomCreateAck> {
  return new Promise((resolve) => {
    ctx.socket.emit('room:create', { nickname }, resolve);
  });
}

export function joinRoom(ctx: AppContext, code: string, nickname: string): Promise<RoomJoinAck> {
  return new Promise((resolve) => {
    ctx.socket.emit('room:join', { code, nickname }, resolve);
  });
}

export function setBackground(ctx: AppContext, background: Background): Promise<Result> {
  return new Promise((resolve) => {
    ctx.socket.emit('room:setBackground', { background }, resolve);
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
