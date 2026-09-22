import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomStatePublic } from 'shared/protocol';
import type { AppContext } from '../src/net';
import { clearIdentity, createRoom, joinRoom, rejoinRoom } from '../src/net';
import { bootstrap } from '../src/app';

function makeMockSocket() {
  // Multiple modules (bootstrap, lobby, seek) each register their own listener
  // for the same event, so the mock must keep them all, like socket.io does.
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const emit = vi.fn();
  const socket = {
    emit,
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    off: vi.fn(),
  };
  const fire = (event: string, payload: unknown): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };
  return { socket, fire, emit };
}

function makeCtx(): {
  ctx: AppContext;
  fire: (event: string, payload: unknown) => void;
  emit: ReturnType<typeof vi.fn>;
} {
  const { socket, fire, emit } = makeMockSocket();
  const ctx: AppContext = {
    socket: socket as unknown as AppContext['socket'],
    state: { playerId: null, role: null, room: null, hidePayload: null, abortNotice: null },
  };
  return { ctx, fire, emit };
}

function lobbyRoomState(): RoomStatePublic {
  return { code: 'ABCDEF', name: '테스트방', isPrivate: false, phase: 'lobby', players: [], background: null, endsAt: null };
}

describe('bootstrap (regression: first visitor saw a blank screen)', () => {
  it('mounts the lobby immediately, before any room:state arrives (normal case)', () => {
    const { ctx } = makeCtx();
    const root = document.createElement('div');

    bootstrap(root, ctx);

    // The lobby screen renders interactive controls; the pre-fix behavior left
    // root completely empty until a room:state event that never comes.
    expect(root.innerHTML).not.toBe('');
    expect(root.querySelector('input, button')).not.toBeNull();
  });

  it('does not remount on a repeated same-phase room:state (boundary case)', () => {
    const { ctx, fire } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);

    fire('room:state', lobbyRoomState());
    fire('room:state', lobbyRoomState());

    // A remount would duplicate the lobby's controls inside root.
    const nicknameInputs = root.querySelectorAll('input');
    expect(nicknameInputs.length).toBeGreaterThan(0);
    expect(nicknameInputs.length).toBeLessThanOrEqual(2); // nickname + code inputs, not doubled
    expect(ctx.state.room).not.toBeNull();
  });

  it('throws nothing and shows the fallback when the server pushes an unregistered phase mid-session (error case)', () => {
    const { ctx, fire } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);

    // 'result' before initSeek registration existed would have been the
    // fallback; with initSeek wired by bootstrap it must still mount something
    // without throwing even though no result payload was ever received.
    expect(() =>
      fire('room:state', { ...lobbyRoomState(), phase: 'result' }),
    ).not.toThrow();
    expect(root.innerHTML).not.toBe('');
  });
});

describe('game:aborted -> back to the waiting room with a notice', () => {
  it('shows the abort notice in the room screen after a hider_left abort (normal case)', () => {
    const { ctx, fire } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);
    ctx.state.playerId = 'p1';
    const players = [{ id: 'p1', nickname: '영기', isHost: true }];
    fire('room:state', { ...lobbyRoomState(), phase: 'seek', players });

    fire('game:aborted', { reason: 'hider_left' });
    fire('room:state', { ...lobbyRoomState(), players });

    expect(ctx.state.abortNotice).toBe('숨는 사람이 나가서 게임이 종료됐어요');
    expect(root.textContent).toContain('숨는 사람이 나가서 게임이 종료됐어요');
  });

  it('clears the notice and the stale role once the next game starts (boundary case)', () => {
    const { ctx, fire } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);
    fire('game:role', { role: 'hider' });
    fire('game:aborted', { reason: 'not_enough_players' });
    fire('room:state', lobbyRoomState());
    expect(ctx.state.role).toBeNull(); // lobby wipes the previous game's role
    expect(ctx.state.abortNotice).toBe('인원이 부족해서 게임이 종료됐어요');

    fire('room:state', { ...lobbyRoomState(), phase: 'hide' });
    expect(ctx.state.abortNotice).toBeNull();
  });

  it('maps an unknown reason to the generic not-enough-players text (error/defensive case)', () => {
    const { ctx, fire } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);

    fire('game:aborted', { reason: 'something_else' });

    expect(ctx.state.abortNotice).toBe('인원이 부족해서 게임이 종료됐어요');
  });

  it('maps a seeker_left abort to its own text (normal: seeker_left mapping)', () => {
    const { ctx, fire } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);

    fire('game:aborted', { reason: 'seeker_left' });

    expect(ctx.state.abortNotice).toBe('찾는 사람이 나가서 게임이 종료됐어요');
  });
});

