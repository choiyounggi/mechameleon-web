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
    el.textContent = '…';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.height = '100%';
    el.style.background = '#e5e5e5';
    el.style.color = '#999';
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

export function createPhaseRouter(root: HTMLElement, ctx: AppContext): PhaseRouter {
  let currentPhase: Phase | null = null;
  let currentController: PhaseController | null = null;

  function onPhase(next: Phase, opts?: PhaseRouterOpts): void {
    if (resolvePhaseChange(currentPhase, next, opts?.force) === 'none') return;
    currentController?.unmount();
    const ctrl = getPhase(next);
    ctrl.mount(root, ctx);
    currentController = ctrl;
    currentPhase = next;
  }

  return { onPhase };
}
