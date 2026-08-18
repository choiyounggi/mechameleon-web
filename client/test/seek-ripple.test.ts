import { describe, expect, it } from 'vitest';
import { createRippleStore, RIPPLE_LIFETIME_MS } from '../src/seek/ripple';

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