describe('leaveToHome (D1/D2): app-internal leave, no page reload', () => {
  it('emits room:leave, resets every state field, and force-remounts the lobby home screen (normal)', async () => {
    const { ctx, fire, emit } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);
    ctx.state.playerId = 'p1';
    const players = [{ id: 'p1', nickname: '영기', isHost: true }];
    fire('room:state', { ...lobbyRoomState(), players });
    fire('game:role', { role: 'hider' });
    fire('phase:hide', {
      background: { imageUrl: '/x.png', width: 10, height: 10 },
      endsAt: Date.now() + 1000,
      stickman: { x: 0, y: 0, scale: 1, strokes: [] },
    });
    ctx.state.abortNotice = '숨는 사람이 나가서 게임이 종료됐어요';
    expect(root.textContent).toContain('영기'); // room screen is up before leaving

    const leavePromise = ctx.leaveToHome!();

    expect(emit).toHaveBeenCalledWith('room:leave', expect.any(Function));
    const ack = emit.mock.calls.find(([event]) => event === 'room:leave')![1] as (res: { ok: true }) => void;
    ack({ ok: true });
    await leavePromise;

    expect(ctx.state.playerId).toBeNull();
    expect(ctx.state.role).toBeNull();
    expect(ctx.state.room).toBeNull();
    expect(ctx.state.hidePayload).toBeNull();
    expect(ctx.state.abortNotice).toBeNull();
    // same phase ('lobby') both before and after leaving -- without the force
    // remount this would silently no-op and leave the stale room screen up.
    expect(root.textContent).toContain('방 만들기');
  });
});

describe('phase switch vs lobby listener (regression: lobby repainted over the hide screen)', () => {
  it('does not let the just-unmounted lobby repaint after a same-tick phase switch', () => {
    const { ctx, fire } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);
    expect(root.textContent).toContain('방 만들기'); // lobby is up

    // One room:state event both unmounts the lobby (router) and — because the
    // emitter snapshots listeners — still calls the lobby's own handler.
    fire('room:state', { ...lobbyRoomState(), phase: 'hide' });

    expect(root.textContent).not.toContain('방 만들기');
    expect(root.textContent).not.toContain('방 목록');
  });
});

