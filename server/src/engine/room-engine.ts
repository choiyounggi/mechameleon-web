import { randomUUID } from 'node:crypto';
import {
  type Background,
  HIDE_MS,
  LOCKOUT_MS,
  MAX_PLAYERS,
  MAX_SCALE,
  MIN_PLAYERS,
  MIN_SCALE,
  type PlayerPublic,
  type Result,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type RoomStatePublic,
  type RoomSummary,
  SEEK_MS,
  type ServerToClientEvents,
  type StickmanState,
  type Winner,
} from 'shared/protocol';
import { hitTest, initialStickman } from 'shared/stickman';

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const realRng = (): number => Math.random();

type ServerEventName = keyof ServerToClientEvents;
type ServerEventPayload<E extends ServerEventName> = Parameters<ServerToClientEvents[E]>[0];
export type Emit = <E extends ServerEventName>(
  target: string | 'all',
  event: E,
  payload: ServerEventPayload<E>,
) => void;

interface Player {
  id: string;
  nickname: string;
  isHost: boolean;
}

interface Room {
  code: string;
  name: string;
  isPrivate: boolean;
  password: string | null;
  phase: 'lobby' | 'hide' | 'seek' | 'result';
  players: Player[]; // join order; players[0] is host unless host left and was reassigned
  hiderId: string | null;
  background: Background | null;
  stickman: StickmanState | null;
  endsAt: number | null;
  lockouts: Map<string, number>; // playerId -> lockedUntil (epoch ms)
  hideTimer: unknown | null;
  seekTimer: unknown | null;
}

/**
 * Pure game state machine for one stickmeleon server: room create/join/leave,
 * lobby->hide->seek->result phase transitions, and seek-click adjudication.
 * No I/O of its own -- callers inject a Scheduler/rng/emit and the socket
 * layer (server/src/sockets.ts) wires `emit` to socket.io.
 */
export class RoomEngine {
  private readonly scheduler: Scheduler;
  private readonly rng: () => number;
  private readonly emit: Emit;
  private readonly rooms = new Map<string, Room>();
  private readonly playerRooms = new Map<string, string>();

  constructor(deps: { scheduler: Scheduler; rng: () => number; emit: Emit }) {
    this.scheduler = deps.scheduler;
    this.rng = deps.rng;
    this.emit = deps.emit;
  }

  createRoom(
    nickname: string,
    opts: { name: string; isPrivate: boolean; password?: string },
  ): { code: string; playerId: string } {
    const code = this.generateRoomCode();
    const playerId = randomUUID();
    const room: Room = {
      code,
      name: opts.name,
      isPrivate: opts.isPrivate,
      password: opts.isPrivate ? (opts.password ?? null) : null,
      phase: 'lobby',
      players: [{ id: playerId, nickname, isHost: true }],
      hiderId: null,
      background: null,
      stickman: null,
      endsAt: null,
      lockouts: new Map(),
      hideTimer: null,
      seekTimer: null,
    };
    this.rooms.set(code, room);
    this.playerRooms.set(playerId, code);
    this.broadcastState(room);
    return { code, playerId };
  }

  join(code: string, nickname: string, password?: string): Result<{ playerId: string }> {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND' };
    if (room.phase !== 'lobby') return { ok: false, code: 'BAD_PHASE' };
    if (room.players.length >= MAX_PLAYERS) return { ok: false, code: 'ROOM_FULL' };
    if (room.isPrivate && room.password !== null && password !== room.password) {
      return { ok: false, code: 'WRONG_PASSWORD' };
    }

    const playerId = randomUUID();
    room.players.push({ id: playerId, nickname, isHost: false });
    this.playerRooms.set(playerId, room.code);
    this.broadcastState(room);
    return { ok: true, playerId };
  }

