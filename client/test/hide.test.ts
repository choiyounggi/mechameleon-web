import { describe, expect, it } from 'vitest';
import {
  ARROW_STEP,
  SCALE_STEP,
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
  it('ArrowRight moves x by ARROW_STEP=4 away from any edge (normal)', () => {
    const next = applyMove({ x: 100, y: 100 }, ARROW_STEP, 0, BOUNDS);
    expect(next).toEqual({ x: 104, y: 100 });
  });

  it('Shift+ArrowRight moves x by SHIFT step 16', () => {
    const next = applyMove({ x: 100, y: 100 }, 16, 0, BOUNDS);
    expect(next.x).toBe(116);
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
