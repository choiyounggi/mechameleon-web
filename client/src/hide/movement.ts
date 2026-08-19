import { MAX_SCALE, MIN_SCALE } from 'shared/protocol';

export const ARROW_STEP = 4;
export const SHIFT_ARROW_STEP = 16;
export const SCALE_STEP = 0.1;

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  width: number;
  height: number;
}

// Mirrors the server's authoritative clamp (D8) so the local view never shows
// a position the server would reject.
export function clampPosition(x: number, y: number, bounds: Bounds): Point {
  return {
    x: Math.min(Math.max(x, 0), bounds.width),
    y: Math.min(Math.max(y, 0), bounds.height),
  };
}

export function clampScale(scale: number): number {
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
}

export function applyMove(pos: Point, dx: number, dy: number, bounds: Bounds): Point {
  return clampPosition(pos.x + dx, pos.y + dy, bounds);
}
