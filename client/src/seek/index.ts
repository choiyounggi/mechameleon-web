import type { Background, SeekStickman } from 'shared/protocol';
import type { AppContext } from '../net';
import { seekClick } from '../net';
import type { PhaseController } from '../phases';
import { registerPhase } from '../phases';
import { drawStickman } from '../render/stickman-renderer';
import { formatRemaining, remainingMs } from '../hide/timer';
import { attachPressFX, paintBurst, screenShake } from '../fx';
import { attachLeaveConfirm } from '../util/leave-confirm';
import { applySeekClickAck, canClick, lockoutBadgeText, seekBodyStyle } from './logic';
import type { SeekEndPayload } from './logic';
import { createRippleStore, drawRipples } from './ripple';
import type { ActiveRipple } from './ripple';
import { resultController } from './result';

// Shape of the 'phase:seek' server payload (shared/protocol.ts ServerToClientEvents).
export interface SeekStartPayload {
  background: Background;
  stickmen: SeekStickman[];
  endsAt: number;
}

const TIMER_TICK_MS = 500;
const SVG_NS = 'http://www.w3.org/2000/svg';

// D1: inline hourglass, red sand for the seek (danger/pursuit) phase --
// deliberately not the DNA's green (that reference icon is the hide phase).
function createHourglassIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('mc-seek-hourglass');

  const frame = document.createElementNS(SVG_NS, 'path');
  frame.setAttribute('d', 'M5 2h14v3l-6 7 6 7v3H5v-3l6-7-6-7V2z');
  frame.classList.add('mc-seek-hourglass-frame');

  const sand = document.createElementNS(SVG_NS, 'path');
  sand.setAttribute('d', 'M8 4h8l-4 5-4-5zM8 20h8l-4-5-4 5z');
  sand.classList.add('mc-seek-hourglass-sand');

  svg.append(frame, sand);
  return svg;
}

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
  const { background, stickmen, endsAt } = payload;
  const isSeeker = ctx.state.role !== 'hider';
  const foundIds = new Set<string>();

  // D1: top-center HUD -- hourglass + mm:ss timer + phase label (spectator branch).
  const hud = document.createElement('div');
  hud.className = 'mc-seek-hud';
  const timerEl = document.createElement('span');
  timerEl.className = 'mc-seek-hud-timer';
  const hudLabel = document.createElement('span');
  hudLabel.className = 'mc-hud-label';
  hudLabel.textContent = isSeeker ? '찾아라!' : '관전 중';
  // D4: remaining-hiders readout, updated from seek:found's server-truth count.
  const remainingHidersEl = document.createElement('span');
  remainingHidersEl.className = 'mc-hud-label mc-seek-remaining';
  remainingHidersEl.textContent = `남은 카멜레온 ${stickmen.length}`;
  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  hud.append(createHourglassIcon(), timerEl, hudLabel, remainingHidersEl, leaveBtn);
  root.appendChild(hud);

  const detachLeavePressFX = attachPressFX(leaveBtn);
  const detachLeaveConfirm = attachLeaveConfirm(leaveBtn, () => void ctx.leaveToHome?.());

  // D1: bottom-right oversized remaining-seconds readout (.mc-hud-num contract).
  const remainEl = document.createElement('div');
  remainEl.className = 'mc-hud-num mc-seek-remain';
  root.appendChild(remainEl);

  // D2: bottom-left lockout chip -- a red-tinted .mc-keycap, hidden when not locked.
  const lockoutEl = document.createElement('div');
  lockoutEl.className = 'mc-seek-lockout';
  lockoutEl.hidden = true;
  const lockoutChip = document.createElement('span');
  lockoutChip.className = 'mc-keycap';
  lockoutEl.appendChild(lockoutChip);
  root.appendChild(lockoutEl);

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
    // D3: unfound hiders stay in 'seek' style (no ink outline, camouflage
    // intact); a found hider is redrawn in the default outlined style.
    for (const s of stickmen) {
      drawStickman(overlayCtx, s.stickman, seekBodyStyle(s.playerId, foundIds));
    }
    drawRipples(overlayCtx, ripples);
  }
  redrawOverlay([]);

  let rafHandle: number | null = null;
  function rippleFrame(): void {
    const active = rippleStore.active(Date.now());
    redrawOverlay(active);
    rafHandle = active.length > 0 ? window.requestAnimationFrame(rippleFrame) : null;
  }
  // D4: canvas-space miss coords -> screen coords for the DOM paint burst.
  // Skipped when the coords fall outside the overlay canvas's own bounds
  // (the "rect") -- there is nothing on-screen there to burst at.
  function triggerMissBurst(x: number, y: number): void {
    if (x < 0 || y < 0 || x > overlayCanvas.width || y > overlayCanvas.height) return;
    const rect = overlayCanvas.getBoundingClientRect();
    paintBurst(rect.left + x + window.scrollX, rect.top + y + window.scrollY, { count: 8 });
  }
  function onSeekMiss(payload: unknown): void {
    const { x, y } = payload as { x: number; y: number };
    rippleStore.add(x, y);
    if (rafHandle === null) {
      rafHandle = window.requestAnimationFrame(rippleFrame);
    }
    triggerMissBurst(x, y);
  }
  ctx.socket.on('seek:miss', onSeekMiss);

  // D3: burst just above the revealed stickman's head, in screen coords --
  // same canvas-rect transform as triggerMissBurst, no bounds check needed
  // since a hider's position is always within the canvas.
  function triggerFoundBurst(x: number, y: number): void {
    const rect = overlayCanvas.getBoundingClientRect();
    paintBurst(rect.left + x + window.scrollX, rect.top + (y - 60) + window.scrollY, { count: 12 });
  }
  function onSeekFound(payload: unknown): void {
    const { playerId, remaining } = payload as { playerId: string; nickname: string; by: string; remaining: number };
    foundIds.add(playerId);
    const found = stickmen.find((s) => s.playerId === playerId);
    if (found) triggerFoundBurst(found.stickman.x, found.stickman.y);
    redrawOverlay(rippleStore.active(Date.now()));
    remainingHidersEl.textContent = `남은 카멜레온 ${remaining}`;
  }
  ctx.socket.on('seek:found', onSeekFound);

  // D2/D5: self-lockout chip, shared between a real 3s miss-lock and the brief
  // 1s flash on a raced 'locked' ack (see applySeekClickAck).
  let lockedUntil: number | null = null;
  function renderBadge(): void {
    const text = lockoutBadgeText(Date.now(), lockedUntil);
    lockoutChip.textContent = text ? `⏳ ${text}` : '';
    lockoutEl.hidden = text === null;
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
      const wasUnlocked = canClick(Date.now(), lockedUntil);
      lockedUntil = applySeekClickAck(ack, Date.now(), lockedUntil);
      // D2: shake once, only on the transition into a lock (not on a
      // 'locked'-ack extension of an already-active lock).
      if (wasUnlocked && !canClick(Date.now(), lockedUntil)) {
        screenShake(container, { intensityPx: 4 });
      }
      renderBadge();
    });
  }
  if (isSeeker) {
    overlayCanvas.addEventListener('click', onOverlayClick);
  }

  function tick(): void {
    const ms = remainingMs(endsAt, Date.now());
    timerEl.textContent = formatRemaining(ms);
    remainEl.textContent = String(Math.ceil(ms / 1000));
    renderBadge();
  }
  tick();
  const intervalId = window.setInterval(tick, TIMER_TICK_MS);

  cleanupHolder.cleanup = () => {
    if (isSeeker) overlayCanvas.removeEventListener('click', onOverlayClick);
    ctx.socket.off('seek:miss', onSeekMiss);
    ctx.socket.off('seek:found', onSeekFound);
    window.clearInterval(intervalId);
    if (rafHandle !== null) window.cancelAnimationFrame(rafHandle);
    detachLeavePressFX();
    detachLeaveConfirm();
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