describe('client identity persistence (t3-reconnect, D11/D12)', () => {
  beforeEach(() => {
    clearIdentity();
  });

  it('createRoom persists {playerId, roomCode} in sessionStorage on a successful ack (normal case)', async () => {
    const { ctx, emit } = makeCtx();
    const promise = createRoom(ctx, 'nick', { roomName: 'r', isPrivate: false });
    const ack = emit.mock.calls.find(([event]) => event === 'room:create')![2] as (res: unknown) => void;
    ack({ ok: true, code: 'ABCDEF', playerId: 'p1' });
    await promise;

    expect(JSON.parse(window.sessionStorage.getItem('mc-identity')!)).toEqual({ playerId: 'p1', roomCode: 'ABCDEF' });
  });

  it('joinRoom persists {playerId, roomCode} using the code it was called with (normal case)', async () => {
    const { ctx, emit } = makeCtx();
    const promise = joinRoom(ctx, 'GHIJKL', 'nick');
    const ack = emit.mock.calls.find(([event]) => event === 'room:join')![2] as (res: unknown) => void;
    ack({ ok: true, playerId: 'p2' }); // RoomJoinAck carries no code of its own
    await promise;

    expect(JSON.parse(window.sessionStorage.getItem('mc-identity')!)).toEqual({ playerId: 'p2', roomCode: 'GHIJKL' });
  });

  it('createRoom does not persist anything on a failed ack (error case)', async () => {
    const { ctx, emit } = makeCtx();
    const promise = createRoom(ctx, 'nick', { roomName: 'r', isPrivate: false });
    const ack = emit.mock.calls.find(([event]) => event === 'room:create')![2] as (res: unknown) => void;
    ack({ ok: false, code: 'BAD_PAYLOAD' });
    await promise;

    expect(window.sessionStorage.getItem('mc-identity')).toBeNull();
  });

  it('rejoinRoom returns null and emits nothing when no identity is saved (boundary case)', () => {
    const { ctx, emit } = makeCtx();
    expect(rejoinRoom(ctx)).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejoinRoom sets ctx.state.playerId optimistically before the ack resolves, then rolls back and clears storage on a failure ack (ordering + error case)', async () => {
    const { ctx, emit } = makeCtx();
    window.sessionStorage.setItem('mc-identity', JSON.stringify({ playerId: 'stale-id', roomCode: 'ZZZZZZ' }));

    const promise = rejoinRoom(ctx);
    expect(promise).not.toBeNull();
    // Set BEFORE the ack resolves -- proves the optimistic assignment, not
    // a side effect of the ack callback running.
    expect(ctx.state.playerId).toBe('stale-id');

    const ack = emit.mock.calls.find(([event]) => event === 'room:rejoin')![2] as (res: unknown) => void;
    ack({ ok: false, code: 'ROOM_NOT_FOUND' });
    await promise;

    expect(ctx.state.playerId).toBeNull();
    expect(window.sessionStorage.getItem('mc-identity')).toBeNull();
  });
});

describe('bootstrap connect -> rejoin wiring (t3-reconnect, D12/D13/D14/D15)', () => {
  beforeEach(() => {
    clearIdentity();
  });

  it('connect emits room:rejoin when an identity is saved (normal case)', () => {
    window.sessionStorage.setItem('mc-identity', JSON.stringify({ playerId: 'p1', roomCode: 'ABCDEF' }));
    const { ctx, fire, emit } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);

    fire('connect', undefined);

    expect(emit).toHaveBeenCalledWith('room:rejoin', { playerId: 'p1' }, expect.any(Function));
  });

  it('connect does nothing when no identity is saved (boundary case)', () => {
    const { ctx, fire, emit } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);

    fire('connect', undefined);

    expect(emit).not.toHaveBeenCalledWith('room:rejoin', expect.anything(), expect.anything());
  });

  it('a failed rejoin ack clears the identity and shows the notice on the home screen (normal case)', async () => {
    window.sessionStorage.setItem('mc-identity', JSON.stringify({ playerId: 'p1', roomCode: 'ABCDEF' }));
    const { ctx, fire, emit } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);

    fire('connect', undefined);
    const ack = emit.mock.calls.find(([event]) => event === 'room:rejoin')![2] as (res: unknown) => void;
    ack({ ok: false, code: 'ROOM_NOT_FOUND' });
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.state.abortNotice).toBe('이전 방에 다시 들어갈 수 없어요');
    expect(window.sessionStorage.getItem('mc-identity')).toBeNull();
    expect(root.textContent).toContain('이전 방에 다시 들어갈 수 없어요');
  });

  it('leaveToHome clears the saved identity (normal case)', async () => {
    window.sessionStorage.setItem('mc-identity', JSON.stringify({ playerId: 'p1', roomCode: 'ABCDEF' }));
    const { ctx, emit } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);

    const leavePromise = ctx.leaveToHome!();
    const ack = emit.mock.calls.find(([event]) => event === 'room:leave')![1] as (res: { ok: true }) => void;
    ack({ ok: true });
    await leavePromise;

    expect(window.sessionStorage.getItem('mc-identity')).toBeNull();
  });

  it('a throwing sessionStorage is tolerated by both the create/join persist path and bootstrap (boundary case)', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked (private mode)');
      },
    });
    try {
      const { ctx: createCtx, emit: createEmit } = makeCtx();
      const createPromise = createRoom(createCtx, 'nick', { roomName: 'r', isPrivate: false });
      const createAck = createEmit.mock.calls.find(([event]) => event === 'room:create')![2] as (res: unknown) => void;
      expect(() => createAck({ ok: true, code: 'ABCDEF', playerId: 'p1' })).not.toThrow();
      await expect(createPromise).resolves.toEqual({ ok: true, code: 'ABCDEF', playerId: 'p1' });

      const { ctx, fire, emit } = makeCtx();
      const root = document.createElement('div');
      expect(() => bootstrap(root, ctx)).not.toThrow();
      expect(() => fire('connect', undefined)).not.toThrow();
      expect(emit).not.toHaveBeenCalledWith('room:rejoin', expect.anything(), expect.anything());
      expect(root.innerHTML).not.toBe('');
    } finally {
      if (original) {
        Object.defineProperty(window, 'sessionStorage', original);
      } else {
        delete (window as unknown as { sessionStorage?: unknown }).sessionStorage;
      }
    }
  });
});

