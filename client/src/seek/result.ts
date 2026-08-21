import type { Background, StickmanState } from 'shared/protocol';
import type { AppContext } from '../net';
import { restartGame } from '../net';
import type { PhaseController } from '../phases';
import { drawStickman } from '../render/stickman-renderer';
import { attachPressFX, paintBurst } from '../fx';
import { getEndPayload } from './index';
import { resolveResultText, resultPulseRadius } from './logic';

// D6: canvas 2D strokeStyle cannot resolve CSS var() -- fixed local constant
// mirroring --color-paint-red (tokens.css).
const RING_STROKE = 'oklch(65% 0.21 25 / 0.5)';
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
  // D5: reason 'found' -> seeker won (danger/red), 'timeout' -> hider
  // survived (go/green). end===null (game:end never arrived) falls back to
  // the 'found' variant -- that path only shows the defensive '게임 종료' text.
  const variant = end?.reason === 'timeout' ? 'survived' : 'found';

  const detachers: (() => void)[] = [];

  const banner = document.createElement('div');
  banner.className = `mc-result-banner mc-result-banner--${variant}`;
  const title = document.createElement('div');
  title.className = 'mc-title-paint';
  Array.from(text).forEach((char, i) => {
    const span = document.createElement('span');
    span.textContent = char;
    span.style.setProperty('--mc-pop-delay', `${i * 30}ms`);
    title.appendChild(span);
  });
  banner.appendChild(title);
  root.appendChild(banner);

  let canvasCleanup: (() => void) | null = null;
  const background = ctx.state.room?.background ?? null;
  if (end?.stickman && background) {
    const stage = document.createElement('div');
    stage.className = 'mc-result-stage';
    root.appendChild(stage);
    canvasCleanup = mountHighlightCanvas(stage, end.stickman, background);
  }
  cleanupHolder.cleanup = () => {
    canvasCleanup?.();
    detachers.forEach((detach) => detach());
  };

  const buttons = document.createElement('div');
  buttons.className = 'mc-result-buttons';
  const errorEl = document.createElement('div');

  // Host decides the next round: same map for an instant rematch, or a fresh
  // URL (background cleared, so the lobby demands a new capture). Everyone
  // else waits for that choice or leaves.
  const amHost = ctx.state.room?.players.find((p) => p.id === ctx.state.playerId)?.isHost ?? false;
  if (amHost) {
    buttons.append(
      makeRestartButton(ctx, errorEl, detachers, '같은 맵으로 다시 시작', 'same'),
      makeRestartButton(ctx, errorEl, detachers, '새 배경으로 다시 시작', 'new'),
    );
  } else {
    const waiting = document.createElement('p');
    waiting.className = 'mc-hud-label';
    waiting.textContent = '호스트가 다음 게임을 정하고 있어요…';
    root.appendChild(waiting);
  }

  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.className = 'mc-btn mc-btn--ghost';
  leaveBtn.textContent = '나가기';
  // Reloading drops the socket; the server's disconnect handler removes this
  // player from the room, and the fresh page lands on the home screen.
  leaveBtn.addEventListener('click', () => {
    window.location.reload();
  });
  detachers.push(attachPressFX(leaveBtn));

  buttons.appendChild(leaveBtn);
  root.append(buttons, errorEl);

  // D5: single entrance burst, centered on the banner.
  const rect = banner.getBoundingClientRect();
  paintBurst(rect.left + rect.width / 2, rect.top + rect.height / 2, { count: 14 });
}

function makeRestartButton(
  ctx: AppContext,
  errorEl: HTMLElement,
  detachers: (() => void)[],
  label: string,
  mode: 'same' | 'new',
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `mc-btn ${mode === 'same' ? 'mc-btn--green' : 'mc-btn--yellow'}`;
  btn.textContent = label;
  btn.addEventListener('click', () => {
    void restartGame(ctx, mode).then((res) => {
      // BAD_PHASE: the room already left the result phase — the room:state
      // broadcast moves this client to the lobby anyway; report the rest.
      if (!res.ok && res.code !== 'BAD_PHASE') {
        errorEl.textContent = '다시 시작할 수 없어요';
      }
    });
  });
  detachers.push(attachPressFX(btn));
  return btn;
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

      // The host can change while this screen is up (old host left, someone
      // was promoted) — re-render so the new host gets the restart buttons.
      // Guarded on phase because socket.io still calls a just-removed
      // listener once after a same-event unmount (see lobby's mounted guard).
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
