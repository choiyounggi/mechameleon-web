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

function makeCtx(): { ctx: AppContext; fire: (event: string, payload: unknown) => void } {
  const { socket, fire } = makeMockSocket();
  const ctx: AppContext = {
    socket: socket as unknown as AppContext['socket'],
    state: { playerId: null, role: null, room: null, hidePayload: null },
  };
  return { ctx, fire };
}

function lobbyRoomState(): RoomStatePublic {
  return { code: 'ABCDEF', phase: 'lobby', players: [], background: null, endsAt: null };
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
