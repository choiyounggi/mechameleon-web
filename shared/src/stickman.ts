import type { PartKey, StickmanState } from './protocol';

export interface Segment {
  part: PartKey;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  r: number;
}

// Standard standing pose, height 120px at scale 1. Origin (0,0) = feet center,
// +y is down so the body extends upward with negative y. The head is
// represented as a degenerate (zero-length) segment, i.e. a circle.
export const SEGMENTS: Segment[] = [
  { part: 'head', x1: 0, y1: -106, x2: 0, y2: -106, r: 14 },
  { part: 'torso', x1: 0, y1: -92, x2: 0, y2: -48, r: 6 },
  { part: 'leftArm', x1: 0, y1: -84, x2: -22, y2: -58, r: 6 },
  { part: 'rightArm', x1: 0, y1: -84, x2: 22, y2: -58, r: 6 },
  { part: 'leftLeg', x1: 0, y1: -48, x2: -16, y2: 0, r: 6 },
  { part: 'rightLeg', x1: 0, y1: -48, x2: 16, y2: 0, r: 6 },
];

// Initial pose: top of the page, horizontally centered. Feet sit 150px down so
// the whole 120px body (plus head margin) is visible without scrolling — the
// hider starts where the page opens, not buried mid-scroll.
export const INITIAL_FEET_Y = 150;

export function initialStickman(width: number, height: number): StickmanState {
  return {
    x: Math.round(width / 2),
    y: Math.min(INITIAL_FEET_Y, Math.round(height)),
    scale: 1,
    strokes: [],
  };
}

// Judging margin added to every segment's radius (D7).
const HIT_MARGIN = 4;

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lengthSq));
  const closestX = ax + t * abx;
  const closestY = ay + t * aby;
  return Math.hypot(px - closestX, py - closestY);
}

/** Server-authoritative hit test: point (x, y) vs the stickman's capsules, in image pixel coordinates. */
export function hitTest(s: StickmanState, x: number, y: number): boolean {
  return SEGMENTS.some((seg) => {
    const ax = s.x + seg.x1 * s.scale;
    const ay = s.y + seg.y1 * s.scale;
    const bx = s.x + seg.x2 * s.scale;
    const by = s.y + seg.y2 * s.scale;
    const effectiveR = seg.r * s.scale + HIT_MARGIN;
    return distanceToSegment(x, y, ax, ay, bx, by) <= effectiveR;
  });
}