  leave(playerId: string): void {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return;

    const wasHider = room.hiderId === playerId;
    room.players = room.players.filter((p) => p.id !== playerId);
    room.lockouts.delete(playerId);
    this.playerRooms.delete(playerId);

    if (room.players.length === 0) {
      this.clearTimers(room);
      this.rooms.delete(room.code);
      return;
    }

    // A hostless room is stuck (setBackground/start are host-only) — reassign
    // in every phase, not just lobby, so a post-game room stays operable.
    if (!room.players.some((p) => p.isHost)) {
      room.players[0].isHost = true;
    }

    if (room.phase === 'hide' || room.phase === 'seek') {
      const seekersLeft = room.players.some((p) => p.id !== room.hiderId);
      if (wasHider || !seekersLeft || room.players.length < MIN_PLAYERS) {
        // The game is no longer playable — abort it and send everyone back to
        // the lobby instead of showing a result screen.
        this.emit('all', 'game:aborted', {
          reason: wasHider ? 'hider_left' : 'not_enough_players',
        });
        this.resetToLobby(room);
        return;
      }
      this.broadcastState(room);
      return;
    }

    // lobby/result phase: nothing to reconcile beyond removal.
    this.broadcastState(room);
  }

  /**
   * Result-screen restart, host only: 'same' keeps the background for an
   * instant rematch, 'new' clears it so the lobby steers the host to capture
   * a fresh URL before the next round.
   */
  restart(playerId: string, mode: 'same' | 'new'): Result {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND' };
    if (!this.isHost(room, playerId)) return { ok: false, code: 'NOT_HOST' };
    if (room.phase !== 'result') return { ok: false, code: 'BAD_PHASE' };

    if (mode === 'new') room.background = null;
    this.resetToLobby(room);
    return { ok: true };
  }

  setBackground(playerId: string, background: Background): Result {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND' };
    if (!this.isHost(room, playerId)) return { ok: false, code: 'NOT_HOST' };
    if (room.phase !== 'lobby') return { ok: false, code: 'BAD_PHASE' };

    room.background = background;
    this.broadcastState(room);
    return { ok: true };
  }

  start(playerId: string): Result {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND' };
    if (!this.isHost(room, playerId)) return { ok: false, code: 'NOT_HOST' };
    if (room.phase !== 'lobby') return { ok: false, code: 'BAD_PHASE' };
    if (room.players.length < MIN_PLAYERS) return { ok: false, code: 'NEED_PLAYERS' };
    if (!room.background) return { ok: false, code: 'NEED_BACKGROUND' };

    const hider = room.players[Math.floor(this.rng() * room.players.length)];
    room.hiderId = hider.id;
    room.stickman = this.defaultStickman(room.background);
    for (const p of room.players) {
      this.emit(p.id, 'game:role', { role: p.id === hider.id ? 'hider' : 'seeker' });
    }

    room.phase = 'hide';
    room.endsAt = Date.now() + HIDE_MS;
    room.hideTimer = this.scheduler.setTimeout(() => this.onHideExpire(room.code), HIDE_MS);

    this.emit(hider.id, 'phase:hide', { background: room.background, endsAt: room.endsAt });
    for (const p of room.players) {
      if (p.id !== hider.id) {
        this.emit(p.id, 'phase:hideWait', { endsAt: room.endsAt });
      }
    }
    this.broadcastState(room);
    return { ok: true };
  }

  hideUpdate(playerId: string, stickman: StickmanState): void {
    const room = this.findRoomByPlayer(playerId);
    if (!room || room.phase !== 'hide' || room.hiderId !== playerId) return;
    // Invariant: background is always set by `start()`, before phase can reach 'hide'.
    room.stickman = this.clampStickman(stickman, room.background!);
  }

  hideConfirm(playerId: string): Result {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND' };
    if (room.phase !== 'hide') return { ok: false, code: 'BAD_PHASE' };
    if (room.hiderId !== playerId) return { ok: false, code: 'NOT_HIDER' };

    this.beginSeekPhase(room);
    return { ok: true };
  }

  click(playerId: string, x: number, y: number): 'hit' | 'miss' | 'locked' | 'rejected' {
    const room = this.findRoomByPlayer(playerId);
    if (!room || room.phase !== 'seek' || playerId === room.hiderId) return 'rejected';

    const lockedUntil = room.lockouts.get(playerId) ?? 0;
    if (Date.now() < lockedUntil) return 'locked';

    // Invariant: stickman is always set at `start()`, before phase can reach 'seek'.
    if (hitTest(room.stickman!, x, y)) {
      this.enterResult(room, { winner: 'seekers', foundBy: playerId, reason: 'found' });
      return 'hit';
    }

    room.lockouts.set(playerId, Date.now() + LOCKOUT_MS);
    this.emit('all', 'seek:miss', { x, y, by: playerId });
    return 'miss';
  }

