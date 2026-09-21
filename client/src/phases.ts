import type { Phase } from 'shared/protocol';
import type { AppContext } from './net';

export interface PhaseController {
  mount(root: HTMLElement, ctx: AppContext): void;
  unmount(): void;
}

const registry = new Map<Phase, PhaseController>();

export function registerPhase(phase: Phase, ctrl: PhaseController): void {
  registry.set(phase, ctrl);
}

// Unregistered phase (D3): gray "…" screen. seek/result stay on this fallback
// in this task — client-seek registers them.
const fallbackController: PhaseController = {
  mount(root) {
    root.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'mc-fallback';
    el.textContent = '…';
    // Background stays this exact inline literal: the getPhase fallback test in
    // client/test/phases.test.ts asserts its parsed style.background value.
    // Every other inline write moved to the .mc-fallback CSS class in
    // fx/fx.css (D1).
    el.style.background = '#e5e5e5';
    const spinner = document.createElement('div');
    spinner.className = 'mc-fallback-spinner';
    el.appendChild(spinner);
    root.appendChild(el);
  },
  unmount() {
    // no state to tear down
  },
};

export function getPhase(phase: Phase): PhaseController {
  return registry.get(phase) ?? fallbackController;
}

export function resolvePhaseChange(prev: Phase | null, next: Phase, force = false): 'switch' | 'none' {
  if (force) return 'switch';
  return prev === next ? 'none' : 'switch';
}

export interface PhaseRouterOpts {
  force?: boolean;
}

export interface PhaseRouter {
  onPhase(next: Phase, opts?: PhaseRouterOpts): void;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const PHASE_FADE_CLEANUP_TIMEOUT_MS = 400;
const PHASE_WIPE_CLEANUP_TIMEOUT_MS = 500;

export function createPhaseRouter(root: HTMLElement, ctx: AppContext): PhaseRouter {
  let currentPhase: Phase | null = null;
  let currentController: PhaseController | null = null;
  let fadeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let fadeEndHandler: ((event: Event) => void) | null = null;
  let wipeOverlay: HTMLElement | null = null;
  let wipeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let wipeEndHandler: ((event: Event) => void) | null = null;

  function clearPendingFade(): void {
    root.classList.remove('mc-phase-fade');
    if (fadeEndHandler) {
      root.removeEventListener('animationend', fadeEndHandler);
      fadeEndHandler = null;
    }
    if (fadeTimeoutId !== null) {
      clearTimeout(fadeTimeoutId);
      fadeTimeoutId = null;
    }
  }

  function clearPendingWipe(): void {
    if (wipeEndHandler && wipeOverlay) {
      wipeOverlay.removeEventListener('animationend', wipeEndHandler);
    }
    wipeEndHandler = null;
    if (wipeTimeoutId !== null) {
      clearTimeout(wipeTimeoutId);
      wipeTimeoutId = null;
    }
    if (wipeOverlay) {
      wipeOverlay.remove();
      wipeOverlay = null;
    }
  }

  function startFade(): void {
    clearPendingFade();
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    root.offsetWidth;
    root.classList.add('mc-phase-fade');

    const onEnd = (event: Event): void => {
      if (event.target !== root) return;
      clearPendingFade();
    };
    fadeEndHandler = onEnd;
    root.addEventListener('animationend', onEnd);

    fadeTimeoutId = setTimeout(() => {
      clearPendingFade();
    }, PHASE_FADE_CLEANUP_TIMEOUT_MS);
  }

  function startWipe(): void {
    clearPendingWipe();
    if (prefersReducedMotion()) return;

    const rect = root.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.className = 'mc-phase-wipe';
    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    document.body.appendChild(overlay);
    wipeOverlay = overlay;

    const onEnd = (event: Event): void => {
      if (event.target !== overlay) return;
      clearPendingWipe();
    };
    wipeEndHandler = onEnd;
    overlay.addEventListener('animationend', onEnd);

    wipeTimeoutId = setTimeout(() => {
      clearPendingWipe();
    }, PHASE_WIPE_CLEANUP_TIMEOUT_MS);
  }

  function onPhase(next: Phase, opts?: PhaseRouterOpts): void {
    if (resolvePhaseChange(currentPhase, next, opts?.force) === 'none') return;
    currentController?.unmount();
    const ctrl = getPhase(next);
    ctrl.mount(root, ctx);
    currentController = ctrl;
    currentPhase = next;
    if (root.isConnected) {
      startFade();
      startWipe();
    }
  }

  return { onPhase };
}
