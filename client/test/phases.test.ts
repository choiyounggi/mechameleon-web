import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/net';
import { createPhaseRouter, getPhase, registerPhase, resolvePhaseChange } from '../src/phases';
import type { PhaseController } from '../src/phases';

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

describe('resolvePhaseChange', () => {
  it('switches when the phase differs (normal)', () => {
    expect(resolvePhaseChange(null, 'lobby')).toBe('switch');
    expect(resolvePhaseChange('lobby', 'hide')).toBe('switch');
  });

  it('does nothing when the phase repeats (boundary)', () => {
    expect(resolvePhaseChange('hide', 'hide')).toBe('none');
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
});
