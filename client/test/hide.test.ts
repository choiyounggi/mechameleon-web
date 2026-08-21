import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARROW_STEP,
  SCALE_STEP,
  SHIFT_ARROW_STEP,
  applyMove,
  clampPosition,
  clampScale,
  partForDigitKey,
} from '../src/hide/movement';
import { pickColor } from '../src/hide/eyedropper';
import { formatRemaining, remainingMs } from '../src/hide/timer';

// jsdom does not implement the Canvas 2D rendering context (getContext('2d')
// returns null), and D13 forbids pulling in node-canvas to fake it -- so the
// hide screen's pure logic is exercised directly here rather than through a
// mounted PhaseController, matching the T2/T3 pattern of testing extracted
// pure functions instead of DOM-driving a canvas.
const BOUNDS = { width: 1440, height: 900 };

describe('movement: arrow-key stepping (D8)', () => {
  it('ArrowRight moves x by ARROW_STEP=12 away from any edge (normal)', () => {
    const next = applyMove({ x: 100, y: 100 }, ARROW_STEP, 0, BOUNDS);
    expect(next).toEqual({ x: 112, y: 100 });
  });

  it('Shift+ArrowRight moves x by SHIFT step 48', () => {
    const next = applyMove({ x: 100, y: 100 }, SHIFT_ARROW_STEP, 0, BOUNDS);
    expect(next.x).toBe(148);
  });

  it('ArrowRight at x=width clamps and does not exceed the background width (boundary)', () => {
    const next = applyMove({ x: BOUNDS.width, y: 100 }, ARROW_STEP, 0, BOUNDS);
    expect(next.x).toBe(BOUNDS.width);
  });

  it('a negative move clamps at 0 rather than going negative (boundary)', () => {
    const next = clampPosition(-10, -10, BOUNDS);
    expect(next).toEqual({ x: 0, y: 0 });
  });
});

describe('movement: scale stepping (D8)', () => {
  it('"+" at the MAX_SCALE upper bound (2.0) has no effect (boundary)', () => {
    expect(clampScale(2.0 + SCALE_STEP)).toBe(2);
  });

  it('"-" at the MIN_SCALE lower bound (0.5) has no effect (boundary)', () => {
    expect(clampScale(0.5 - SCALE_STEP)).toBe(0.5);
  });

  it('a step within range is applied unchanged (normal)', () => {
    expect(clampScale(1 + SCALE_STEP)).toBeCloseTo(1.1);
  });
});

describe('eyedropper: pickColor (D9)', () => {
  it('converts the sampled pixel to a hex color (normal)', () => {
    const mockCtx = {
      getImageData: () => ({ data: new Uint8ClampedArray([0x12, 0x34, 0x56, 255]) }),
    };

    const outcome = pickColor(mockCtx as unknown as CanvasRenderingContext2D, 10, 20);

    expect(outcome).toEqual({ ok: true, hex: '#123456' });
  });

  it('rounds fractional pixel coordinates before sampling (boundary)', () => {
    let calledWith: unknown[] = [];
    const mockCtx = {
      getImageData: (...args: unknown[]) => {
        calledWith = args;
        return { data: new Uint8ClampedArray([0, 0, 0, 255]) };
      },
    };

    pickColor(mockCtx as unknown as CanvasRenderingContext2D, 10.6, 20.4);

    expect(calledWith).toEqual([11, 20, 1, 1]);
  });

  it('returns ok:false instead of throwing when getImageData raises a SecurityError (error)', () => {
    const mockCtx = {
      getImageData: () => {
        throw new DOMException('tainted canvas', 'SecurityError');
      },
    };

    const outcome = pickColor(mockCtx as unknown as CanvasRenderingContext2D, 10, 20);

    expect(outcome).toEqual({ ok: false });
  });
});

