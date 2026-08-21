import { describe, expect, it, vi } from 'vitest';
import { createRippleStore, drawRipples, RIPPLE_LIFETIME_MS } from '../src/seek/ripple';

function makeFakeCtx() {
  return {
    beginPath: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    strokeStyle: '',
    lineWidth: 0,
  } as unknown as CanvasRenderingContext2D;
}

describe('createRippleStore (D4): miss-ripple lifecycle, pure and rAF-free', () => {
  it('reports a freshly added ripple at its start radius/alpha (normal)', () => {
    const store = createRippleStore(() => 1_000);
    store.add(50, 60);

    const active = store.active(1_000);

    expect(active).toEqual([{ x: 50, y: 60, bornAt: 1_000, radius: 10, alpha: 0.35 }]);
  });

  it('reports no ripples when none were added (error/empty)', () => {
    const store = createRippleStore(() => 1_000);
    expect(store.active(1_000)).toEqual([]);
  });

  it('keeps a ripple 1ms before its 600ms lifetime with radius/alpha still short of the end values (boundary: just before expiry)', () => {
    const store = createRippleStore(() => 0);
    store.add(0, 0);

    const active = store.active(RIPPLE_LIFETIME_MS - 1);

    expect(active).toHaveLength(1);
    expect(active[0].radius).toBeLessThan(36);
    expect(active[0].radius).toBeGreaterThan(10);
    expect(active[0].alpha).toBeGreaterThan(0);
    expect(active[0].alpha).toBeLessThan(0.35);
  });

  it('drops a ripple exactly at its 600ms lifetime (boundary: expiry excluded)', () => {
    const store = createRippleStore(() => 0);
    store.add(0, 0);

    expect(store.active(RIPPLE_LIFETIME_MS)).toEqual([]);
  });
});

describe('drawRipples (D3): two-layer paint ring render helper', () => {
  it('strokes an outer and inner ring per ripple, both at the ripple radius/alpha (normal)', () => {
    const ctx = makeFakeCtx();
    const ripples = [{ x: 5, y: 6, bornAt: 0, radius: 20, alpha: 0.2 }];

    drawRipples(ctx, ripples);

    expect(ctx.arc).toHaveBeenCalledTimes(2);
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
    // outer ring: full ripple radius; inner ring: a smaller concentric radius.
    expect(ctx.arc).toHaveBeenNthCalledWith(1, 5, 6, 20, 0, Math.PI * 2);
    const [, , innerRadius] = (ctx.arc as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(innerRadius).toBeLessThan(20);
    expect(innerRadius).toBeGreaterThan(0);
  });

  it('draws nothing when there are no active ripples (error/empty)', () => {
    const ctx = makeFakeCtx();

    drawRipples(ctx, []);

    expect(ctx.stroke).not.toHaveBeenCalled();
  });
});
