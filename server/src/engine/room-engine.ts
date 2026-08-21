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
  RESULT_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type RoomStatePublic,
  type RoomSummary,
  SEEK_MS,
  type SeekStickman,
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
  hiderIds: Set<string>; // insertion order = seek-phase hit-test priority order
  stickmen: Map<string, StickmanState>; // per-hider stickman, keyed by playerId
  confirmed: Set<string>; // hiderIds who have hideConfirm'd this round
  found: Set<string>; // hiderIds already hit this round (subset of hiderIds)
  hiderCount: number | null; // host-configured; null = auto (floor(n/2))
  background: Background | null;
  endsAt: number | null;
  lockouts: Map<string, number>; // playerId -> lockedUntil (epoch ms)
  hideTimer: unknown | null;
  seekTimer: unknown | null;
  resultTimer: unknown | null;
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
      hiderIds: new Set(),
      stickmen: new Map(),
      confirmed: new Set(),
      found: new Set(),
      hiderCount: null,
      background: null,
      endsAt: null,
      lockouts: new Map(),
      hideTimer: null,
      seekTimer: null,
      resultTimer: null,
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

    room.players = room.players.filter((p) => p.id !== playerId);
    room.lockouts.delete(playerId);
    room.hiderIds.delete(playerId);
    room.stickmen.delete(playerId);
    room.confirmed.delete(playerId);
    room.found.delete(playerId);
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
      if (room.hiderIds.size === 0) {
        // Abort only fires once every hider is gone — a partial hider
        // departure just shrinks the game (below).
        this.emit('all', 'game:aborted', { reason: 'hider_left' });
        this.resetToLobby(room);
        return;
      }
      const seekersLeft = room.players.some((p) => !room.hiderIds.has(p.id));
      if (!seekersLeft || room.players.length < MIN_PLAYERS) {
        this.emit('all', 'game:aborted', { reason: 'not_enough_players' });
        this.resetToLobby(room);
        return;
      }
      if (room.phase === 'hide' && [...room.hiderIds].every((id) => room.confirmed.has(id))) {
        // The departure was the last unconfirmed hider — everyone remaining is ready.
        this.beginSeekPhase(room);
        return;
      }
      if (room.phase === 'seek' && room.found.size === room.hiderIds.size) {
        // The departed hider was the last unfound one.
        this.enterResult(room, 'seekers', 'all_found');
        return;
      }
      this.broadcastState(room);
      return;
    }

    // lobby/result phase: nothing to reconcile beyond removal.
    this.broadcastState(room);
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

  setHiderCount(playerId: string, count: number | null): Result {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND' };
    if (!this.isHost(room, playerId)) return { ok: false, code: 'NOT_HOST' };
    if (room.phase !== 'lobby') return { ok: false, code: 'BAD_PHASE' };
    if (count !== null) {
      const max = room.players.length - 1;
      if (!Number.isInteger(count) || count < 1 || count > max) {
        return { ok: false, code: 'BAD_COUNT' };
      }
    }

    room.hiderCount = count;
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

    const k = this.effectiveHiderCount(room);
    const hiders = this.pickHiders(room, k);
    room.hiderIds = new Set(hiders.map((p) => p.id));
    room.stickmen = new Map();
    room.confirmed = new Set();
    room.found = new Set();
    hiders.forEach((hider, i) => {
      room.stickmen.set(hider.id, this.defaultStickman(room.background!, i, k));
    });

    for (const p of room.players) {
      this.emit(p.id, 'game:role', { role: room.hiderIds.has(p.id) ? 'hider' : 'seeker' });
    }

    room.phase = 'hide';
    room.endsAt = Date.now() + HIDE_MS;
    room.hideTimer = this.scheduler.setTimeout(() => this.onHideExpire(room.code), HIDE_MS);

    for (const p of room.players) {
      if (room.hiderIds.has(p.id)) {
        this.emit(p.id, 'phase:hide', { background: room.background, endsAt: room.endsAt });
      } else {
        this.emit(p.id, 'phase:hideWait', { endsAt: room.endsAt });
      }
    }
    this.broadcastState(room);
    return { ok: true };
  }

  hideUpdate(playerId: string, stickman: StickmanState): void {
    const room = this.findRoomByPlayer(playerId);
    if (!room || room.phase !== 'hide' || !room.hiderIds.has(playerId)) return;
    // Invariant: background is always set by `start()`, before phase can reach 'hide'.
    room.stickmen.set(playerId, this.clampStickman(stickman, room.background!));
  }

  hideConfirm(playerId: string): Result {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND' };
    if (room.phase !== 'hide') return { ok: false, code: 'BAD_PHASE' };
    if (!room.hiderIds.has(playerId)) return { ok: false, code: 'NOT_HIDER' };
    if (room.confirmed.has(playerId)) return { ok: true }; // idempotent re-confirm

    room.confirmed.add(playerId);
    if ([...room.hiderIds].every((id) => room.confirmed.has(id))) {
      this.beginSeekPhase(room);
    }
    return { ok: true };
  }

  click(playerId: string, x: number, y: number): 'hit' | 'miss' | 'locked' | 'rejected' {
    const room = this.findRoomByPlayer(playerId);
    if (!room || room.phase !== 'seek' || room.hiderIds.has(playerId)) return 'rejected';

    const lockedUntil = room.lockouts.get(playerId) ?? 0;
    if (Date.now() < lockedUntil) return 'locked';

    // Only unfound hiders are still hide-and-seek targets; walk hiderIds in
    // insertion (selection) order so results are deterministic.
    for (const hiderId of room.hiderIds) {
      if (room.found.has(hiderId)) continue;
      // Invariant: every hiderId has a stickman set at `start()`, before phase can reach 'seek'.
      const stickman = room.stickmen.get(hiderId)!;
      if (!hitTest(stickman, x, y)) continue;

      room.found.add(hiderId);
      const nickname = room.players.find((p) => p.id === hiderId)!.nickname;
      const remaining = room.hiderIds.size - room.found.size;
      this.emit('all', 'seek:found', { playerId: hiderId, nickname, by: playerId, remaining });
      if (remaining === 0) {
        this.enterResult(room, 'seekers', 'all_found');
      }
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

  /** clamp(hiderCount ?? floor(n/2), 1, n-1) — applied only at start(); the stored value is never clamped. */
  private effectiveHiderCount(room: Room): number {
    const n = room.players.length;
    const desired = room.hiderCount ?? Math.floor(n / 2);
    return Math.min(Math.max(desired, 1), n - 1);
  }

  /** Deterministic partial Fisher-Yates over room.players: with rng()===0, returns players[0..k-1]. */
  private pickHiders(room: Room, k: number): Player[] {
    const pool = [...room.players];
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(this.rng() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, k);
  }

  private defaultStickman(background: Background, index: number, hiderCount: number): StickmanState {
    // top-center of the page (see shared/stickman.ts initialStickman) with an
    // unpainted white body — the hider paints with the brush. x is spread
    // across the page by hider index so multiple hiders don't all overlap.
    const stickman = initialStickman(background.width, background.height);
    return { ...stickman, x: Math.round((background.width * (index + 1)) / (hiderCount + 1)) };
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

    const stickmen: SeekStickman[] = [...room.hiderIds].map((id) => ({
      playerId: id,
      nickname: room.players.find((p) => p.id === id)!.nickname,
      stickman: room.stickmen.get(id)!,
    }));
    this.emit('all', 'phase:seek', {
      background: room.background!,
      stickmen,
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
    this.enterResult(room, 'hider', 'timeout');
  }

  private onResultExpire(code: string): void {
    const room = this.rooms.get(code);
    if (!room || room.phase !== 'result') return;
    this.resetToLobby(room);
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
    if (room.resultTimer !== null) {
      this.scheduler.clearTimeout(room.resultTimer);
      room.resultTimer = null;
    }
  }

  /** Back to the waiting room: wipes per-game state, keeps players/background/hiderCount. */
  private resetToLobby(room: Room): void {
    this.clearTimers(room);
    room.phase = 'lobby';
    room.hiderIds = new Set();
    room.stickmen = new Map();
    room.confirmed = new Set();
    room.found = new Set();
    room.endsAt = null;
    room.lockouts.clear();
    this.broadcastState(room);
  }

  private enterResult(room: Room, winner: Winner, reason: 'all_found' | 'timeout'): void {
    this.clearTimers(room);
    room.phase = 'result';
    room.endsAt = Date.now() + RESULT_MS;
    room.resultTimer = this.scheduler.setTimeout(() => this.onResultExpire(room.code), RESULT_MS);
    // Every id still in hiderIds was in the room when the round ended (leavers
    // are removed from hiderIds immediately), so the nickname lookup is safe.
    const stickmen = [...room.hiderIds].map((id) => ({
      playerId: id,
      nickname: room.players.find((p) => p.id === id)!.nickname,
      stickman: room.stickmen.get(id)!,
      found: room.found.has(id),
    }));
    this.emit('all', 'game:end', { winner, stickmen, reason });
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
      hiderCount: room.hiderCount,
    };
  }

  private broadcastState(room: Room): void {
    this.emit('all', 'room:state', this.toPublic(room));
  }
}
