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
    colors: {
      head: '#111111',
      torso: '#222222',
      leftArm: '#333333',
      rightArm: '#444444',
      leftLeg: '#555555',
      rightLeg: '#666666',
    },
    ...overrides,
  };
}

// Records ops in call order; style properties are read at the moment
// stroke()/fill() run, matching how a real CanvasRenderingContext2D applies
// state at draw time (not a node-canvas dependency -- D13).
function createMockCtx() {
  const ops: string[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt' as CanvasLineCap,
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
      ops.push(`stroke:${ctx.strokeStyle}:${ctx.lineWidth}:${ctx.lineCap}`);
    },
    arc(x: number, y: number, r: number) {
      ops.push(`arc:${x}:${y}:${r}`);
    },
    fill() {
      ops.push(`fill:${ctx.fillStyle}`);
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

describe('drawStickman', () => {
  it('strokes torso with lineWidth = r*2*scale and fills the head as an arc at scale 1 (normal)', () => {
    const { ctx, ops } = createMockCtx();
    const s = makeStickman({ x: 100, y: 200, scale: 1 });

    drawStickman(ctx, s);

    expect(ops).toContain(`stroke:${s.colors.torso}:12:round`);
    expect(ops).toContain(`arc:100:${200 - 106}:14`);
    expect(ops).toContain(`fill:${s.colors.head}`);
  });

  // drawStickman is a total function over SEGMENTS (D10) -- there is no
  // "invalid part" input to reject, so in place of an error-path test this
  // verifies the one behavioral contract that would silently break if a part
  // were skipped, reordered, or double-drawn: back-to-front draw order.
  it('draws legs, then arms, then torso, then head, in that back-to-front order (no error path; order-contract check)', () => {
    const { ctx, ops } = createMockCtx();
    const s = makeStickman();

    drawStickman(ctx, s);

    const strokeOrder = ops
      .filter((op) => op.startsWith('stroke:'))
      .map((op) => op.split(':')[1]);
    const fillOps = ops.filter((op) => op.startsWith('fill:'));

    expect(strokeOrder).toEqual([
      s.colors.leftLeg,
      s.colors.rightLeg,
      s.colors.leftArm,
      s.colors.rightArm,
      s.colors.torso,
    ]);
    // head is filled, and only after every limb + torso stroke has happened
    expect(fillOps).toEqual([`fill:${s.colors.head}`]);
    expect(ops.indexOf(fillOps[0])).toBeGreaterThan(ops.lastIndexOf(`stroke:${s.colors.torso}:12:round`));
  });
});