  /** Re-broadcasts the current public state of `code`'s room to 'all', if it exists. */
  broadcastRoom(code: string): void {
    const room = this.rooms.get(code);
    if (room) this.broadcastState(room);
  }

  /** Public room-list rows for the lobby browser (insertion order). */
  listRooms(): RoomSummary[] {
    return [...this.rooms.values()].map((room) => ({
      code: room.code,
      name: room.name,
      isPrivate: room.isPrivate,
      playerCount: room.players.length,
      maxPlayers: MAX_PLAYERS,
      phase: room.phase,
    }));
  }

  /** Clears every room's pending timers (D14 graceful shutdown). */
  shutdown(): void {
    for (const room of this.rooms.values()) {
      this.clearTimers(room);
    }
  }

  // ---- internals -----------------------------------------------------------

  private generateRoomCode(): string {
    for (let attempt = 0; attempt < 5; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[Math.floor(this.rng() * ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('ROOM_CODE_EXHAUSTED');
  }

  private defaultStickman(background: Background): StickmanState {
    // top-center of the page (see shared/stickman.ts initialStickman) with an
    // unpainted white body — the hider paints with the brush
    return initialStickman(background.width, background.height);
  }

  private clampStickman(stickman: StickmanState, background: Background): StickmanState {
    return {
      ...stickman,
      x: Math.min(Math.max(stickman.x, 0), background.width),
      y: Math.min(Math.max(stickman.y, 0), background.height),
      scale: Math.min(Math.max(stickman.scale, MIN_SCALE), MAX_SCALE),
    };
  }

  private isHost(room: Room, playerId: string): boolean {
    return room.players.find((p) => p.id === playerId)?.isHost ?? false;
  }

  private findRoomByPlayer(playerId: string): Room | undefined {
    const code = this.playerRooms.get(playerId);
    return code ? this.rooms.get(code) : undefined;
  }

  private beginSeekPhase(room: Room): void {
    if (room.hideTimer !== null) {
      this.scheduler.clearTimeout(room.hideTimer);
      room.hideTimer = null;
    }
    room.phase = 'seek';
    room.endsAt = Date.now() + SEEK_MS;
    room.seekTimer = this.scheduler.setTimeout(() => this.onSeekExpire(room.code), SEEK_MS);

    this.emit('all', 'phase:seek', {
      background: room.background!,
      stickman: room.stickman!,
      endsAt: room.endsAt,
    });
    this.broadcastState(room);
  }

  private onHideExpire(code: string): void {
    const room = this.rooms.get(code);
    if (!room || room.phase !== 'hide') return;
    this.beginSeekPhase(room);
  }

  private onSeekExpire(code: string): void {
    const room = this.rooms.get(code);
    if (!room || room.phase !== 'seek') return;
    this.enterResult(room, { winner: 'hider', foundBy: undefined, reason: 'timeout' });
  }

  private clearTimers(room: Room): void {
    if (room.hideTimer !== null) {
      this.scheduler.clearTimeout(room.hideTimer);
      room.hideTimer = null;
    }
    if (room.seekTimer !== null) {
      this.scheduler.clearTimeout(room.seekTimer);
      room.seekTimer = null;
    }
  }

  /** Back to the waiting room: wipes per-game state, keeps players/background. */
  private resetToLobby(room: Room): void {
    this.clearTimers(room);
    room.phase = 'lobby';
    room.hiderId = null;
    room.stickman = null;
    room.endsAt = null;
    room.lockouts.clear();
    this.broadcastState(room);
  }

  private enterResult(
    room: Room,
    payload: { winner: Winner; foundBy: string | undefined; reason: 'found' | 'timeout' },
  ): void {
    this.clearTimers(room);
    room.phase = 'result';
    room.endsAt = null;
    this.emit('all', 'game:end', {
      winner: payload.winner,
      foundBy: payload.foundBy,
      stickman: room.stickman,
      reason: payload.reason,
    });
    this.broadcastState(room);
  }

  private toPublic(room: Room): RoomStatePublic {
    const players: PlayerPublic[] = room.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      isHost: p.isHost,
    }));
    return {
      code: room.code,
      name: room.name,
      isPrivate: room.isPrivate,
      phase: room.phase,
      players,
      background: room.background,
      endsAt: room.endsAt,
    };
  }

  private broadcastState(room: Room): void {
    this.emit('all', 'room:state', this.toPublic(room));
  }
}
