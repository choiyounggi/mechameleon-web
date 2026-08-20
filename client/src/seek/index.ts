import type { Background, StickmanState } from 'shared/protocol';
import type { AppContext } from '../net';
import { seekClick } from '../net';
import type { PhaseController } from '../phases';
import { registerPhase } from '../phases';
import { drawStickman } from '../render/stickman-renderer';
import { formatRemaining, remainingMs } from '../hide/timer';
import { applySeekClickAck, canClick, lockoutBadgeText } from './logic';
import type { SeekEndPayload } from './logic';
import { createRippleStore } from './ripple';
import type { ActiveRipple } from './ripple';
import { resultController } from './result';

// Shape of the 'phase:seek' server payload (shared/protocol.ts ServerToClientEvents).
export interface SeekStartPayload {
  background: Background;
  stickman: StickmanState;
  endsAt: number;
}

const TIMER_TICK_MS = 500;
const RIPPLE_STROKE = 'rgba(120, 120, 120,';

// D1: module-level "server-state cache" for the two payloads that race
// room:state -- initSeek's listeners run before any mount can, so a mount
// that happens after the race always reads a fresh value here rather than
// missing the one-shot event.
let seekPayload: SeekStartPayload | null = null;
let endPayload: SeekEndPayload | null = null;

export function getSeekPayload(): SeekStartPayload | null {
  return seekPayload;
}

export function getEndPayload(): SeekEndPayload | null {
  return endPayload;
}

interface CleanupHolder {
  cleanup: (() => void) | null;
}

function mountSeekScreen(root: HTMLElement, ctx: AppContext, cleanupHolder: CleanupHolder): void {
  const payload = seekPayload;
  if (!payload) {
    // Defensive: 'seek' phase mounted before the phase:seek payload arrived.
    const waiting = document.createElement('div');
    waiting.textContent = '…';
    root.appendChild(waiting);
    return;
  }
  const { background, stickman, endsAt } = payload;

  const topBar = document.createElement('div');
  const timerEl = document.createElement('span');
  topBar.appendChild(timerEl);
  if (ctx.state.role === 'hider') {
    const spectatorBadge = document.createElement('span');
    spectatorBadge.textContent = '관전';
    spectatorBadge.style.color = '#999';
    spectatorBadge.style.float = 'right';
    topBar.appendChild(spectatorBadge);
  }
  root.appendChild(topBar);

  // D5: fixed bottom-right lockout countdown badge, plain gray, no shake/overlay.
  const badgeEl = document.createElement('div');
  badgeEl.style.position = 'fixed';
  badgeEl.style.right = '8px';
  badgeEl.style.bottom = '8px';
  badgeEl.style.color = '#999';
  badgeEl.style.fontSize = '0.85em';
  root.appendChild(badgeEl);

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

  // jsdom (test env) has no Canvas 2D support and returns null here; guard so
  // mount() stays testable (drawing silently no-ops) instead of throwing.
  const bgCtx = bgCanvas.getContext('2d');
  const overlayCtx = overlayCanvas.getContext('2d');

  const img = new Image();
  img.onload = () => {
    bgCtx?.drawImage(img, 0, 0);
  };
  img.src = background.imageUrl;

  const rippleStore = createRippleStore(Date.now);

  function redrawOverlay(ripples: ActiveRipple[]): void {
    if (!overlayCtx) return;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    // 'seek' style: no ink outline — the camouflage has to actually work.
    drawStickman(overlayCtx, stickman, 'seek');
    for (const ripple of ripples) {
      overlayCtx.beginPath();
      overlayCtx.strokeStyle = `${RIPPLE_STROKE} ${ripple.alpha})`;
      overlayCtx.lineWidth = 2;
      overlayCtx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
      overlayCtx.stroke();
    }
  }
  redrawOverlay([]);

  let rafHandle: number | null = null;
  function rippleFrame(): void {
    const active = rippleStore.active(Date.now());
    redrawOverlay(active);
    rafHandle = active.length > 0 ? window.requestAnimationFrame(rippleFrame) : null;
  }
  function onSeekMiss(payload: unknown): void {
    const { x, y } = payload as { x: number; y: number };
    rippleStore.add(x, y);
    if (rafHandle === null) {
      rafHandle = window.requestAnimationFrame(rippleFrame);
    }
  }
  ctx.socket.on('seek:miss', onSeekMiss);

  // D5: self-lockout badge, shared between a real 3s miss-lock and the brief
  // 1s flash on a raced 'locked' ack (see applySeekClickAck).
  let lockedUntil: number | null = null;
  function renderBadge(): void {
    const text = lockoutBadgeText(Date.now(), lockedUntil);
    badgeEl.textContent = text ?? '';
    container.style.cursor = text ? 'wait' : 'default';
  }

  let inFlight = false;
  function onOverlayClick(e: MouseEvent): void {
    if (inFlight) return;
    const now = Date.now();
    if (!canClick(now, lockedUntil)) return;
    inFlight = true;
    void seekClick(ctx, e.offsetX, e.offsetY).then((ack) => {
      inFlight = false;
      lockedUntil = applySeekClickAck(ack, Date.now(), lockedUntil);
      renderBadge();
    });
  }
  const isSeeker = ctx.state.role !== 'hider';
  if (isSeeker) {
    overlayCanvas.addEventListener('click', onOverlayClick);
  }

  function tick(): void {
    timerEl.textContent = formatRemaining(remainingMs(endsAt, Date.now()));
    renderBadge();
  }
  tick();
  const intervalId = window.setInterval(tick, TIMER_TICK_MS);

  cleanupHolder.cleanup = () => {
    if (isSeeker) overlayCanvas.removeEventListener('click', onOverlayClick);
    ctx.socket.off('seek:miss', onSeekMiss);
    window.clearInterval(intervalId);
    if (rafHandle !== null) window.cancelAnimationFrame(rafHandle);
  };
}

function createSeekController(): PhaseController {
  const cleanupHolder: CleanupHolder = { cleanup: null };

  return {
    mount(root: HTMLElement, ctx: AppContext) {
      root.innerHTML = '';
      mountSeekScreen(root, ctx, cleanupHolder);
    },
    unmount() {
      cleanupHolder.cleanup?.();
      cleanupHolder.cleanup = null;
    },
  };
}

const seekController = createSeekController();

export function initSeek(ctx: AppContext): void {
  ctx.socket.on('phase:seek', (payload) => {
    seekPayload = payload;
  });
  ctx.socket.on('game:end', (payload) => {
    endPayload = payload;
  });
  registerPhase('seek', seekController);
  registerPhase('result', resultController);
}
