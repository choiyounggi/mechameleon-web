import { describe, expect, it } from 'vitest';
import { INITIAL_FEET_Y, hitTest, initialStickman } from '../src/stickman';
import { zNickname, zStickmanState } from '../src/protocol';

const baseColors = {
  head: '#ff0000',
  torso: '#ff0000',
  leftArm: '#ff0000',
  rightArm: '#ff0000',
  leftLeg: '#ff0000',
  rightLeg: '#ff0000',
};

function stickman(overrides: Partial<{ x: number; y: number; scale: number }> = {}) {
  return {
    x: 100,
    y: 200,
    scale: 1,
    colors: baseColors,
    ...overrides,
  };
}

describe('hitTest', () => {
  it('hits the torso center (normal case)', () => {
    // torso segment runs (0,-92)->(0,-48) relative to feet; midpoint y = -70
    const s = stickman();
    expect(hitTest(s, 100, 130)).toBe(true);
  });

  it('misses a point far away from the stickman (normal case)', () => {
    const s = stickman();
    expect(hitTest(s, 100_000, 100_000)).toBe(false);
  });

  it('hits exactly at the torso capsule radius + 4px margin boundary at scale 1', () => {
    // torso r=6, margin +4 => effective radius 10 at scale 1.
    // y=145 (relative -55) sits below the arm capsules' reach and above the
    // leg capsules' start, so only the torso segment is in range here.
    const s = stickman({ scale: 1 });
    expect(hitTest(s, 110, 145)).toBe(true);
  });

  it('misses 1px beyond the torso capsule radius + margin boundary at scale 1', () => {
    const s = stickman({ scale: 1 });
    expect(hitTest(s, 111, 145)).toBe(false);
  });

  it('scales the effective radius with stickman.scale (scale 2 boundary)', () => {
    // torso r=6 * scale 2 + margin 4 => effective radius 16.
    // y=94 (relative -106, scaled) is likewise isolated from the scaled arm/leg capsules.
    const s = stickman({ scale: 2 });
    expect(hitTest(s, 116, 94)).toBe(true);
    expect(hitTest(s, 117, 94)).toBe(false);
  });
});

describe('zNickname (boundary/error coverage for zod schemas)', () => {
  it('rejects an empty nickname (error case)', () => {
    expect(zNickname.safeParse('').success).toBe(false);
  });

  it('accepts a 1..12 char nickname (normal case)', () => {
    expect(zNickname.safeParse('a').success).toBe(true);
    expect(zNickname.safeParse('123456789012').success).toBe(true);
  });

  it('rejects a nickname longer than 12 chars (boundary case)', () => {
    expect(zNickname.safeParse('1234567890123').success).toBe(false);
  });
});

describe('zStickmanState strokes (brush model)', () => {
  const base = { x: 10, y: 20, scale: 1 };

  it('accepts a valid stroke list (normal case)', () => {
    const parsed = zStickmanState.safeParse({
      ...base,
      strokes: [{ color: '#aabb00', size: 10, points: [{ x: 0, y: -70 }, { x: 4, y: -66 }] }],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an invalid (non-hex) stroke color (error case)', () => {
    const parsed = zStickmanState.safeParse({
      ...base,
      strokes: [{ color: 'red', size: 10, points: [{ x: 0, y: 0 }] }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects when the shared point budget is exceeded (boundary case)', () => {
    const many = Array.from({ length: 601 }, (_, i) => ({ x: i, y: i }));
    const perStroke = zStickmanState.safeParse({ ...base, strokes: [{ color: '#aabb00', size: 10, points: many }] });
    expect(perStroke.success).toBe(false); // MAX_STROKE_POINTS = 600

    const strokes = Array.from({ length: 8 }, () => ({
      color: '#aabb00',
      size: 10,
      points: Array.from({ length: 501 }, (_, i) => ({ x: i, y: i })),
    }));
    const total = zStickmanState.safeParse({ ...base, strokes });
    expect(total.success).toBe(false); // 8 * 501 > MAX_TOTAL_POINTS = 4000
  });
});

describe('initialStickman — top-center start pose', () => {
  it('starts horizontally centered with feet 150px from the top (normal)', () => {
    const s = initialStickman(1440, 2000);
    expect(s).toEqual({ x: 720, y: INITIAL_FEET_Y, scale: 1, strokes: [] });
  });

  it('rounds an odd width to the nearest center pixel (boundary: rounding)', () => {
    expect(initialStickman(1441, 2000).x).toBe(721);
  });

  it('clamps the feet to the background height when the page is shorter than the start offset (error/degenerate background)', () => {
    expect(initialStickman(1440, 100).y).toBe(100);
  });
});
