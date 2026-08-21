import { MAX_BRUSH, MIN_BRUSH } from 'shared/protocol';
import { BRUSH_SIZE } from './paint';

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 5;
export const ZOOM_STEP = 1.25;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * ctrl+wheel step (D3): deltaY<0 (scroll up / pinch out) zooms in by
 * ZOOM_STEP, deltaY>0 zooms out, both clamped to [ZOOM_MIN, ZOOM_MAX].
 * deltaY===0 or a non-finite value (NaN/Infinity) leaves zoom unchanged.
 */
export function nextZoom(zoom: number, deltaY: number): number {
  if (deltaY === 0 || !Number.isFinite(deltaY)) return zoom;
  const raw = deltaY < 0 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP;
  return clamp(raw, ZOOM_MIN, ZOOM_MAX);
}

/**
 * Cursor-anchored scroll correction (D4): keeps the image point under the
 * cursor fixed on screen across a zoom change. Negative results clamp to 0.
 */
export function anchoredScroll(scroll: number, cursor: number, zoom: number, zoomNext: number): number {
  const next = ((scroll + cursor) / zoom) * zoomNext - cursor;
  return Math.max(0, next);
}

/** CSS-px pointer offset -> image-px coordinate at the given zoom (D6). */
export function toImage(offset: number, zoom: number): number {
  return offset / zoom;
}

/**
 * Stroke brush diameter that shrinks as zoom increases, for pixel-precise
 * painting (D7). Clamped to the server-accepted [MIN_BRUSH, MAX_BRUSH] range.
 */
export function brushSizeForZoom(zoom: number): number {
  return clamp(BRUSH_SIZE / zoom, MIN_BRUSH, MAX_BRUSH);
}
