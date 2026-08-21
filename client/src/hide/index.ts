import type { StickmanState, StickmanStroke } from 'shared/protocol';
import type { AppContext } from '../net';
import { createHideUpdateSender, hideConfirm } from '../net';
import type { PhaseController } from '../phases';
import { registerPhase } from '../phases';
import { initialStickman } from 'shared/stickman';
import { drawStickman } from '../render/stickman-renderer';
import { attachPressFX, paintBurst } from '../fx';
import { pickColor } from './eyedropper';
import { ARROW_STEP, SCALE_STEP, SHIFT_ARROW_STEP, applyMove, clampScale } from './movement';
import { DEFAULT_BRUSH_COLOR, EYEDROPPER_KEY, appendPoint, finishStroke, startStroke } from './paint';
import { formatRemaining, remainingMs } from './timer';

interface CleanupHolder {
  cleanup: (() => void) | null;
}

const FOLLOW_MARGIN_PX = 120;
const TIMER_TICK_MS = 500;
const URGENT_THRESHOLD_MS = 10_000;

interface KeycapSpec {
  text: string;
  variant?: 'green' | 'yellow';
}

// Top-center HUD hourglass; fill/stroke use currentColor so the D2 urgent
// color swap (green -> red) on `.mc-hud-timer` carries through automatically.
function hourglassSvg(): string {
  return `
<svg width="22" height="30" viewBox="0 0 22 30" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <path d="M3 2h16M3 28h16M4 2c0 8 14 8 14 8s-14 0-14 8M18 2c0 8-14 8-14 8s14 0 14 8"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
  <path d="M7 4c0 5 8 5 8 5s-8 0-8 5" fill="currentColor" opacity="0.85"/>
</svg>`;
}

function buildKeyGroup(keys: KeycapSpec[], label: string): HTMLElement {
  const group = document.createElement('div');
  group.className = 'mc-hide-key';

  const caps = document.createElement('div');
  caps.className = 'mc-hide-key__caps';
  for (const key of keys) {
    const cap = document.createElement('span');
    cap.className = key.variant ? `mc-keycap mc-keycap--${key.variant}` : 'mc-keycap';
    cap.textContent = key.text;
    caps.appendChild(cap);
  }

  const labelEl = document.createElement('span');
  labelEl.className = 'mc-hide-key__label';
  labelEl.textContent = label;

  group.append(caps, labelEl);
  return group;
}

function mountWaitScreen(root: HTMLElement, ctx: AppContext, cleanupHolder: CleanupHolder): void {
  const wrap = document.createElement('div');
  wrap.className = 'mc-hide-wait';

  const msg = document.createElement('p');
  msg.className = 'mc-hud-label';
  msg.textContent = '술래는 잠시 대기…';
  const timerEl = document.createElement('div');
  timerEl.className = 'mc-hud-num';
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

  const hud = document.createElement('div');
  hud.className = 'mc-hide-hud';

  // top-center: hourglass + countdown + phase label (D1)
  const timerWrap = document.createElement('div');
  timerWrap.className = 'mc-hud-timer';
  timerWrap.insertAdjacentHTML('afterbegin', hourglassSvg());
  const timerEl = document.createElement('span');
  timerEl.className = 'mc-hud-num mc-hud-num--sm';
  const timerLabel = document.createElement('span');
  timerLabel.className = 'mc-hud-label';
  timerLabel.textContent = '숨어라!';
  timerWrap.append(timerEl, timerLabel);

  // bottom-center: keycap control strip (D3)
  const keys = document.createElement('div');
  keys.className = 'mc-hide-keys';
  keys.append(
    buildKeyGroup([{ text: '드래그', variant: 'green' }], '색칠'),
    buildKeyGroup([{ text: '⌥', variant: 'yellow' }], '스포이드'),
    buildKeyGroup([{ text: '◀' }, { text: '▶' }, { text: '▲' }, { text: '▼' }], '이동'),
    buildKeyGroup([{ text: '+/-' }], '크기'),
  );

  // top-right: swatch + confirm + error (D4, D5)
  const swatch = document.createElement('span');
  swatch.className = 'mc-swatch';
  swatch.setAttribute('aria-label', '현재 붓 색');
  swatch.style.background = currentColor;

  const errorEl = document.createElement('div');
  errorEl.className = 'mc-error';
  errorEl.hidden = true;
  // F1 (r1 review): an empty .mc-error still renders a visible pill in real
  // browsers, so keep it `hidden` whenever there's no message to show.
  function setError(message: string): void {
    errorEl.textContent = message;
    errorEl.hidden = message === '';
  }

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'mc-btn mc-btn--green';
  confirmBtn.textContent = '확정';
  const detachConfirmPressFX = attachPressFX(confirmBtn);
  confirmBtn.addEventListener('click', () => {
    const rect = confirmBtn.getBoundingClientRect();
    paintBurst(rect.left + rect.width / 2, rect.top + rect.height / 2);
    void hideConfirm(ctx);
  });

  const actionsRow = document.createElement('div');
  actionsRow.className = 'mc-hide-actions__row';
  actionsRow.append(swatch, confirmBtn);

  const actions = document.createElement('div');
  actions.className = 'mc-hide-actions';
  actions.append(actionsRow, errorEl);

  hud.append(timerWrap, keys, actions);
  root.appendChild(hud);

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
      setError('');
      sendUpdate();
    } else {
      setError('물감 한도에 도달했어요');
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
        setError('이미지를 읽을 수 없어요');
        return;
      }
      const outcome = pickColor(bgCtx, e.offsetX, e.offsetY);
      if (outcome.ok) {
        currentColor = outcome.hex;
        swatch.style.background = currentColor;
        setError('');
      } else {
        setError('이미지를 읽을 수 없어요');
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

  // D2: remaining <= 10s toggles is-urgent (red number) and replays the
  // shared mc-shake keyframe once per elapsed second while urgent.
  let lastShakeSecond: number | null = null;
  function tick(): void {
    const remaining = remainingMs(endsAt, Date.now());
    timerEl.textContent = formatRemaining(remaining);
    const urgent = remaining <= URGENT_THRESHOLD_MS;
    timerWrap.classList.toggle('is-urgent', urgent);
    if (!urgent) {
      lastShakeSecond = null;
      return;
    }
    const currentSecond = Math.floor(remaining / 1000);
    if (currentSecond === lastShakeSecond) return;
    lastShakeSecond = currentSecond;
    timerWrap.classList.remove('mc-shake');
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    timerWrap.offsetWidth; // force reflow so the animation restarts each second
    timerWrap.classList.add('mc-shake');
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
    detachConfirmPressFX();
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
