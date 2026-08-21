import { describe, expect, it, vi } from 'vitest';
import type { RoomStatePublic } from 'shared/protocol';
import type { AppContext } from '../src/net';
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
