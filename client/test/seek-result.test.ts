import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/net';
import type { RoomStatePublic } from 'shared/protocol';
import { getPhase } from '../src/phases';
import { initSeek } from '../src/seek';

// D8: fx is a visual side effect, not the result screen's own behavior --
// stub it so these tests assert result.ts's own decisions, not fx internals
// (already covered by fx.test.ts).
vi.mock('../src/fx', () => ({
  paintBurst: vi.fn(),
  screenShake: vi.fn(),
  attachPressFX: vi.fn(() => vi.fn()),
}));

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

function makeCtx(
  room: RoomStatePublic,
  playerId = 'p2', // p1 is the host in makeRoom; p2 a plain player
): { ctx: AppContext; handlers: Map<string, (p: unknown) => void> } {
  const { socket, handlers } = makeMockSocket();
  const ctx = {
    socket: socket as unknown as AppContext['socket'],
    state: { playerId, role: 'seeker' as const, room, hidePayload: null, abortNotice: null },
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

// r1/F2: the banner's letter-span markup renders a word gap as nbsp (U+00A0),
// not a plain space (U+0020) -- normalize so full-text assertions keep
// verifying the same words regardless of that internal encoding choice.
function normalizeNbsp(text: string | null): string {
  return (text ?? '').replace(/ /g, ' ');
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

    expect(normalizeNbsp(root.textContent)).toContain('찾은이님이 찾았다!');
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

    expect(normalizeNbsp(root.textContent)).toContain('끝까지 못 찾았다…');
    expect(root.querySelector('canvas')).toBeNull();

    getPhase('result').unmount();
  });

  it('shows the return message and initial countdown to everyone, with no restart buttons or waiting message (normal: countdown replaces host branch)', () => {
    const { ctx: hostCtx, handlers: hostHandlers } = makeCtx(makeRoom({ endsAt: NOW + 10_000 }), 'p1'); // host
    initSeek(hostCtx);
    hostHandlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const hostRoot = document.createElement('div');
    getPhase('result').mount(hostRoot, hostCtx);

    expect(hostRoot.textContent).toContain('대기실로 돌아갑니다');
    expect(hostRoot.querySelector('.mc-result-return-count')!.textContent).toBe('10');
    expect(Array.from(hostRoot.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['나가기']);
    expect(hostRoot.textContent).not.toContain('호스트가 다음 게임을 정하고 있어요');

    getPhase('result').unmount();

    const { ctx: guestCtx, handlers: guestHandlers } = makeCtx(makeRoom({ endsAt: NOW + 10_000 })); // p2, not host
    initSeek(guestCtx);
    guestHandlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const guestRoot = document.createElement('div');
    getPhase('result').mount(guestRoot, guestCtx);

    expect(guestRoot.textContent).toContain('대기실로 돌아갑니다');
    expect(guestRoot.querySelector('.mc-result-return-count')!.textContent).toBe('10');
    expect(Array.from(guestRoot.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['나가기']);

    getPhase('result').unmount();
  });

  it('counts down by one second per elapsed second, ticking on the 500ms interval (normal: tick decrease)', () => {
    const { ctx, handlers } = makeCtx(makeRoom({ endsAt: NOW + 10_000 }));
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const root = document.createElement('div');
    getPhase('result').mount(root, ctx);
    const countEl = root.querySelector('.mc-result-return-count')!;
    expect(countEl.textContent).toBe('10');

    vi.advanceTimersByTime(500);
    expect(countEl.textContent).toBe('10'); // 9.5s left still ceils to 10

    vi.advanceTimersByTime(500);
    expect(countEl.textContent).toBe('9'); // 1s elapsed total

    getPhase('result').unmount();
  });

  it('holds the countdown at 0 once endsAt has passed, never going negative (boundary: countdown floor)', () => {
    const { ctx, handlers } = makeCtx(makeRoom({ endsAt: NOW - 5_000 })); // already expired
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const root = document.createElement('div');
    getPhase('result').mount(root, ctx);

    expect(root.querySelector('.mc-result-return-count')!.textContent).toBe('0');

    vi.advanceTimersByTime(500);
    expect(root.querySelector('.mc-result-return-count')!.textContent).toBe('0');

    getPhase('result').unmount();
  });

  it('shows only the return message, with an empty countdown, when the room has no endsAt (boundary: no endsAt)', () => {
    const { ctx, handlers } = makeCtx(makeRoom({ endsAt: null }));
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const root = document.createElement('div');
    getPhase('result').mount(root, ctx);

    expect(root.textContent).toContain('대기실로 돌아갑니다');
    expect(root.querySelector('.mc-result-return-count')!.textContent).toBe('');

    vi.advanceTimersByTime(1_000);
    expect(root.querySelector('.mc-result-return-count')!.textContent).toBe('');

    getPhase('result').unmount();
  });

  it('stops the countdown interval on unmount, leaving the DOM unchanged by later ticks (boundary: cleanup, no leaked interval)', () => {
    const { ctx, handlers } = makeCtx(makeRoom({ endsAt: NOW + 10_000 }));
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const root = document.createElement('div');
    getPhase('result').mount(root, ctx);
    const countEl = root.querySelector('.mc-result-return-count')!;
    expect(countEl.textContent).toBe('10');

    getPhase('result').unmount();
    vi.advanceTimersByTime(5_000);

    expect(countEl.textContent).toBe('10');
  });

  it('falls back to "게임 종료" and still offers the leave button when game:end never arrived (error/defensive)', async () => {
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

    expect(normalizeNbsp(root.textContent)).toContain('게임 종료');
    const leaveBtnFresh = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '나가기');
    expect(leaveBtnFresh).not.toBeUndefined();

    freshGetPhase('result').unmount();
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

  it('renders the word gap in the banner as a non-breaking space so it survives inline-block collapse (normal: r1/F2)', () => {
    const { ctx, handlers } = makeCtx(makeRoom());
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'seekers', foundBy: 'p2', stickman: STICKMAN, reason: 'found' });
    const root = document.createElement('div');

    getPhase('result').mount(root, ctx);

    // '찾은이님이 찾았다!' has its one space at index 5 (0-based).
    const letterSpans = root.querySelectorAll('.mc-title-paint span');
    expect(letterSpans[5]!.textContent).toBe(' ');
    expect(letterSpans[5]!.textContent).not.toBe(' ');

    getPhase('result').unmount();
  });

  it('shows the found (red) banner variant when the seeker wins (normal: D5 banner variant)', () => {
    const { ctx, handlers } = makeCtx(makeRoom());
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'seekers', foundBy: 'p2', stickman: STICKMAN, reason: 'found' });
    const root = document.createElement('div');

    getPhase('result').mount(root, ctx);

    expect(root.querySelector('.mc-result-banner--found')).not.toBeNull();
    expect(root.querySelector('.mc-result-banner--survived')).toBeNull();

    getPhase('result').unmount();
  });

  it('shows the survived (green) banner variant when the hider survives the timeout (boundary: D5 banner variant)', () => {
    const { ctx, handlers } = makeCtx(makeRoom());
    initSeek(ctx);
    handlers.get('game:end')!({ winner: 'hider', stickman: null, reason: 'timeout' });
    const root = document.createElement('div');

    getPhase('result').mount(root, ctx);

    expect(root.querySelector('.mc-result-banner--survived')).not.toBeNull();
    expect(root.querySelector('.mc-result-banner--found')).toBeNull();

    getPhase('result').unmount();
  });
});