describe('timer: remaining time display (D11)', () => {
  it('formats a whole number of minutes and seconds as mm:ss (normal)', () => {
    expect(formatRemaining(65_000)).toBe('1:05');
  });

  it('floors negative remaining time to 0 once endsAt has passed (boundary)', () => {
    expect(remainingMs(1_000, 5_000)).toBe(0);
    expect(formatRemaining(remainingMs(1_000, 5_000))).toBe('0:00');
  });
});

describe('hide overlay click-through (regression: overlay swallowed eyedropper clicks)', () => {
  it('keeps the stickman overlay transparent to pointer events so bgCanvas gets the click', async () => {
    const { createHideController } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    const ctx = {
      socket: { emit: () => {}, on: () => {}, off: () => {} },
      state: {
        playerId: 'p1',
        role: 'hider',
        room: null,
        hidePayload: {
          background: { imageUrl: '/api/screenshots/x.png', width: 1440, height: 900 },
          endsAt: Date.now() + 60000,
          stickman: { x: 720, y: 100, scale: 1, strokes: [] },
        },
      },
    } as never;
    ctrl.mount(root, ctx);
    const canvases = root.querySelectorAll('canvas');
    expect(canvases).toHaveLength(2);
    // canvases[1] is the absolutely-positioned stickman overlay on top
    expect(canvases[1].style.pointerEvents).toBe('none');
    ctrl.unmount();
  });
});

describe('hide initial position (D1): starts from the server-assigned phase:hide payload.stickman', () => {
  it('moves from the payload position, not a locally generated pose, on the first edit (normal)', async () => {
    const { createHideController } = await import('../src/hide/index');
    const { ARROW_STEP } = await import('../src/hide/movement');
    const ctrl = createHideController();
    const root = document.createElement('div');
    const emit = vi.fn();
    const ctx = {
      socket: { emit, on: () => {}, off: () => {} },
      state: {
        playerId: 'p1',
        role: 'hider',
        room: null,
        hidePayload: {
          background: { imageUrl: '/api/screenshots/x.png', width: 1440, height: 900 },
          endsAt: Date.now() + 60000,
          stickman: { x: 555, y: 42, scale: 1.3, strokes: [] },
        },
      },
    } as never;

    // jsdom has no layout engine, so container.clientWidth/Height are always 0
    // and followScroll's out-of-view check always trips; jsdom also doesn't
    // implement Element.scrollTo at all, so it must be stubbed here.
    window.HTMLElement.prototype.scrollTo = vi.fn();

    ctrl.mount(root, ctx);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

    // ArrowRight moves x by ARROW_STEP from whatever position editing started
    // at -- landing at payload.stickman.x + ARROW_STEP proves the start was
    // the server-assigned position, not a fresh initialStickman() pose.
    expect(emit).toHaveBeenCalledWith('hide:update', {
      stickman: { x: 555 + ARROW_STEP, y: 42, scale: 1.3, strokes: [] },
    });

    ctrl.unmount();
  });
});

describe('brush paint helpers (paint.ts)', () => {
  const base = { x: 100, y: 200, scale: 2, strokes: [] };

  it('converts image coords to stickman-local coords honoring scale (normal)', async () => {
    const { imageToLocal } = await import('../src/hide/paint');
    expect(imageToLocal(base, 110, 180)).toEqual({ x: 5, y: -10 });
  });

  it('drops drag samples closer than the dedupe distance (boundary)', async () => {
    const { startStroke, appendPoint } = await import('../src/hide/paint');
    const stroke = startStroke('#aabb00', { x: 100, y: 200 }, base);
    expect(appendPoint(stroke, base, 101, 200)).toBe(false); // 0.5 local px — too close
    expect(appendPoint(stroke, base, 110, 200)).toBe(true); // 5 local px — recorded
    expect(stroke.points).toHaveLength(2);
  });

  it('rejects a stroke that would blow the shared paint budget (error)', async () => {
    const { finishStroke } = await import('../src/hide/paint');
    const fat = {
      color: '#aabb00',
      size: 10,
      points: Array.from({ length: 500 }, (_, i) => ({ x: i, y: i })),
    };
    const full = {
      ...base,
      strokes: Array.from({ length: 8 }, () => ({ ...fat, points: [...fat.points] })),
    };
    const { state, accepted } = finishStroke(full, { ...fat, points: [...fat.points] });
    expect(accepted).toBe(false); // 4000 already used
    expect(state).toBe(full); // untouched on rejection
  });
});

