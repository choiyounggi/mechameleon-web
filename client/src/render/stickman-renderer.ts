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

// Back-to-front draw order (D10) so limbs tuck behind the torso and the head
// sits on top.
const DRAW_ORDER: PartKey[] = ['leftLeg', 'rightLeg', 'leftArm', 'rightArm', 'torso', 'head'];

export function drawStickman(ctx: CanvasRenderingContext2D, s: StickmanState): void {
  const byPart = new Map(segmentEndpoints(s).map((e) => [e.part, e]));

  for (const part of DRAW_ORDER) {
    const seg = byPart.get(part);
    if (!seg) continue;
    const color = s.colors[part];

    if (part === 'head') {
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.arc(seg.ax, seg.ay, seg.r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = seg.r * 2;
      ctx.lineCap = 'round';
      ctx.moveTo(seg.ax, seg.ay);
      ctx.lineTo(seg.bx, seg.by);
      ctx.stroke();
    }
  }
}
