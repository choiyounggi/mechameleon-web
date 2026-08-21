// drawStickman/segmentEndpoints are total functions over SEGMENTS x StickmanState
// (D10) -- there is no invalid-input error path to test. In its place, the
// draw-order test below (legs -> arms -> torso -> head) is the substitute
// error-bucket case: it is the one contract that would silently regress
// (a skipped/reordered/double-drawn part) without throwing.
import { describe, expect, it } from 'vitest';
import type { StickmanState } from 'shared/protocol';
import { drawStickman, segmentEndpoints } from '../src/render/stickman-renderer';

function makeStickman(overrides: Partial<StickmanState> = {}): StickmanState {
  return {
    x: 100,
    y: 200,
    scale: 1,
    strokes: [],
    ...overrides,
  };
}

// Records ops in call order; style properties are read at the moment
// stroke()/fill() run, matching how a real CanvasRenderingContext2D applies
// state at draw time (not a node-canvas dependency -- D13).
function createMockCtx() {
  const ops: string[] = [];
  const alphaStack: number[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt' as CanvasLineCap,
    globalAlpha: 1,
    canvas: { width: 1440, height: 900 },
    save() {
      alphaStack.push(ctx.globalAlpha);
      ops.push('save');
    },
    restore() {
      ctx.globalAlpha = alphaStack.pop() ?? ctx.globalAlpha;
      ops.push('restore');
    },
    drawImage() {
      ops.push('drawImage');
    },
    beginPath() {
      ops.push('beginPath');
    },
    moveTo(x: number, y: number) {
      ops.push(`moveTo:${x}:${y}`);
    },
    lineTo(x: number, y: number) {
      ops.push(`lineTo:${x}:${y}`);
    },
    stroke() {
      ops.push(`stroke:${ctx.strokeStyle}:${ctx.lineWidth}:${ctx.lineCap}:${ctx.globalAlpha}`);
    },
    arc(x: number, y: number, r: number) {
      ops.push(`arc:${x}:${y}:${r}`);
    },
    fill() {
      ops.push(`fill:${ctx.fillStyle}:${ctx.globalAlpha}`);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

describe('segmentEndpoints', () => {
  it('places the head at (x, y-106) and gives torso a 6px radius at scale 1 (normal)', () => {
    const s = makeStickman({ x: 100, y: 200, scale: 1 });
    const endpoints = segmentEndpoints(s);
    const head = endpoints.find((e) => e.part === 'head')!;
    const torso = endpoints.find((e) => e.part === 'torso')!;

    expect(head.ax).toBe(100);
    expect(head.ay).toBe(200 - 106);
    expect(head.r).toBe(14);
    expect(torso.r).toBe(6);
  });

  it('doubles every endpoint coordinate and radius at scale 2 (boundary: upper scale)', () => {
    const s1 = makeStickman({ x: 100, y: 200, scale: 1 });
    const s2 = makeStickman({ x: 100, y: 200, scale: 2 });
    const e1 = segmentEndpoints(s1);
    const e2 = segmentEndpoints(s2);

    for (let i = 0; i < e1.length; i++) {
      expect(e2[i].r).toBeCloseTo(e1[i].r * 2);
      expect(e2[i].ay - s2.y).toBeCloseTo((e1[i].ay - s1.y) * 2);
      expect(e2[i].by - s2.y).toBeCloseTo((e1[i].by - s1.y) * 2);
    }
  });

  it('halves every endpoint radius at the MIN_SCALE lower bound of 0.5 (boundary: lower scale)', () => {
    const s = makeStickman({ x: 0, y: 0, scale: 0.5 });
    const endpoints = segmentEndpoints(s);
    const head = endpoints.find((e) => e.part === 'head')!;
    const torso = endpoints.find((e) => e.part === 'torso')!;

    expect(head.r).toBeCloseTo(7);
    expect(torso.r).toBeCloseTo(3);
    expect(Number.isFinite(head.ax) && Number.isFinite(head.ay)).toBe(true);
  });
});

describe('drawStickman (white base body + outline; strokes clipped via scratch canvas)', () => {
  it('paints the outline pass first, then the white base body (normal)', () => {
    const { ctx, ops } = createMockCtx();
    drawStickman(ctx, makeStickman());
    const fills = ops.filter((op) => op.startsWith('fill:') || op.startsWith('stroke:'));
    // first half of the passes carries the ink outline color, second half white
    expect(fills[0]).toContain('#3b332b');
    expect(fills[fills.length - 1]).toContain('#ffffff');
  });

  it('draws body parts legs -> arms -> torso -> head within each pass (order-contract check)', () => {
    const { ctx, ops } = createMockCtx();
    drawStickman(ctx, makeStickman());
    // head is the only arc; it must come after every line stroke of its pass
    const firstPass = ops.slice(0, ops.findIndex((op, i) => i > 0 && op.startsWith('arc')) + 1);
    const arcIndex = firstPass.findIndex((op) => op.startsWith('arc'));
    const lineIndexes = firstPass
      .map((op, i) => (op.startsWith('moveTo') ? i : -1))
      .filter((i) => i >= 0);
    expect(arcIndex).toBeGreaterThan(Math.max(...lineIndexes));
  });

  it('omits the ink outline entirely in seek style so the camouflage can work (normal: seek)', () => {
    const { ctx, ops } = createMockCtx();
    drawStickman(ctx, makeStickman(), 'seek');
    const draws = ops.filter((op) => op.startsWith('fill:') || op.startsWith('stroke:'));
    expect(draws.length).toBeGreaterThan(0);
    expect(draws.some((op) => op.includes('#3b332b'))).toBe(false);
    expect(draws.every((op) => op.includes('#ffffff'))).toBe(true);
  });

  it('keeps the ink outline in the default edit style (boundary: default unchanged)', () => {
    const { ctx, ops } = createMockCtx();
    drawStickman(ctx, makeStickman());
    expect(ops.some((op) => op.includes('#3b332b'))).toBe(true);
  });

  it('skips the paint layer gracefully when no 2D scratch context exists (jsdom boundary)', () => {
    const { ctx, ops } = createMockCtx();
    const painted = makeStickman({
      strokes: [{ color: '#ff0000', size: 10, points: [{ x: 0, y: -70 }, { x: 5, y: -60 }] }],
    });
    // jsdom: document.createElement('canvas').getContext -> null, so the
    // renderer must fall back to the unpainted body without throwing.
    expect(() => drawStickman(ctx, painted)).not.toThrow();
    expect(ops.some((op) => op === 'drawImage')).toBe(false);
  });
});

describe('drawStickman outline alpha (D1): seek-style fade-in via the 4th arg', () => {
  it('paints the outline pass at the given alpha, wrapped in its own save/restore (normal: partial alpha)', () => {
    const { ctx, ops } = createMockCtx();
    drawStickman(ctx, makeStickman(), 'seek', 0.5);
    const outlineFills = ops.filter((op) => op.startsWith('fill:#3b332b'));
    expect(outlineFills.length).toBeGreaterThan(0);
    expect(outlineFills.every((op) => op.endsWith(':0.5'))).toBe(true);
    // nested save/restore around the alpha-scoped outline pass, on top of the
    // outer save/restore that wraps the whole body draw.
    expect(ops.filter((op) => op === 'save').length).toBeGreaterThanOrEqual(2);
    expect(ops.filter((op) => op === 'restore').length).toBeGreaterThanOrEqual(2);
    // the white base body afterward stays fully opaque regardless of the outline alpha.
    const bodyFills = ops.filter((op) => op.startsWith('fill:#ffffff'));
    expect(bodyFills.every((op) => op.endsWith(':1'))).toBe(true);
  });

  it('omits the outline pass entirely at alpha 0, matching the no-alpha seek default (boundary: zero alpha)', () => {
    const { ctx, ops } = createMockCtx();
    drawStickman(ctx, makeStickman(), 'seek', 0);
    const draws = ops.filter((op) => op.startsWith('fill:') || op.startsWith('stroke:'));
    expect(draws.some((op) => op.includes('#3b332b'))).toBe(false);
  });

  it('clamps an out-of-range alpha into [0,1] instead of over/under-painting (error: out-of-bounds input)', () => {
    const { ctx: ctxOver, ops: opsOver } = createMockCtx();
    drawStickman(ctxOver, makeStickman(), 'seek', 1.5);
    expect(opsOver.filter((op) => op.startsWith('fill:#3b332b')).every((op) => op.endsWith(':1'))).toBe(true);

    const { ctx: ctxUnder, ops: opsUnder } = createMockCtx();
    drawStickman(ctxUnder, makeStickman(), 'seek', -1);
    expect(opsUnder.some((op) => op.includes('#3b332b'))).toBe(false);
  });

  it('ignores the alpha argument entirely in edit style, which is always fully opaque (boundary: edit unaffected)', () => {
    const { ctx, ops } = createMockCtx();
    drawStickman(ctx, makeStickman(), 'edit', 0);
    expect(ops.some((op) => op.startsWith('fill:#3b332b:1'))).toBe(true);
  });
});
