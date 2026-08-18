// D4: miss-ripple lifecycle. Pure and rAF-free -- the seek controller drives
// its own requestAnimationFrame loop and calls active(now) each frame; this
// module only tracks ripple state and computes their current radius/alpha.

export interface Ripple {
  x: number;
  y: number;
  bornAt: number;
}

export interface ActiveRipple extends Ripple {
  radius: number;
  alpha: number;
}

export const RIPPLE_LIFETIME_MS = 600;
const RADIUS_START = 10;
const RADIUS_END = 36;
const ALPHA_START = 0.35;
const ALPHA_END = 0;

export interface RippleStore {
  add(x: number, y: number): void;
  active(now: number): ActiveRipple[];
}

export function createRippleStore(nowFn: () => number): RippleStore {
  let ripples: Ripple[] = [];

  return {
    add(x: number, y: number): void {
      ripples.push({ x, y, bornAt: nowFn() });
    },
    active(now: number): ActiveRipple[] {
      ripples = ripples.filter((r) => now - r.bornAt < RIPPLE_LIFETIME_MS);
      return ripples.map((r) => {
        const t = (now - r.bornAt) / RIPPLE_LIFETIME_MS;
        return {
          ...r,
          radius: RADIUS_START + (RADIUS_END - RADIUS_START) * t,
          alpha: ALPHA_START + (ALPHA_END - ALPHA_START) * t,
        };
      });
    },
  };
}
