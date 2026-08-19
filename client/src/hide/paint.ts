import {
  MAX_STROKES,
  MAX_STROKE_POINTS,
  MAX_TOTAL_POINTS,
  type StickmanState,
  type StickmanStroke,
} from 'shared/protocol';

/** Brush diameter in stickman-local px. */
export const BRUSH_SIZE = 10;
/** Held-down key that turns a click into an eyedropper pick (그림판 관례). */
export const EYEDROPPER_KEY = 'Alt';
/** Ignore drag samples closer than this (local px) — keeps point counts sane. */
const MIN_POINT_DISTANCE = 1.5;

export const DEFAULT_BRUSH_COLOR = '#8a8a8a';

/** Image-pixel coords -> stickman-local coords (feet-center origin, unscaled). */
export function imageToLocal(s: StickmanState, imageX: number, imageY: number): { x: number; y: number } {
  return { x: (imageX - s.x) / s.scale, y: (imageY - s.y) / s.scale };
}

export function totalPoints(strokes: StickmanStroke[]): number {
  return strokes.reduce((n, st) => n + st.points.length, 0);
}

export function startStroke(color: string, imagePoint: { x: number; y: number }, s: StickmanState): StickmanStroke {
  return { color, size: BRUSH_SIZE, points: [imageToLocal(s, imagePoint.x, imagePoint.y)] };
}

/**
 * Append a drag sample to the in-progress stroke. Returns true when the point
 * was recorded (far enough from the last one, and under the per-stroke cap).
 */
export function appendPoint(stroke: StickmanStroke, s: StickmanState, imageX: number, imageY: number): boolean {
  if (stroke.points.length >= MAX_STROKE_POINTS) return false;
  const pt = imageToLocal(s, imageX, imageY);
  const last = stroke.points[stroke.points.length - 1];
  if (Math.hypot(pt.x - last.x, pt.y - last.y) < MIN_POINT_DISTANCE) return false;
  stroke.points.push(pt);
  return true;
}

/**
 * Commit a finished stroke into the stickman. Returns the next state and
 * whether the stroke fit inside the shared paint budget (MAX_STROKES /
 * MAX_TOTAL_POINTS) — a rejected stroke leaves the state untouched.
 */
export function finishStroke(
  s: StickmanState,
  stroke: StickmanStroke,
): { state: StickmanState; accepted: boolean } {
  if (stroke.points.length === 0) return { state: s, accepted: false };
  if (s.strokes.length >= MAX_STROKES) return { state: s, accepted: false };
  if (totalPoints(s.strokes) + stroke.points.length > MAX_TOTAL_POINTS) {
    return { state: s, accepted: false };
  }
  return { state: { ...s, strokes: [...s.strokes, stroke] }, accepted: true };
}