function mountEditCtx(endsAt: number) {
  return {
    socket: { emit: () => {}, on: () => {}, off: () => {} },
    state: {
      playerId: 'p1',
      role: 'hider',
      room: null,
      hidePayload: {
        background: { imageUrl: '/api/screenshots/x.png', width: 1440, height: 900 },
        endsAt,
        stickman: { x: 720, y: 100, scale: 1, strokes: [] },
      },
    },
  } as never;
}

describe('hide HUD: timer urgency toggle (D2, D8)', () => {
  const NOW = Date.parse('2026-01-01T00:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not mark is-urgent while remaining is above the 10s threshold (normal)', async () => {
    const { createHideController } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    ctrl.mount(root, mountEditCtx(NOW + 10_001));
    expect(root.querySelector('.mc-hud-timer')?.classList.contains('is-urgent')).toBe(false);
    ctrl.unmount();
  });

  it('marks is-urgent exactly at the 10000ms remaining boundary (boundary)', async () => {
    const { createHideController } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    ctrl.mount(root, mountEditCtx(NOW + 10_000));
    expect(root.querySelector('.mc-hud-timer')?.classList.contains('is-urgent')).toBe(true);
    ctrl.unmount();
  });

  it('stays is-urgent just under the boundary at 9999ms remaining (boundary)', async () => {
    const { createHideController } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    ctrl.mount(root, mountEditCtx(NOW + 9_999));
    expect(root.querySelector('.mc-hud-timer')?.classList.contains('is-urgent')).toBe(true);
    ctrl.unmount();
  });
});

describe('hide HUD: keycap control strip (D3, D8)', () => {
  it('renders each control as an individual .mc-keycap chip, including all 4 arrow keys (normal)', async () => {
    const { createHideController } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    ctrl.mount(root, mountEditCtx(Date.now() + 60_000));
    const caps = Array.from(root.querySelectorAll('.mc-keycap')).map((el) => el.textContent);
    expect(caps).toEqual(['드래그', '⌥', '◀', '▶', '▲', '▼', '+/-']);
    ctrl.unmount();
  });

  it('renders the confirm button as a themed keycap button (normal)', async () => {
    const { createHideController } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    ctrl.mount(root, mountEditCtx(Date.now() + 60_000));
    const confirmBtn = root.querySelector('button');
    expect(confirmBtn?.className).toBe('mc-btn mc-btn--green');
    ctrl.unmount();
  });

  it('detaches the confirm button press FX on unmount so a later press no longer squashes it (error)', async () => {
    const { createHideController } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    ctrl.mount(root, mountEditCtx(Date.now() + 60_000));
    const confirmBtn = root.querySelector('button') as HTMLButtonElement;
    ctrl.unmount();
    confirmBtn.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(confirmBtn.classList.contains('mc-squash')).toBe(false);
  });
});

describe('hide HUD: error pill visibility (F1, r1 review)', () => {
  it('keeps the error pill hidden when there is no error to show (normal)', async () => {
    const { createHideController } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    ctrl.mount(root, mountEditCtx(Date.now() + 60_000));
    const errorEl = root.querySelector('.mc-error') as HTMLElement;
    expect(errorEl.hidden).toBe(true);
    ctrl.unmount();
  });

  it('reveals the error pill once a read failure sets a message (error)', async () => {
    const { createHideController } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    ctrl.mount(root, mountEditCtx(Date.now() + 60_000));
    const bgCanvas = root.querySelectorAll('canvas')[0] as HTMLCanvasElement;
    const errorEl = root.querySelector('.mc-error') as HTMLElement;
    // jsdom has no Canvas 2D support, so bgCtx is null here — this exercises
    // the same "이미지를 읽을 수 없어요" guard as a real tainted-canvas read failure.
    bgCanvas.dispatchEvent(new MouseEvent('mousedown', { altKey: true, bubbles: true }));
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe('이미지를 읽을 수 없어요');
    ctrl.unmount();
  });
});

