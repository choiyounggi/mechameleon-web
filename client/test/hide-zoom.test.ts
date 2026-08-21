import { describe, expect, it } from 'vitest';
import { anchoredScroll, brushSizeForZoom, nextZoom, toImage, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../src/hide/zoom';

// jsdom has no Canvas 2D context (D13), so the zoom logic lives in this pure
// module and is exercised directly here, matching the movement.ts/paint.ts
// pattern already used by hide.test.ts.

describe('zoom: nextZoom (D3)', () => {
  it('deltaY<0 (scroll up) zooms in by ZOOM_STEP (normal)', () => {
    expect(nextZoom(1, -100)).toBeCloseTo(ZOOM_STEP);
  });

  it('deltaY>0 (scroll down) zooms out by ZOOM_STEP (normal)', () => {
    expect(nextZoom(2, 100)).toBeCloseTo(2 / ZOOM_STEP);
  });

  it('clamps at the ZOOM_MAX=5 upper bound (boundary)', () => {
    expect(nextZoom(4.5, -100)).toBe(ZOOM_MAX);
  });

  it('clamps at the ZOOM_MIN=1 lower bound and does not go below it (boundary)', () => {
    expect(nextZoom(ZOOM_MIN, 100)).toBe(ZOOM_MIN);
  });

  it('deltaY of 0, NaN, or Infinity leaves zoom unchanged (error input)', () => {
    expect(nextZoom(2, 0)).toBe(2);
    expect(nextZoom(2, NaN)).toBe(2);
    expect(nextZoom(2, Infinity)).toBe(2);
    expect(nextZoom(2, -Infinity)).toBe(2);
  });
});

describe('zoom: anchoredScroll (D4)', () => {
  it('leaves scroll unchanged when zoom does not change (identity)', () => {
    expect(anchoredScroll(100, 50, 2, 2)).toBe(100);
  });

  it('keeps the image point under the cursor fixed across a zoom change (normal, anchor invariant)', () => {
    const scroll = 100;
    const cursor = 50;
    const zoom = 2;
    const zoomNext = 4;
    const next = anchoredScroll(scroll, cursor, zoom, zoomNext);
    expect(next).toBe(250);
    // the anchor invariant itself: the image point under the cursor is the same
    // before and after the zoom change.
    expect((next + cursor) / zoomNext).toBeCloseTo((scroll + cursor) / zoom);
  });

  it('clamps a negative result to 0 (boundary)', () => {
    expect(anchoredScroll(0, 100, 5, 1)).toBe(0);
  });
});

describe('zoom: toImage (D6)', () => {
  it('zoom=1 is the identity conversion (boundary)', () => {
    expect(toImage(500, ZOOM_MIN)).toBe(500);
  });

  it('converts a CSS-px offset to image px at zoom=5 (normal)', () => {
    expect(toImage(500, 5)).toBe(100);
  });
});

describe('zoom: brushSizeForZoom (D7)', () => {
  it('zoom=1 gives the full BRUSH_SIZE=10 (normal)', () => {
    expect(brushSizeForZoom(1)).toBe(10);
  });

  it('zoom=5 reaches the MIN_BRUSH=2 floor exactly (boundary)', () => {
    expect(brushSizeForZoom(5)).toBe(2);
  });

  it('tolerates an out-of-domain zoom below 1 without throwing (error input)', () => {
    expect(brushSizeForZoom(0.5)).toBe(20);
  });

  it('clamps to MIN_BRUSH=2 for an out-of-domain zoom above 5 (boundary)', () => {
    expect(brushSizeForZoom(10)).toBe(2);
  });
});
