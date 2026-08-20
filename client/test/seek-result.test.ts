import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/net';
import type { RoomStatePublic } from 'shared/protocol';
import { getPhase } from '../src/phases';
import { initSeek } from '../src/seek';

const NOW = 1_700_000_000_000;

const STICKMAN = {
  x: 200,
  y: 150,
  scale: 1,
  colors: {
    head: '#111111',
    torso: '#222222',
    leftArm: '#333333',
    rightArm: '#444444',
    leftLeg: '#555555',
    rightLeg: '#666666',
  },
};

function makeMockSocket() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const socket = {
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn(),
  };
  return { socket, handlers };
}

function makeCtx(room: RoomStatePublic): { ctx: AppContext; handlers: Map<string, (p: unknown) => void> } {
  const { socket, handlers } = makeMockSocket();
  const ctx = {
    socket: socket as unknown as AppContext['socket'],
    state: { playerId: 'p2', role: 'seeker' as const, room, hidePayload: null, abortNotice: null },
  };
  return { ctx, handlers };
}

function makeRoom(overrides: Partial<RoomStatePublic> = {}): RoomStatePublic {
  return {
    code: 'ABCDEF',
    phase: 'result',
    players: [
      { id: 'p1', nickname: '술래', isHost: true },
      { id: 'p2', nickname: '찾은이', isHost: false },
    ],
    background: { imageUrl: '/bg.png', width: 800, height: 600 },
    endsAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('result controller (D8): game:end -> rendered outcome', () => {
  it('registers the result phase controller (normal)', () => {
    const fallback = getPhase('lobby');
    const { ctx } = makeCtx(makeRoom());

    initSeek(ctx);

    expect(getPhase('result')).not.toBe(fallback);
  });

  it('names the finder and draws a highlight canvas when winner=seekers/found and stickman is known (normal)', () => {
    const { ctx, handlers } = makeCtx(makeRoom());
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'seekers', foundBy: 'p2', stickman: STICKMAN, reason: 'found' });
    const root = document.createElement('div');

    getPhase('result').mount(root, ctx);

    expect(root.textContent).toContain('찾은이님이 찾았다!');
    const canvas = root.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas!.width).toBe(800);

    getPhase('result').unmount();
  });

  it('shows the timeout text and draws no highlight canvas when stickman is null (boundary: no stickman)', () => {
    const { ctx, handlers } = makeCtx(makeRoom());
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const root = document.createElement('div');

    getPhase('result').mount(root, ctx);

    expect(root.textContent).toContain('끝까지 못 찾았다…');
    expect(root.querySelector('canvas')).toBeNull();

    getPhase('result').unmount();
  });

  it('offers both a restart and a leave button on the result screen (normal)', () => {
    const { ctx, handlers } = makeCtx(makeRoom());
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const root = document.createElement('div');

    getPhase('result').mount(root, ctx);

    const labels = Array.from(root.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toContain('다시 시작');
    expect(labels).toContain('나가기');

    getPhase('result').unmount();
  });

  it('falls back to "게임 종료" and still offers a restart button when game:end never arrived (error/defensive)', async () => {
    // `endPayload` is module-level state (D1), shared with every other test in
    // this file -- reset the module graph so this test does not depend on
    // running before another test's game:end fires (testing-data-and-isolation:
    // "no test depends on execution order or leftover state").
    vi.resetModules();
    const { getPhase: freshGetPhase } = await import('../src/phases');
    const { initSeek: freshInitSeek } = await import('../src/seek');
    const { ctx } = makeCtx(makeRoom());
    freshInitSeek(ctx); // no game:end fired for this ctx
    const root = document.createElement('div');

    freshGetPhase('result').mount(root, ctx);

    expect(root.textContent).toContain('게임 종료');
    const restartBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '다시 시작');
    expect(restartBtn).not.toBeUndefined();

    freshGetPhase('result').unmount();
  });

  it('"다시 시작" asks the server for a room restart (normal: restart wiring)', () => {
    const { ctx, handlers } = makeCtx(makeRoom());
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const root = document.createElement('div');
    getPhase('result').mount(root, ctx);
    const restartBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '다시 시작')!;

    restartBtn.click();

    const emit = ctx.socket.emit as ReturnType<typeof vi.fn>;
    expect(emit).toHaveBeenCalledWith('room:restart', expect.any(Function));

    getPhase('result').unmount();
  });

  it('"나가기" reloads the page, which disconnects and leaves the room (normal: leave wiring)', () => {
    const { ctx, handlers } = makeCtx(makeRoom());
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const root = document.createElement('div');
    getPhase('result').mount(root, ctx);
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
      configurable: true,
    });
    const leaveBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '나가기')!;

    leaveBtn.click();

    expect(reloadSpy).toHaveBeenCalledTimes(1);

    getPhase('result').unmount();
  });

  it('shows an error when the restart ack fails for a reason other than BAD_PHASE (error case)', async () => {
    const { ctx, handlers } = makeCtx(makeRoom());
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const root = document.createElement('div');
    getPhase('result').mount(root, ctx);
    const emit = ctx.socket.emit as ReturnType<typeof vi.fn>;
    emit.mockImplementation((event: string, ack: (res: unknown) => void) => {
      if (event === 'room:restart') ack({ ok: false, code: 'ROOM_NOT_FOUND' });
    });
    const restartBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '다시 시작')!;

    restartBtn.click();
    await Promise.resolve(); // flush the ack promise's .then microtask
    await Promise.resolve();
    expect(root.textContent).toContain('다시 시작할 수 없어요');

    getPhase('result').unmount();
  });

  it('unmount stops the highlight ring animation loop (boundary: cleanup, no leaked rAF)', () => {
    const { ctx, handlers } = makeCtx(makeRoom());
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'seekers', foundBy: 'p2', stickman: STICKMAN, reason: 'found' });
    const root = document.createElement('div');
    getPhase('result').mount(root, ctx);
    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame');

    getPhase('result').unmount();

    expect(cafSpy).toHaveBeenCalled();
    cafSpy.mockRestore();
  });
});
