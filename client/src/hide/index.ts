import type { StickmanState, StickmanStroke } from 'shared/protocol';
import type { AppContext } from '../net';
import { createHideUpdateSender, hideConfirm } from '../net';
import type { PhaseController } from '../phases';
import { registerPhase } from '../phases';
import { initialStickman } from 'shared/stickman';
import { drawStickman } from '../render/stickman-renderer';
import { pickColor } from './eyedropper';
import { ARROW_STEP, SCALE_STEP, SHIFT_ARROW_STEP, applyMove, clampScale } from './movement';
import { DEFAULT_BRUSH_COLOR, EYEDROPPER_KEY, appendPoint, finishStroke, startStroke } from './paint';
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

  // Same top-center start pose the server assigns (shared/stickman.ts) — the
  // page opens scrolled to the top with the stickman in view.
  let stickman: StickmanState = initialStickman(background.width, background.height);
  let currentColor = DEFAULT_BRUSH_COLOR;
  let activeStroke: StickmanStroke | null = null;

  const toolbar = document.createElement('div');
  toolbar.className = 'mc-hide-toolbar';

  const swatch = document.createElement('span');
  swatch.className = 'mc-swatch';
  swatch.setAttribute('aria-label', '현재 붓 색');
  swatch.style.background = currentColor;

  const hint = document.createElement('span');
  hint.className = 'mc-hide-hint';
  hint.textContent = '드래그: 색칠 · ⌥Alt+클릭: 스포이드 · 방향키: 이동 · +/-: 크기';

  const timerEl = document.createElement('span');
  const errorEl = document.createElement('div');

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = '확정';
  confirmBtn.addEventListener('click', () => {
    void hideConfirm(ctx);
  });

  toolbar.append(swatch, hint, timerEl, errorEl, confirmBtn);
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
  // The eyedropper listens on bgCanvas underneath — without this, the overlay
  // swallows every real mouse click and painting is impossible.
  overlayCanvas.style.pointerEvents = 'none';

  container.append(bgCanvas, overlayCanvas);
  root.appendChild(container);

  // jsdom (test env) has no Canvas 2D support and returns null here; guard so
  // mount() stays testable (drawing silently no-ops), same as the seek screen.
  const bgCtx = bgCanvas.getContext('2d');
  const overlayCtx = overlayCanvas.getContext('2d');

  const img = new Image();
  img.onload = () => {
    bgCtx?.drawImage(img, 0, 0);
  };
  img.src = background.imageUrl;

  const sender = createHideUpdateSender(ctx);

  function redraw(): void {
    if (!overlayCtx) return;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    const preview = activeStroke ? { ...stickman, strokes: [...stickman.strokes, activeStroke] } : stickman;
    drawStickman(overlayCtx, preview);
  }
  redraw();

  function endActiveStroke(): void {
    if (!activeStroke) return;
    const { state, accepted } = finishStroke(stickman, activeStroke);
    activeStroke = null;
    if (accepted) {
      stickman = state;
      errorEl.textContent = '';
      sendUpdate();
    } else {
      errorEl.textContent = '물감 한도에 도달했어요';
    }
    redraw();
  }

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
      endActiveStroke();
      const next = applyMove(stickman, dx, dy, bounds);
      stickman = { ...stickman, x: next.x, y: next.y };
      redraw();
      followScroll();
      sendUpdate();
      e.preventDefault();
      return;
    }
    if (e.key === '+' || e.key === '=') {
      endActiveStroke();
      stickman = { ...stickman, scale: clampScale(stickman.scale + SCALE_STEP) };
      redraw();
      sendUpdate();
      e.preventDefault();
      return;
    }
    if (e.key === '-') {
      endActiveStroke();
      stickman = { ...stickman, scale: clampScale(stickman.scale - SCALE_STEP) };
      redraw();
      sendUpdate();
      e.preventDefault();
      return;
    }
  }
  window.addEventListener('keydown', onKeydown);

  // eyedropper affordance while Alt is held
  function onAltDown(e: KeyboardEvent): void {
    if (e.key === EYEDROPPER_KEY) bgCanvas.style.cursor = 'copy';
  }
  function onAltUp(e: KeyboardEvent): void {
    if (e.key === EYEDROPPER_KEY) bgCanvas.style.cursor = 'crosshair';
  }
  window.addEventListener('keydown', onAltDown);
  window.addEventListener('keyup', onAltUp);
  bgCanvas.style.cursor = 'crosshair';

  function onPointerDown(e: MouseEvent): void {
    if (e.altKey) {
      // 스포이드: Alt(⌥)를 누른 채 클릭한 지점의 배경색을 붓 색으로
      if (!bgCtx) {
        errorEl.textContent = '이미지를 읽을 수 없어요';
        return;
      }
      const outcome = pickColor(bgCtx, e.offsetX, e.offsetY);
      if (outcome.ok) {
        currentColor = outcome.hex;
        swatch.style.background = currentColor;
        errorEl.textContent = '';
      } else {
        errorEl.textContent = '이미지를 읽을 수 없어요';
      }
      return;
    }
    activeStroke = startStroke(currentColor, { x: e.offsetX, y: e.offsetY }, stickman);
    redraw();
  }
  function onPointerMove(e: MouseEvent): void {
    if (!activeStroke) return;
    if (appendPoint(activeStroke, stickman, e.offsetX, e.offsetY)) redraw();
  }
  function onPointerUp(): void {
    endActiveStroke();
  }
  bgCanvas.addEventListener('mousedown', onPointerDown);
  bgCanvas.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  function tick(): void {
    timerEl.textContent = formatRemaining(remainingMs(endsAt, Date.now()));
  }
  tick();
  const intervalId = window.setInterval(tick, TIMER_TICK_MS);

  cleanupHolder.cleanup = () => {
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('keydown', onAltDown);
    window.removeEventListener('keyup', onAltUp);
    window.removeEventListener('mouseup', onPointerUp);
    bgCanvas.removeEventListener('mousedown', onPointerDown);
    bgCanvas.removeEventListener('mousemove', onPointerMove);
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
