// D4: miss-ripple lifecycle. Pure and rAF-free -- the seek controller drives
// its own requestAnimationFrame loop and calls active(now) each frame; this
// module only tracks ripple state and computes their current radius/alpha.

import { canvasTokenOpen, closeAlpha } from '../render/canvas-tokens';

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

// D4: canvas 2D strokeStyle cannot resolve CSS var(), so the ring open
// colours resolve through canvasTokenOpen instead of hand-copied literals --
// exported so tests can inject a Document, mirroring seek/result.ts's
// resolveRingStrokes; resolved once (memoized below) and reused, closed per
// ripple per frame with closeAlpha (open-once / close-many).
export function resolveRippleStrokes(doc?: Document | null): { outer: string; inner: string } {
  return {
    outer: canvasTokenOpen('--color-paint-red', 'oklch(65% 0.21 25', doc),
    inner: canvasTokenOpen('--color-paint-yellow', 'oklch(86% 0.15 95', doc),
  };
}

let ringStrokeCache: { outer: string; inner: string } | null = null;
function getRingStrokes(): { outer: string; inner: string } {
  if (ringStrokeCache === null) ringStrokeCache = resolveRippleStrokes();
  return ringStrokeCache;
}

const OUTER_RING_WIDTH = 4;
const INNER_RING_WIDTH = 2;
const INNER_RING_SCALE = 0.6;

// D3: renders each active ripple as two concentric paint rings (thick red
// outer, thin yellow inner), sharing the ripple's own alpha/radius.
export function drawRipples(ctx: CanvasRenderingContext2D, ripples: ActiveRipple[]): void {
  const strokes = getRingStrokes();
  for (const ripple of ripples) {
    ctx.beginPath();
    ctx.strokeStyle = closeAlpha(strokes.outer, ripple.alpha);
    ctx.lineWidth = OUTER_RING_WIDTH;
    ctx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = closeAlpha(strokes.inner, ripple.alpha);
    ctx.lineWidth = INNER_RING_WIDTH;
    ctx.arc(ripple.x, ripple.y, ripple.radius * INNER_RING_SCALE, 0, Math.PI * 2);
    ctx.stroke();
  }
}
