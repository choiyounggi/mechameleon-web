import type { PartKey, StickmanState } from 'shared/protocol';
import type { AppContext } from '../net';
import { createHideUpdateSender, hideConfirm } from '../net';
import type { PhaseController } from '../phases';
import { registerPhase } from '../phases';
import { drawStickman } from '../render/stickman-renderer';
import { pickColor } from './eyedropper';
import {
  ARROW_STEP,
  PART_ORDER,
  SCALE_STEP,
  SHIFT_ARROW_STEP,
  applyMove,
  clampScale,
  partForDigitKey,
} from './movement';
import { formatRemaining, remainingMs } from './timer';

interface CleanupHolder {
  cleanup: (() => void) | null;
}

const FOLLOW_MARGIN_PX = 120;
const TIMER_TICK_MS = 500;

function mountWaitScreen(root: HTMLElement, ctx: AppContext, cleanupHolder: CleanupHolder): void {
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.alignItems = 'center';
  wrap.style.justifyContent = 'center';
  wrap.style.height = '100%';
  wrap.style.background = '#e5e5e5';
  wrap.style.color = '#999';

  const msg = document.createElement('div');
  msg.textContent = '잠시만요…';
  const timerEl = document.createElement('div');
  wrap.append(msg, timerEl);
  root.appendChild(wrap);

  const endsAt = ctx.state.room?.endsAt ?? null;
  function tick(): void {
    if (endsAt === null) return;
    timerEl.textContent = formatRemaining(remainingMs(endsAt, Date.now()));
  }
  tick();
  const intervalId = window.setInterval(tick, TIMER_TICK_MS);

  cleanupHolder.cleanup = () => {
    window.clearInterval(intervalId);
  };
}

