import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/net';
import { createPhaseRouter, getPhase, registerPhase, resolvePhaseChange } from '../src/phases';
import type { PhaseController } from '../src/phases';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const fakeCtx = {} as AppContext;

function makeSpyController(): PhaseController & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    mount() {
      calls.push('mount');
    },
    unmount() {
      calls.push('unmount');
    },
  };
}

function stubReducedMotion(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  vi.useRealTimers();
  // jsdom has no native matchMedia; restore that state so a stub never leaks
  // into a later test (also when an assertion fails before any inline cleanup).
  delete (window as { matchMedia?: unknown }).matchMedia;
  // roots/overlays a failed test never reached its inline cleanup for
  document.body.innerHTML = '';
});

describe('resolvePhaseChange', () => {
  it('switches when the phase differs (normal)', () => {
    expect(resolvePhaseChange(null, 'lobby')).toBe('switch');
    expect(resolvePhaseChange('lobby', 'hide')).toBe('switch');
  });

  it('does nothing when the phase repeats (boundary)', () => {
    expect(resolvePhaseChange('hide', 'hide')).toBe('none');
  });

  it('switches on a repeated phase when force is true (boundary: leave-to-home force remount)', () => {
    expect(resolvePhaseChange('lobby', 'lobby', true)).toBe('switch');
  });
});

describe('getPhase', () => {
  it('falls back to a gray "…" screen for an unregistered phase (error)', () => {
    // 'result' is never registered by client-hide (owned by client-seek).
    const ctrl = getPhase('result');
    const root = document.createElement('div');

    ctrl.mount(root, fakeCtx);

    expect(root.textContent).toBe('…');
    expect(root.firstElementChild).not.toBeNull();
    expect((root.firstElementChild as HTMLElement).style.background).toBe('rgb(229, 229, 229)');
  });

  it('shows the mc-fallback class and a decorative mc-fallback-spinner child without changing the … textContent (error)', () => {
    const ctrl = getPhase('result');
    const root = document.createElement('div');

    ctrl.mount(root, fakeCtx);

    expect(root.firstElementChild!.className).toContain('mc-fallback');
    expect(root.querySelector('.mc-fallback-spinner')).not.toBeNull();
    expect(root.textContent).toBe('…');
  });
});

describe('createPhaseRouter', () => {
  beforeEach(() => {
    // overwrite any previous registration for 'lobby' so tests stay isolated
    // without needing a registry-reset API.
  });

  it('mounts the registered controller for the phase (normal)', () => {
    const ctrl = makeSpyController();
    registerPhase('lobby', ctrl);
    const root = document.createElement('div');
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');

    expect(ctrl.calls).toEqual(['mount']);
  });

  it('unmounts the previous controller before mounting the next, and does not remount on the same phase (boundary)', () => {
    const first = makeSpyController();
    const second = makeSpyController();
    registerPhase('lobby', first);
    registerPhase('hide', second);
    const root = document.createElement('div');
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');
    router.onPhase('lobby'); // same phase again -> no remount
    router.onPhase('hide');

    expect(first.calls).toEqual(['mount', 'unmount']);
    expect(second.calls).toEqual(['mount']);
  });

  it('remounts the same phase when onPhase is called with force (normal: leave-to-home)', () => {
    const ctrl = makeSpyController();
    registerPhase('lobby', ctrl);
    const root = document.createElement('div');
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');
    router.onPhase('lobby', { force: true });

    expect(ctrl.calls).toEqual(['mount', 'unmount', 'mount']);
  });

  it('does not remount the same phase when force is omitted (boundary: default unchanged)', () => {
    const ctrl = makeSpyController();
    registerPhase('lobby', ctrl);
    const root = document.createElement('div');
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');
    router.onPhase('lobby');

    expect(ctrl.calls).toEqual(['mount']);
  });
});

describe('phase-transition motion — root fade', () => {
  it('adds the mc-phase-fade class to the router root when a phase mounts (normal)', () => {
    vi.useFakeTimers();
    const ctrl = makeSpyController();
    registerPhase('lobby', ctrl);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');

    expect(root.classList.contains('mc-phase-fade')).toBe(true);
    vi.advanceTimersByTime(500);
    root.remove();
  });

  it('removes the mc-phase-fade class once animationend fires on the root itself (normal)', () => {
    vi.useFakeTimers();
    const ctrl = makeSpyController();
    registerPhase('lobby', ctrl);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');
    root.dispatchEvent(new Event('animationend'));

    expect(root.classList.contains('mc-phase-fade')).toBe(false);
    vi.advanceTimersByTime(500);
    root.remove();
  });

  it('removes the mc-phase-fade class via the fallback timeout when animationend never fires, as under jsdom (boundary)', () => {
    vi.useFakeTimers();
    const ctrl = makeSpyController();
    registerPhase('lobby', ctrl);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');
    expect(root.classList.contains('mc-phase-fade')).toBe(true);
    vi.advanceTimersByTime(400);

    expect(root.classList.contains('mc-phase-fade')).toBe(false);
    vi.advanceTimersByTime(500);
    root.remove();
  });

  it("cancels the previous phase's pending fade and restarts cleanly on a rapid second switch (boundary)", () => {
    vi.useFakeTimers();
    const first = makeSpyController();
    const second = makeSpyController();
    registerPhase('lobby', first);
    registerPhase('hide', second);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');
    vi.advanceTimersByTime(100);
    router.onPhase('hide');

    expect(root.classList.contains('mc-phase-fade')).toBe(true);
    // t=450: the FIRST switch's 400ms timer would have fired by now if it had
    // not been cancelled; the second fade (armed at t=100) must still be live.
    vi.advanceTimersByTime(350);
    expect(root.classList.contains('mc-phase-fade')).toBe(true);
    expect(() => {
      vi.advanceTimersByTime(500);
    }).not.toThrow();
    expect(root.classList.contains('mc-phase-fade')).toBe(false);
    root.remove();
  });

  it('ignores an animationend event bubbling up from an unrelated child element (negative)', () => {
    vi.useFakeTimers();
    const ctrl = makeSpyController();
    registerPhase('lobby', ctrl);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');
    const decoy = document.createElement('div');
    root.appendChild(decoy);
    decoy.dispatchEvent(new Event('animationend', { bubbles: true }));

    expect(root.classList.contains('mc-phase-fade')).toBe(true);
    vi.advanceTimersByTime(500);
    root.remove();
  });
});

