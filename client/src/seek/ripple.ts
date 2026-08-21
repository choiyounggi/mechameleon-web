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

// D3: canvas 2D strokeStyle cannot resolve CSS var() -- these mirror the
// token values in tokens.css as fixed local constants (comment names the
// token so the two stay in sync if the palette changes).
const OUTER_RING_STROKE = 'oklch(65% 0.21 25'; // --color-paint-red
const OUTER_RING_WIDTH = 4;
const INNER_RING_STROKE = 'oklch(86% 0.15 95'; // --color-paint-yellow
const INNER_RING_WIDTH = 2;
const INNER_RING_SCALE = 0.6;

// D3: renders each active ripple as two concentric paint rings (thick red
// outer, thin yellow inner), sharing the ripple's own alpha/radius.
export function drawRipples(ctx: CanvasRenderingContext2D, ripples: ActiveRipple[]): void {
  for (const ripple of ripples) {
    ctx.beginPath();
    ctx.strokeStyle = `${OUTER_RING_STROKE} / ${ripple.alpha})`;
    ctx.lineWidth = OUTER_RING_WIDTH;
    ctx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = `${INNER_RING_STROKE} / ${ripple.alpha})`;
    ctx.lineWidth = INNER_RING_WIDTH;
    ctx.arc(ripple.x, ripple.y, ripple.radius * INNER_RING_SCALE, 0, Math.PI * 2);
    ctx.stroke();
  }
}