describe('hide wait screen: themed seeker hold (D6, D8)', () => {
  function mountWaitCtx() {
    return {
      socket: { emit: () => {}, on: () => {}, off: () => {} },
      state: { playerId: 'p1', role: 'seeker', room: { endsAt: Date.now() + 60_000 }, hidePayload: null },
    } as never;
  }

  it('renders the themed wait screen with no inline gray styling for the seeker role (normal)', async () => {
    const { createHideController, WAIT_MESSAGES } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    ctrl.mount(root, mountWaitCtx());
    const wrap = root.querySelector('.mc-hide-wait') as HTMLElement;
    expect(wrap).not.toBeNull();
    expect(wrap.style.background).toBe('');
    expect(wrap.textContent).toContain(WAIT_MESSAGES[0]);
    ctrl.unmount();
  });

  it('shows a spinner and opens with copy about the hider hiding, not server wait (normal)', async () => {
    const { createHideController, WAIT_MESSAGES } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    ctrl.mount(root, mountWaitCtx());
    expect(root.querySelector('.mc-wait-spinner')).not.toBeNull();
    expect(WAIT_MESSAGES[0]).toContain('숨는 중');
    expect(root.querySelector('.mc-wait-msg')?.textContent).toBe(WAIT_MESSAGES[0]);
    ctrl.unmount();
  });

  describe('message rotation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rotates to the next message after WAIT_MESSAGE_ROTATE_MS (normal)', async () => {
      const { createHideController, WAIT_MESSAGES, WAIT_MESSAGE_ROTATE_MS } = await import('../src/hide/index');
      const ctrl = createHideController();
      const root = document.createElement('div');
      ctrl.mount(root, mountWaitCtx());
      vi.advanceTimersByTime(WAIT_MESSAGE_ROTATE_MS);
      expect(root.querySelector('.mc-wait-msg')?.textContent).toBe(WAIT_MESSAGES[1]);
      ctrl.unmount();
    });

    it('wraps back to the first message after a full cycle (boundary)', async () => {
      const { createHideController, WAIT_MESSAGES, WAIT_MESSAGE_ROTATE_MS } = await import('../src/hide/index');
      const ctrl = createHideController();
      const root = document.createElement('div');
      ctrl.mount(root, mountWaitCtx());
      vi.advanceTimersByTime(WAIT_MESSAGE_ROTATE_MS * WAIT_MESSAGES.length);
      expect(root.querySelector('.mc-wait-msg')?.textContent).toBe(WAIT_MESSAGES[0]);
      ctrl.unmount();
    });

    it('stops rotating after unmount so no stale interval keeps mutating the DOM (error)', async () => {
      const { createHideController, WAIT_MESSAGES, WAIT_MESSAGE_ROTATE_MS } = await import('../src/hide/index');
      const ctrl = createHideController();
      const root = document.createElement('div');
      ctrl.mount(root, mountWaitCtx());
      ctrl.unmount();
      vi.advanceTimersByTime(WAIT_MESSAGE_ROTATE_MS * 3);
      expect(root.querySelector('.mc-wait-msg')?.textContent).toBe(WAIT_MESSAGES[0]);
    });
  });
});

function mountEditCtxWithLeave(endsAt: number, leaveToHome: () => Promise<void>) {
  return {
    socket: { emit: () => {}, on: () => {}, off: () => {} },
    state: {
      playerId: 'p1',
      role: 'hider',
      room: null,
      hidePayload: {
        background: { imageUrl: '/api/screenshots/x.png', width: 1440, height: 900 },
        endsAt,
        stickman: { x: 720, y: 100, scale: 1, strokes: [] },
      },
    },
    leaveToHome,
  } as never;
}