describe('rejoin snapshot order on a fresh (refreshed) client (t3-reconnect, D7)', () => {
  // The server's snapshotFor sends game:role + phase:* first and room:state
  // LAST, exactly like the live start() transition, because room:state is
  // what mounts the phase screen and the screen reads role/payload at mount.
  function hideRoomState(): RoomStatePublic {
    return {
      ...lobbyRoomState(),
      phase: 'hide',
      players: [
        { id: 'p1', nickname: '영기', isHost: true },
        { id: 'p2', nickname: '깜몬', isHost: false },
      ],
      background: { imageUrl: '/x.png', width: 1440, height: 2000 },
      endsAt: Date.now() + 60_000,
    };
  }
  const hidePayload = {
    background: { imageUrl: '/x.png', width: 1440, height: 2000 },
    endsAt: Date.now() + 60_000,
    stickman: { x: 100, y: 150, scale: 1, strokes: [] },
  };

  it('hider: game:role + phase:hide then room:state mounts the full hide editor, not the placeholder (normal case)', () => {
    const { ctx, fire } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);
    ctx.state.playerId = 'p1';

    fire('game:role', { role: 'hider' });
    fire('phase:hide', hidePayload);
    fire('room:state', hideRoomState());

    expect(root.textContent?.trim()).not.toBe('…');
    expect(root.textContent).toContain('숨어라!');
  });

  it('seeker: game:role + phase:hideWait then room:state mounts the wait screen (normal case)', () => {
    const { ctx, fire } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);
    ctx.state.playerId = 'p2';

    fire('game:role', { role: 'seeker' });
    fire('phase:hideWait', { endsAt: Date.now() + 60_000 });
    fire('room:state', hideRoomState());

    expect(root.querySelector('.mc-hide-wait')).not.toBeNull();
  });

  it('room:state arriving BEFORE the hide payload leaves only the placeholder -- why the server must send it last (boundary case)', () => {
    const { ctx, fire } = makeCtx();
    const root = document.createElement('div');
    bootstrap(root, ctx);
    ctx.state.playerId = 'p1';

    fire('room:state', hideRoomState());
    fire('game:role', { role: 'hider' });
    fire('phase:hide', hidePayload);

    expect(root.textContent?.trim()).toBe('…');
    expect(root.textContent).not.toContain('숨어라!');
  });
});
