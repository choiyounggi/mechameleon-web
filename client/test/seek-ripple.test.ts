import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRippleStore, drawRipples, resolveRippleStrokes, RIPPLE_LIFETIME_MS } from '../src/seek/ripple';

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

describe('resolveRippleStrokes / drawRipples token resolution (D4): ring colours resolve through tokens, once, not per frame', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--color-paint-red');
    document.documentElement.style.removeProperty('--color-paint-yellow');
  });

  it('resolveRippleStrokes returns the open (unclosed) paint-red/paint-yellow token values when both are set (normal)', () => {
    document.documentElement.style.setProperty('--color-paint-red', 'oklch(50% 0.2 30)');
    document.documentElement.style.setProperty('--color-paint-yellow', 'oklch(60% 0.2 90)');

    const strokes = resolveRippleStrokes();

    expect(strokes.outer).toBe('oklch(50% 0.2 30');
    expect(strokes.inner).toBe('oklch(60% 0.2 90');
  });

  it('resolveRippleStrokes falls back to the exact current open oklch literals when the tokens are unset (boundary: property never set)', () => {
    const strokes = resolveRippleStrokes();

    expect(strokes.outer).toBe('oklch(65% 0.21 25');
    expect(strokes.inner).toBe('oklch(86% 0.15 95');
  });

  it('resolveRippleStrokes falls back to the fixed literal when --color-paint-red is a self-referential cycle (error: malformed token value)', () => {
    document.documentElement.style.setProperty('--color-paint-red', 'var(--color-paint-red)');

    const strokes = resolveRippleStrokes();

    expect(strokes.outer).toBe('oklch(65% 0.21 25');
  });

  it('drawRipples resolves the ring tokens once and reuses the cached value on a later frame even after the CSS property changes (normal: memoization, never per frame)', async () => {
    document.documentElement.style.setProperty('--color-paint-red', 'oklch(50% 0.2 30)');
    document.documentElement.style.setProperty('--color-paint-yellow', 'oklch(60% 0.2 90)');
    vi.resetModules();
    const mod = await import('../src/seek/ripple');
    const ctx = makeFakeCtx();
    // record the strokeStyle in effect at each stroke() so both rings are checked
    const styles: string[] = [];
    (ctx.stroke as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      styles.push(ctx.strokeStyle as string);
    });
    const ripples = [{ x: 5, y: 6, bornAt: 0, radius: 20, alpha: 0.2 }];

    mod.drawRipples(ctx, ripples);
    expect(ctx.strokeStyle).toBe('oklch(60% 0.2 90 / 0.2)');
    expect(styles).toEqual(['oklch(50% 0.2 30 / 0.2)', 'oklch(60% 0.2 90 / 0.2)']);

    document.documentElement.style.setProperty('--color-paint-red', 'oklch(10% 0.2 200)');
    document.documentElement.style.setProperty('--color-paint-yellow', 'oklch(10% 0.2 200)');
    mod.drawRipples(ctx, ripples);
    expect(ctx.strokeStyle).toBe('oklch(60% 0.2 90 / 0.2)');
    expect(styles.slice(2)).toEqual(['oklch(50% 0.2 30 / 0.2)', 'oklch(60% 0.2 90 / 0.2)']);
  });
});