function mountWaitCtxWithLeave(leaveToHome: () => Promise<void>) {
  return {
    socket: { emit: () => {}, on: () => {}, off: () => {} },
    state: { playerId: 'p1', role: 'seeker', room: { endsAt: Date.now() + 60_000 }, hidePayload: null },
    leaveToHome,
  } as never;
}

describe('hide leave button (D4/D5): two-step confirm before leaving', () => {
  it('edit screen: first click arms the confirm label + red class, second click leaves (normal)', async () => {
    const { createHideController } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    const leaveToHome = vi.fn().mockResolvedValue(undefined);
    ctrl.mount(root, mountEditCtxWithLeave(Date.now() + 60_000, leaveToHome));
    const leaveBtn = Array.from(root.querySelectorAll('button')).find(
      (b) => b.textContent === '나가기',
    ) as HTMLButtonElement;
    expect(leaveBtn).not.toBeUndefined();
    expect(leaveBtn.className).toBe('mc-btn mc-btn--ghost');

    leaveBtn.click();
    expect(leaveBtn.textContent).toBe('한 번 더 누르면 나가요');
    expect(leaveBtn.className).toBe('mc-btn mc-btn--red');
    expect(leaveToHome).not.toHaveBeenCalled();

    leaveBtn.click();
    expect(leaveToHome).toHaveBeenCalledTimes(1);

    ctrl.unmount();
  });

  it('wait screen: the same two-step confirm leaves after the second click (normal)', async () => {
    const { createHideController } = await import('../src/hide/index');
    const ctrl = createHideController();
    const root = document.createElement('div');
    const leaveToHome = vi.fn().mockResolvedValue(undefined);
    ctrl.mount(root, mountWaitCtxWithLeave(leaveToHome));
    const leaveBtn = Array.from(root.querySelectorAll('button')).find(
      (b) => b.textContent === '나가기',
    ) as HTMLButtonElement;
    expect(leaveBtn).not.toBeUndefined();

    leaveBtn.click();
    expect(leaveBtn.textContent).toBe('한 번 더 누르면 나가요');
    leaveBtn.click();

    expect(leaveToHome).toHaveBeenCalledTimes(1);

    ctrl.unmount();
  });

  describe('confirm timeout (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reverts the label/class and does not leave once 3000ms pass without a second click (boundary)', async () => {
      const { createHideController } = await import('../src/hide/index');
      const ctrl = createHideController();
      const root = document.createElement('div');
      const leaveToHome = vi.fn().mockResolvedValue(undefined);
      ctrl.mount(root, mountEditCtxWithLeave(Date.now() + 60_000, leaveToHome));
      const leaveBtn = Array.from(root.querySelectorAll('button')).find(
        (b) => b.textContent === '나가기',
      ) as HTMLButtonElement;

      leaveBtn.click();
      vi.advanceTimersByTime(3000);

      expect(leaveBtn.textContent).toBe('나가기');
      expect(leaveBtn.className).toBe('mc-btn mc-btn--ghost');
      expect(leaveToHome).not.toHaveBeenCalled();

      ctrl.unmount();
    });

    it('clears the pending revert timer on unmount so no timer is left running (boundary: no leaked timer)', async () => {
      const { createHideController } = await import('../src/hide/index');
      const ctrl = createHideController();
      const root = document.createElement('div');
      const leaveToHome = vi.fn().mockResolvedValue(undefined);
      ctrl.mount(root, mountEditCtxWithLeave(Date.now() + 60_000, leaveToHome));
      const leaveBtn = Array.from(root.querySelectorAll('button')).find(
        (b) => b.textContent === '나가기',
      ) as HTMLButtonElement;
      leaveBtn.click(); // arms the 3000ms revert timer
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      ctrl.unmount();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
