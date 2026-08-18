import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/net';
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
  const emit = vi.fn();
  const socket = {
    emit,
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn(),
  };
  return { socket, handlers, emit };
}

function makeCtx(role: 'hider' | 'seeker'): {
  ctx: AppContext;
  handlers: Map<string, (p: unknown) => void>;
  emit: ReturnType<typeof vi.fn>;
} {
  const { socket, handlers, emit } = makeMockSocket();
  const ctx = {
    socket: socket as unknown as AppContext['socket'],
    state: {
      playerId: 'me',
      role,
      room: { code: 'ABCDEF', phase: 'seek', players: [], background: null, endsAt: null },
      hidePayload: null,
    },
  };
  return { ctx, handlers, emit };
}

// Fixed system clock (D7 concern): mount()'s timer tick and endsAt are both
// read from Date.now() -- a real clock between "compute endsAt" and "mount
// renders it" is exactly the non-determinism testing-async-async-testing warns
// against, so every test here pins the clock instead of relying on real elapsed ms.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('initSeek (D1): early listeners resolve the phase:seek-before-room:state race', () => {
  it('registers the seek phase controller so it no longer falls back to the "…" screen (normal)', () => {
    // 'lobby' is never registered in this isolated test module -- capture the
    // shared fallback singleton via it, before initSeek runs.
    const fallback = getPhase('lobby');
    const { ctx } = makeCtx('seeker');

    initSeek(ctx);

    expect(getPhase('seek')).not.toBe(fallback);
  });

  it('stores a phase:seek payload that arrives before mount, and mount renders it at 1:1 pixel size (normal)', () => {
    const { ctx, handlers } = makeCtx('seeker');
    initSeek(ctx);
    const endsAt = NOW + 65_000;

    // simulate the server event arriving before room:state ever triggers a mount
    handlers.get('phase:seek')!({
      background: { imageUrl: '/bg.png', width: 800, height: 600 },
      stickman: STICKMAN,
      endsAt,
    });

    const root = document.createElement('div');
    getPhase('seek').mount(root, ctx);

    const canvases = root.querySelectorAll('canvas');
    expect(canvases.length).toBe(2);
    expect(canvases[0].width).toBe(800);
    expect(canvases[0].height).toBe(600);
    expect(canvases[1].width).toBe(800);
    expect(root.textContent).toContain('1:05');

    getPhase('seek').unmount();
  });
});

describe('seek controller: click handling by role (D3, D6)', () => {
  it('a seeker click on the overlay canvas sends seek:click with the click coordinates (normal)', () => {
    const { ctx, handlers, emit } = makeCtx('seeker');
    initSeek(ctx);
    handlers.get('phase:seek')!({
      background: { imageUrl: '/bg.png', width: 800, height: 600 },
      stickman: STICKMAN,
      endsAt: NOW + 60_000,
    });
    const root = document.createElement('div');
    getPhase('seek').mount(root, ctx);
    const overlay = root.querySelectorAll('canvas')[1];

    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(emit).toHaveBeenCalledWith(
      'seek:click',
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      expect.any(Function),
    );

    getPhase('seek').unmount();
  });

  it('blocks a second click while the first is still in-flight (boundary: single in-flight)', () => {
    const { ctx, handlers, emit } = makeCtx('seeker');
    initSeek(ctx);
    handlers.get('phase:seek')!({
      background: { imageUrl: '/bg.png', width: 800, height: 600 },
      stickman: STICKMAN,
      endsAt: NOW + 60_000,
    });
    const root = document.createElement('div');
    getPhase('seek').mount(root, ctx);
    const overlay = root.querySelectorAll('canvas')[1];

    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(emit).toHaveBeenCalledTimes(1);

    getPhase('seek').unmount();
  });

  it('a miss ack starts a 3s self-lockout that blocks further clicks and renders the countdown badge, until it expires (normal: ack -> lockedUntil integration)', async () => {
    const { ctx, handlers, emit } = makeCtx('seeker');
    initSeek(ctx);
    handlers.get('phase:seek')!({
      background: { imageUrl: '/bg.png', width: 800, height: 600 },
      stickman: STICKMAN,
      endsAt: NOW + 60_000,
    });
    const root = document.createElement('div');
    getPhase('seek').mount(root, ctx);
    const overlay = root.querySelectorAll('canvas')[1];
    const container = overlay.parentElement as HTMLElement;

    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(emit).toHaveBeenCalledTimes(1);
    const ack = emit.mock.calls[0]![2] as (res: unknown) => void;
    ack({ ok: true, result: 'miss' });
    await Promise.resolve();
    await Promise.resolve();

    expect(root.textContent).toContain('3…');
    expect(container.style.cursor).toBe('wait');

    // still within the 3s lock -> the local canClick gate blocks the send entirely
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(emit).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 3_000);
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(emit).toHaveBeenCalledTimes(2);

    getPhase('seek').unmount();
  });

  it('a hider never gets a click listener on the overlay canvas -- clicking it sends nothing (error/spectator)', () => {
    const { ctx, handlers, emit } = makeCtx('hider');
    initSeek(ctx);
    handlers.get('phase:seek')!({
      background: { imageUrl: '/bg.png', width: 800, height: 600 },
      stickman: STICKMAN,
      endsAt: NOW + 60_000,
    });
    const root = document.createElement('div');
    getPhase('seek').mount(root, ctx);
    const overlay = root.querySelectorAll('canvas')[1];

    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(emit).not.toHaveBeenCalledWith('seek:click', expect.anything(), expect.anything());
    expect(root.textContent).toContain('관전');

    getPhase('seek').unmount();
  });

  it('unmount removes the click listener, so a late click after leaving the phase sends nothing (boundary: cleanup)', () => {
    const { ctx, handlers, emit } = makeCtx('seeker');
    initSeek(ctx);
    handlers.get('phase:seek')!({
      background: { imageUrl: '/bg.png', width: 800, height: 600 },
      stickman: STICKMAN,
      endsAt: NOW + 60_000,
    });
    const root = document.createElement('div');
    getPhase('seek').mount(root, ctx);
    const overlay = root.querySelectorAll('canvas')[1];

    getPhase('seek').unmount();
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(emit).not.toHaveBeenCalled();
  });
});

describe('seek controller: seek:miss ripple wiring (D4)', () => {
  it('schedules an animation frame in response to a seek:miss broadcast, for everyone including the clicker (normal)', () => {
    const { ctx, handlers } = makeCtx('hider');
    initSeek(ctx);
    handlers.get('phase:seek')!({
      background: { imageUrl: '/bg.png', width: 800, height: 600 },
      stickman: STICKMAN,
      endsAt: NOW + 60_000,
    });
    const root = document.createElement('div');
    getPhase('seek').mount(root, ctx);
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');

    handlers.get('seek:miss')!({ x: 10, y: 20, by: 'someone-else' });

    expect(rafSpy).toHaveBeenCalled();

    rafSpy.mockRestore();
    getPhase('seek').unmount();
  });
});