describe('phase-transition motion — wipe overlay', () => {
  it("creates a mc-phase-wipe overlay positioned to match the router root's box on phase mount (normal)", () => {
    vi.useFakeTimers();
    const ctrl = makeSpyController();
    registerPhase('lobby', ctrl);
    const root = document.createElement('div');
    document.body.appendChild(root);
    root.getBoundingClientRect = () =>
      ({ top: 10, left: 20, width: 300, height: 150, bottom: 160, right: 320, x: 20, y: 10, toJSON: () => ({}) }) as DOMRect;
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');

    const overlay = document.body.querySelector('.mc-phase-wipe') as HTMLElement | null;
    expect(overlay).not.toBeNull();
    expect(overlay!.style.top).toBe('10px');
    expect(overlay!.style.left).toBe('20px');
    expect(overlay!.style.width).toBe('300px');
    expect(overlay!.style.height).toBe('150px');
    // D13: a body-level sibling of root, never a descendant of it.
    expect(overlay!.parentElement).toBe(document.body);
    expect(root.contains(overlay)).toBe(false);

    // D15: a router built on a detached root arms no fade and no overlay.
    const detachedRoot = document.createElement('div');
    const detachedRouter = createPhaseRouter(detachedRoot, fakeCtx);
    detachedRouter.onPhase('hide');
    expect(detachedRoot.classList.contains('mc-phase-fade')).toBe(false);
    expect(document.body.querySelectorAll('.mc-phase-wipe').length).toBe(1);

    vi.advanceTimersByTime(500);
    root.remove();
  });

  it('removes the mc-phase-wipe overlay once its own animationend fires (normal)', () => {
    vi.useFakeTimers();
    const ctrl = makeSpyController();
    registerPhase('lobby', ctrl);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');
    const overlay = document.body.querySelector('.mc-phase-wipe');
    expect(overlay).not.toBeNull();
    overlay!.dispatchEvent(new Event('animationend'));

    expect(document.body.querySelector('.mc-phase-wipe')).toBeNull();
    vi.advanceTimersByTime(500);
    root.remove();
  });

  it('removes the mc-phase-wipe overlay via its own fallback timeout when animationend never fires (boundary)', () => {
    vi.useFakeTimers();
    const ctrl = makeSpyController();
    registerPhase('lobby', ctrl);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');
    expect(document.body.querySelector('.mc-phase-wipe')).not.toBeNull();
    vi.advanceTimersByTime(500);

    expect(document.body.querySelector('.mc-phase-wipe')).toBeNull();
    root.remove();
  });

  it('creates exactly one mc-phase-wipe overlay per rapid successive phase switch, never two at once (boundary)', () => {
    vi.useFakeTimers();
    const first = makeSpyController();
    const second = makeSpyController();
    registerPhase('lobby', first);
    registerPhase('hide', second);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');
    vi.advanceTimersByTime(100);
    router.onPhase('hide');

    expect(document.body.querySelectorAll('.mc-phase-wipe').length).toBe(1);
    vi.advanceTimersByTime(500);
    expect(document.body.querySelectorAll('.mc-phase-wipe').length).toBe(0);
    root.remove();
  });

  it('creates no mc-phase-wipe overlay when prefers-reduced-motion is set (boundary)', () => {
    vi.useFakeTimers();
    stubReducedMotion(true);
    const ctrl = makeSpyController();
    registerPhase('lobby', ctrl);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const router = createPhaseRouter(root, fakeCtx);

    router.onPhase('lobby');

    expect(document.body.querySelector('.mc-phase-wipe')).toBeNull();
    vi.advanceTimersByTime(500);
    root.remove();
  });
});

describe('phase-fade CSS safety (source-text wiring check, D3/R13)', () => {
  // Honest label: this reads client/src/fx/fx.css as text and checks the
  // .mc-phase-fade rule + its keyframe declare no containing-block-creating
  // property. It is a wiring/regression guard, not a runtime DOM assertion —
  // jsdom has no real layout engine to prove containing-block behavior.
  it('declares no transform/filter/perspective/backdrop-filter/contain/will-change/container-type on .mc-phase-fade or its keyframe (normal)', () => {
    const testFileDir = dirname(fileURLToPath(import.meta.url));
    const cssPath = resolve(testFileDir, '../src/fx/fx.css');
    const raw = readFileSync(cssPath, 'utf8');
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, ''); // CSS has no line comments, so this is unambiguous

    const startAnchor = '.mc-phase-fade {';
    const endAnchor = '.mc-phase-wipe {';
    const startIdx = css.indexOf(startAnchor);
    const endIdx = css.indexOf(endAnchor);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);

    const slice = css.slice(startIdx, endIdx);
    expect(slice.length).toBeGreaterThan(0);
    expect(slice).toContain('opacity'); // sanity: slice is non-empty and holds a known token, not vacuous

    const forbidden = /\btransform\b|\bfilter\b|\bperspective\b|\bbackdrop-filter\b|\bcontain\b|\bwill-change\b|\bcontainer-type\b/;
    expect(slice).not.toMatch(forbidden);
  });
});
