import type { Background } from 'shared/protocol';
import type { AppContext } from '../net';
import type { PhaseController } from '../phases';
import { drawStickman } from '../render/stickman-renderer';
import { attachPressFX, paintBurst } from '../fx';
import { getEndPayload } from './index';
import { resolveResultText, resultPulseRadius, RESULT_PULSE_BASE_RADIUS } from './logic';
import type { SeekEndPayload } from './logic';

// D6: canvas 2D strokeStyle cannot resolve CSS var() -- fixed local constants
// mirroring --color-paint-red / --color-paint-green (tokens.css).
const RING_STROKE = 'oklch(65% 0.21 25 / 0.5)';
const SURVIVED_RING_STROKE = 'oklch(71% 0.17 145 / 0.5)';
const RING_LINE_WIDTH = 3;

interface CleanupHolder {
  cleanup: (() => void) | null;
}

function mountHighlightCanvas(
  root: HTMLElement,
  stickmen: SeekEndPayload['stickmen'],
  background: Background,
): () => void {
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
      // D6: found -> the existing red pulsing ring; survived -> a fixed green
      // ring at the same base radius, so a timeout win reads as "safe", not alarmed.
      const pulseRadius = resultPulseRadius(Date.now(), startedAt);
      for (const s of stickmen) {
        drawStickman(canvasCtx, s.stickman);
        canvasCtx.beginPath();
        canvasCtx.strokeStyle = s.found ? RING_STROKE : SURVIVED_RING_STROKE;
        canvasCtx.lineWidth = RING_LINE_WIDTH;
        canvasCtx.arc(s.stickman.x, s.stickman.y, s.found ? pulseRadius : RESULT_PULSE_BASE_RADIUS, 0, Math.PI * 2);
        canvasCtx.stroke();
      }
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
  const text = resolveResultText(end);
  // D6: winner 'hider' -> at least one hider survived (go/green); winner
  // 'seekers' -> a clean sweep (danger/red). end===null (game:end never
  // arrived) falls back to the 'found' variant -- that path only shows the
  // defensive '게임 종료' text.
  const variant = end?.winner === 'hider' ? 'survived' : 'found';

  const detachers: (() => void)[] = [];

  const banner = document.createElement('div');
  banner.className = `mc-result-banner mc-result-banner--${variant}`;
  const title = document.createElement('div');
  title.className = 'mc-title-paint';
  Array.from(text).forEach((char, i) => {
    const span = document.createElement('span');
    // r1/F2: a plain space as the sole content of its own inline-block span
    // collapses to zero width in whitespace processing -- nbsp is immune to
    // that collapse, so word gaps stay visible in the letter-by-letter banner.
    span.textContent = char === ' ' ? ' ' : char;
    span.style.setProperty('--mc-pop-delay', `${i * 30}ms`);
    title.appendChild(span);
  });
  banner.appendChild(title);
  root.appendChild(banner);

  // Countdown sits above the stage canvas: the canvas is taller than the
  // viewport, so anything appended after it lands below the fold and the
  // 10-second return notice would never be seen without scrolling.
  const returnMsg = document.createElement('p');
  returnMsg.className = 'mc-hud-label mc-result-return-msg';
  returnMsg.textContent = '대기실로 돌아갑니다';
  const returnCount = document.createElement('div');
  returnCount.className = 'mc-hud-num mc-result-return-count';
  root.append(returnMsg, returnCount);

  let canvasCleanup: (() => void) | null = null;
  const background = ctx.state.room?.background ?? null;
  if (end?.stickmen.length && background) {
    const stage = document.createElement('div');
    stage.className = 'mc-result-stage';
    root.appendChild(stage);
    canvasCleanup = mountHighlightCanvas(stage, end.stickmen, background);
  }

  // Everyone sees the same countdown to the server-driven auto-return -- the
  // server owns endsAt and broadcasts phase:'lobby' when it elapses, so this
  // is a display-only readout (no client-side timer, derived every tick).
  const endsAt = ctx.state.room?.endsAt ?? null;
  function tick(): void {
    if (endsAt === null) return;
    const remainSec = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    returnCount.textContent = String(remainSec);
  }
  tick();
  const intervalId = window.setInterval(tick, 500);

  cleanupHolder.cleanup = () => {
    window.clearInterval(intervalId);
    canvasCleanup?.();
    detachers.forEach((detach) => detach());
  };

  const buttons = document.createElement('div');
  buttons.className = 'mc-result-buttons';

  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.className = 'mc-btn mc-btn--ghost';
  leaveBtn.textContent = '나가기';
  leaveBtn.addEventListener('click', () => {
    void ctx.leaveToHome?.();
  });
  detachers.push(attachPressFX(leaveBtn));

  buttons.appendChild(leaveBtn);
  root.append(buttons);

  // D5: single entrance burst, centered on the banner.
  const rect = banner.getBoundingClientRect();
  paintBurst(rect.left + rect.width / 2, rect.top + rect.height / 2, { count: 14 });
}

function createResultController(): PhaseController {
  const cleanupHolder: CleanupHolder = { cleanup: null };
  let unbind: (() => void) | null = null;

  return {
    mount(root: HTMLElement, ctx: AppContext) {
      function render(): void {
        cleanupHolder.cleanup?.();
        cleanupHolder.cleanup = null;
        root.innerHTML = '';
        mountResultScreen(root, ctx, cleanupHolder);
      }
      render();

      // Room state (e.g. host handover) can change while this screen is up --
      // re-render so the screen stays consistent with it. Guarded on phase
      // because socket.io still calls a just-removed listener once after a
      // same-event unmount (see lobby's mounted guard).
      function onRoomState(): void {
        if (ctx.state.room?.phase === 'result') render();
      }
      ctx.socket.on('room:state', onRoomState);
      unbind = () => ctx.socket.off('room:state', onRoomState);
    },
    unmount() {
      unbind?.();
      unbind = null;
      cleanupHolder.cleanup?.();
      cleanupHolder.cleanup = null;
    },
  };
}

export const resultController = createResultController();
