import type { Background, StickmanState } from 'shared/protocol';
import type { AppContext } from '../net';
import type { PhaseController } from '../phases';
import { drawStickman } from '../render/stickman-renderer';
import { getEndPayload } from './index';
import { resolveResultText, resultPulseRadius } from './logic';

const RING_STROKE = 'rgba(200, 80, 80, 0.5)';
const RING_LINE_WIDTH = 3;

interface CleanupHolder {
  cleanup: (() => void) | null;
}

function mountHighlightCanvas(root: HTMLElement, stickman: StickmanState, background: Background): () => void {
  const canvas = document.createElement('canvas');
  canvas.width = background.width;
  canvas.height = background.height;
  root.appendChild(canvas);

  // jsdom (test env) has no Canvas 2D support and returns null here; guard so
  // mount() stays testable (drawing silently no-ops) instead of throwing.
  const canvasCtx = canvas.getContext('2d');

  const img = new Image();
  let imgLoaded = false;
  img.onload = () => {
    imgLoaded = true;
  };
  img.src = background.imageUrl;

  const startedAt = Date.now();
  let rafHandle: number | null = null;
  function frame(): void {
    if (canvasCtx) {
      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
      if (imgLoaded) canvasCtx.drawImage(img, 0, 0);
      drawStickman(canvasCtx, stickman);
      const radius = resultPulseRadius(Date.now(), startedAt);
      canvasCtx.beginPath();
      canvasCtx.strokeStyle = RING_STROKE;
      canvasCtx.lineWidth = RING_LINE_WIDTH;
      canvasCtx.arc(stickman.x, stickman.y, radius, 0, Math.PI * 2);
      canvasCtx.stroke();
    }
    rafHandle = window.requestAnimationFrame(frame);
  }
  rafHandle = window.requestAnimationFrame(frame);

  return () => {
    if (rafHandle !== null) window.cancelAnimationFrame(rafHandle);
  };
}

function mountResultScreen(root: HTMLElement, ctx: AppContext, cleanupHolder: CleanupHolder): void {
  const end = getEndPayload();
  const text = resolveResultText(end, ctx.state.room);

  const heading = document.createElement('div');
  heading.textContent = text;
  root.appendChild(heading);

  const background = ctx.state.room?.background ?? null;
  if (end?.stickman && background) {
    cleanupHolder.cleanup = mountHighlightCanvas(root, end.stickman, background);
  }

  const restartBtn = document.createElement('button');
  restartBtn.type = 'button';
  restartBtn.textContent = '다시 하기';
  // D8: no server rematch API exists (out of scope) -- restart by reloading
  // into a fresh room flow.
  restartBtn.addEventListener('click', () => {
    window.location.reload();
  });
  root.appendChild(restartBtn);
}

function createResultController(): PhaseController {
  const cleanupHolder: CleanupHolder = { cleanup: null };

  return {
    mount(root: HTMLElement, ctx: AppContext) {
      root.innerHTML = '';
      mountResultScreen(root, ctx, cleanupHolder);
    },
    unmount() {
      cleanupHolder.cleanup?.();
      cleanupHolder.cleanup = null;
    },
  };
}

export const resultController = createResultController();
