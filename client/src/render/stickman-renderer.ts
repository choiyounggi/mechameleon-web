import type { PartKey, StickmanState } from 'shared/protocol';
import { SEGMENTS } from 'shared/stickman';

export interface SegmentEndpoint {
  part: PartKey;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
}

// Pure geometry (D10): SEGMENTS placed at the stickman's (x, y), scaled. Reused
// by drawStickman and by client-seek / tests that need the same coordinates
// without a canvas.
export function segmentEndpoints(s: StickmanState): SegmentEndpoint[] {
  return SEGMENTS.map((seg) => ({
    part: seg.part,
    ax: s.x + seg.x1 * s.scale,
    ay: s.y + seg.y1 * s.scale,
    bx: s.x + seg.x2 * s.scale,
    by: s.y + seg.y2 * s.scale,
    r: seg.r * s.scale,
  }));
}

// Back-to-front draw order so limbs tuck behind the torso and the head on top.
const DRAW_ORDER: PartKey[] = ['leftLeg', 'rightLeg', 'leftArm', 'rightArm', 'torso', 'head'];

const BODY_BASE = '#ffffff';
const BODY_OUTLINE = '#3b332b';
const OUTLINE_WIDTH = 2.5;

/** Paints the body silhouette (all capsules + head) onto ctx with the current styles. */
function traceBody(
  ctx: CanvasRenderingContext2D,
  s: StickmanState,
  mode: 'fill' | 'outline',
  radiusPad = 0,
): void {
  const byPart = new Map(segmentEndpoints(s).map((e) => [e.part, e]));
  for (const part of DRAW_ORDER) {
    const seg = byPart.get(part);
    if (!seg) continue;
    if (part === 'head') {
      ctx.beginPath();
      if (mode === 'fill') {
        ctx.arc(seg.ax, seg.ay, seg.r + radiusPad, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.arc(seg.ax, seg.ay, seg.r, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.lineCap = 'round';
      if (mode === 'fill') {
        ctx.lineWidth = (seg.r + radiusPad) * 2;
        ctx.moveTo(seg.ax, seg.ay);
        ctx.lineTo(seg.bx, seg.by);
        ctx.stroke();
      } else {
        ctx.lineWidth = seg.r * 2;
        ctx.moveTo(seg.ax, seg.ay);
        ctx.lineTo(seg.bx, seg.by);
        ctx.stroke();
      }
    }
  }
}

// Offscreen scratch canvases for clipping paint strokes to the body
// silhouette: one for the paint, one for the full-silhouette alpha mask.
// The mask MUST be applied as a single destination-in drawImage — applying
// destination-in per body part chains intersections and erases everything.
// Cached module-wide; resized on demand. jsdom has no 2D context — every use
// is guarded so tests can mount without painting.
function makeScratch(): { canvas: HTMLCanvasElement | null; ctx: (w: number, h: number) => CanvasRenderingContext2D | null } {
  let canvas: HTMLCanvasElement | null = null;
  return {
    get canvas() {
      return canvas;
    },
    ctx(width: number, height: number) {
      if (!canvas) canvas = document.createElement('canvas');
      if (canvas.width < width || canvas.height < height) {
        canvas.width = Math.max(width, canvas.width);
        canvas.height = Math.max(height, canvas.height);
      }
      return canvas.getContext('2d');
    },
  };
}
const paintScratch = makeScratch();
const maskScratch = makeScratch();

/**
 * 'edit' (default): full MECCHA look with the ink outline — used while
 * painting and on the result reveal, where the body must be easy to see.
 * 'seek': no outline at all, so a well-painted body genuinely blends into
 * the background and seekers have to actually search.
 */
export type BodyStyle = 'edit' | 'seek';

/**
 * MECCHA-style body: a white blob with an ink outline, and the hider's brush
 * strokes (stickman-local coords) painted on top, clipped to the silhouette.
 */
export function drawStickman(ctx: CanvasRenderingContext2D, s: StickmanState, style: BodyStyle = 'edit'): void {
  ctx.save();
  if (style === 'edit') {
    // 1) outline pass (slightly fatter dark body behind the white fill)
    ctx.strokeStyle = BODY_OUTLINE;
    ctx.fillStyle = BODY_OUTLINE;
    traceBody(ctx, s, 'fill', OUTLINE_WIDTH);
  }
  // 2) white base body
  ctx.strokeStyle = BODY_BASE;
  ctx.fillStyle = BODY_BASE;
  traceBody(ctx, s, 'fill');
  ctx.restore();

  if (s.strokes.length === 0) return;

  // 3) paint strokes clipped to the silhouette. The full-body alpha mask is
  //    built on its own scratch canvas and applied with ONE destination-in
  //    drawImage — per-part destination-in would intersect repeatedly and
  //    erase every stroke.
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const paint = paintScratch.ctx(w, h);
  const mask = maskScratch.ctx(w, h);
  if (!paint || !mask) return;

  mask.clearRect(0, 0, w, h);
  mask.save();
  mask.globalCompositeOperation = 'source-over';
  mask.strokeStyle = '#000';
  mask.fillStyle = '#000';
  traceBody(mask, s, 'fill');
  mask.restore();

  paint.clearRect(0, 0, w, h);
  paint.save();
  paint.globalCompositeOperation = 'source-over';
  for (const stroke of s.strokes) {
    paint.strokeStyle = stroke.color;
    paint.fillStyle = stroke.color;
    paint.lineWidth = stroke.size * s.scale;
    paint.lineCap = 'round';
    paint.lineJoin = 'round';
    paint.beginPath();
    const [first, ...rest] = stroke.points;
    const fx = s.x + first.x * s.scale;
    const fy = s.y + first.y * s.scale;
    if (rest.length === 0) {
      paint.arc(fx, fy, (stroke.size * s.scale) / 2, 0, Math.PI * 2);
      paint.fill();
    } else {
      paint.moveTo(fx, fy);
      for (const pt of rest) {
        paint.lineTo(s.x + pt.x * s.scale, s.y + pt.y * s.scale);
      }
      paint.stroke();
    }
  }
  // single-shot clip: keep only the paint that lands on the body
  paint.globalCompositeOperation = 'destination-in';
  paint.drawImage(maskScratch.canvas!, 0, 0);
  paint.restore();

  ctx.drawImage(paintScratch.canvas!, 0, 0, w, h, 0, 0, w, h);
}