function mountEditScreen(root: HTMLElement, ctx: AppContext, cleanupHolder: CleanupHolder): void {
  const payload = ctx.state.hidePayload;
  if (!payload) {
    // Defensive: 'hide' phase mounted before the phase:hide payload arrived.
    const waiting = document.createElement('div');
    waiting.textContent = '…';
    root.appendChild(waiting);
    return;
  }
  const { background, endsAt } = payload;

  let selectedPart: PartKey = 'head';
  let stickman: StickmanState = {
    x: background.width / 2,
    y: background.height / 2,
    scale: 1,
    colors: {
      head: '#000000',
      torso: '#000000',
      leftArm: '#000000',
      rightArm: '#000000',
      leftLeg: '#000000',
      rightLeg: '#000000',
    },
  };

  const toolbar = document.createElement('div');
  const partsWrap = document.createElement('div');
  const partButtons = new Map<PartKey, HTMLButtonElement>();

  function selectPart(part: PartKey): void {
    selectedPart = part;
    for (const [p, btn] of partButtons) {
      btn.setAttribute('aria-pressed', String(p === selectedPart));
    }
  }

  PART_ORDER.forEach((part, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = String(i + 1);
    btn.setAttribute('aria-label', part);
    btn.setAttribute('aria-pressed', String(part === selectedPart));
    btn.addEventListener('click', () => selectPart(part));
    partButtons.set(part, btn);
    partsWrap.appendChild(btn);
  });

  const timerEl = document.createElement('span');
  const errorEl = document.createElement('div');

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = '확정';
  confirmBtn.addEventListener('click', () => {
    void hideConfirm(ctx);
  });

  toolbar.append(partsWrap, timerEl, errorEl, confirmBtn);
  root.appendChild(toolbar);

  const container = document.createElement('div');
  container.style.position = 'relative';
  container.style.overflow = 'auto';
  container.style.width = '100%';
  container.style.height = '100%';

  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = background.width;
  bgCanvas.height = background.height;

  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.width = background.width;
  overlayCanvas.height = background.height;
  overlayCanvas.style.position = 'absolute';
  overlayCanvas.style.left = '0';
  overlayCanvas.style.top = '0';

  container.append(bgCanvas, overlayCanvas);
  root.appendChild(container);

  const bgCtx = bgCanvas.getContext('2d')!;
  const overlayCtx = overlayCanvas.getContext('2d')!;

  const img = new Image();
  img.onload = () => {
    bgCtx.drawImage(img, 0, 0);
  };
  img.src = background.imageUrl;

  const sender = createHideUpdateSender(ctx);

  function redraw(): void {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    drawStickman(overlayCtx, stickman);
  }
  redraw();

  function followScroll(): void {
    const viewLeft = container.scrollLeft;
    const viewTop = container.scrollTop;
    const viewRight = viewLeft + container.clientWidth;
    const viewBottom = viewTop + container.clientHeight;
    const needsScroll =
      stickman.x < viewLeft + FOLLOW_MARGIN_PX ||
      stickman.x > viewRight - FOLLOW_MARGIN_PX ||
      stickman.y < viewTop + FOLLOW_MARGIN_PX ||
      stickman.y > viewBottom - FOLLOW_MARGIN_PX;
    if (!needsScroll) return;
    container.scrollTo({
      left: Math.max(0, stickman.x - container.clientWidth / 2),
      top: Math.max(0, stickman.y - container.clientHeight / 2),
      behavior: 'smooth',
    });
  }

  function sendUpdate(): void {
    sender.send(stickman);
  }

  function onKeydown(e: KeyboardEvent): void {
    const bounds = { width: background.width, height: background.height };
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = e.shiftKey ? SHIFT_ARROW_STEP : ARROW_STEP;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const next = applyMove(stickman, dx, dy, bounds);
      stickman = { ...stickman, x: next.x, y: next.y };
      redraw();
      followScroll();
      sendUpdate();
      e.preventDefault();
      return;
    }
    if (e.key === '+' || e.key === '=') {
      stickman = { ...stickman, scale: clampScale(stickman.scale + SCALE_STEP) };
      redraw();
      sendUpdate();
      e.preventDefault();
      return;
    }
    if (e.key === '-') {
      stickman = { ...stickman, scale: clampScale(stickman.scale - SCALE_STEP) };
      redraw();
      sendUpdate();
      e.preventDefault();
      return;
    }
    const part = partForDigitKey(e.key);
    if (part) {
      selectPart(part);
      e.preventDefault();
    }
  }
  window.addEventListener('keydown', onKeydown);

  function onCanvasClick(e: MouseEvent): void {
    const outcome = pickColor(bgCtx, e.offsetX, e.offsetY);
    if (outcome.ok) {
      errorEl.textContent = '';
      stickman = { ...stickman, colors: { ...stickman.colors, [selectedPart]: outcome.hex } };
      redraw();
      sendUpdate();
    } else {
      errorEl.textContent = '이미지를 읽을 수 없어요';
    }
  }
  bgCanvas.addEventListener('click', onCanvasClick);

  function tick(): void {
    timerEl.textContent = formatRemaining(remainingMs(endsAt, Date.now()));
  }
  tick();
  const intervalId = window.setInterval(tick, TIMER_TICK_MS);

  cleanupHolder.cleanup = () => {
    window.removeEventListener('keydown', onKeydown);
    bgCanvas.removeEventListener('click', onCanvasClick);
    window.clearInterval(intervalId);
    sender.cancel();
  };
}

export function createHideController(): PhaseController {
  const cleanupHolder: CleanupHolder = { cleanup: null };

  return {
    mount(root: HTMLElement, ctx: AppContext) {
      root.innerHTML = '';
      if (ctx.state.role === 'seeker') {
        mountWaitScreen(root, ctx, cleanupHolder);
      } else {
        mountEditScreen(root, ctx, cleanupHolder);
      }
    },
    unmount() {
      cleanupHolder.cleanup?.();
      cleanupHolder.cleanup = null;
    },
  };
}

export const hideController = createHideController();
registerPhase('hide', hideController);
