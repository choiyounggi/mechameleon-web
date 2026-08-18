import { rgbToHex } from './color';

export type EyedropperOutcome = { ok: true; hex: string } | { ok: false };

// D9: click -> 1x1 getImageData -> hex. The same-origin screenshot means this
// should never taint the canvas, but getImageData can still throw
// SecurityError (e.g. a background loaded from an unexpected origin) --
// treated defensively as a failed pick rather than an uncaught exception.
export function pickColor(
  ctx: Pick<CanvasRenderingContext2D, 'getImageData'>,
  x: number,
  y: number,
): EyedropperOutcome {
  try {
    const { data } = ctx.getImageData(Math.round(x), Math.round(y), 1, 1);
    return { ok: true, hex: rgbToHex(data[0], data[1], data[2]) };
  } catch {
    return { ok: false };
  }
}
