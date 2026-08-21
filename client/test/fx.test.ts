import { afterEach, describe, expect, it } from 'vitest';
import { attachPressFX, paintBurst, screenShake } from '../src/fx';

// jsdom has no PointerEvent constructor; fake clientX/clientY onto a plain
// Event the way a real pointerup PointerEvent would carry them.
function pointerEventAt(type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  return event;
}

// jsdom does not implement window.matchMedia at all, so fx's reduced-motion
// check (`typeof window.matchMedia === 'function'`) falls through to "not
// reduced" by default. Stub it to exercise the reduced-motion branch.
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

describe('reduced motion', () => {
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('paintBurst adds no particles when prefers-reduced-motion is set (normal case)', () => {
    stubReducedMotion(true);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    paintBurst(10, 20, { count: 5, parent });

    expect(parent.querySelectorAll('.mc-splat-particle').length).toBe(0);
  });

  it('screenShake does not add the mc-shake class when prefers-reduced-motion is set (normal case)', () => {
    stubReducedMotion(true);
    const el = document.createElement('div');
    document.body.appendChild(el);

    screenShake(el);

    expect(el.classList.contains('mc-shake')).toBe(false);
  });

  it('paintBurst still bursts when prefers-reduced-motion is explicitly false (boundary case)', () => {
    stubReducedMotion(false);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    paintBurst(10, 20, { count: 3, parent });

    expect(parent.querySelectorAll('.mc-splat-particle').length).toBe(3);
  });
});

describe('paintBurst', () => {
  it('adds `count` particles to the given parent (normal case)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    paintBurst(10, 20, { count: 4, parent });

    expect(parent.querySelectorAll('.mc-splat-particle').length).toBe(4);
  });

  it('removes each particle once its splat animation ends (normal case)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    paintBurst(10, 20, { count: 2, parent });
    const particles = parent.querySelectorAll('.mc-splat-particle');
    expect(particles.length).toBe(2);

    particles.forEach((particle) => particle.dispatchEvent(new Event('animationend')));

    expect(parent.querySelectorAll('.mc-splat-particle').length).toBe(0);
  });

  it('is a no-op when count is zero or negative (error case)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    paintBurst(10, 20, { count: 0, parent });
    paintBurst(10, 20, { count: -3, parent });

    expect(parent.querySelectorAll('.mc-splat-particle').length).toBe(0);
  });

  it('is a no-op when x or y is not a finite number (error case)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    paintBurst(NaN, 20, { count: 3, parent });
    paintBurst(10, Infinity, { count: 3, parent });

    expect(parent.querySelectorAll('.mc-splat-particle').length).toBe(0);
  });

  it('appends to document.body when no parent is given (boundary case)', () => {
    const before = document.body.querySelectorAll('.mc-splat-particle').length;

    paintBurst(0, 0, { count: 1 });

    expect(document.body.querySelectorAll('.mc-splat-particle').length).toBe(before + 1);
  });
});

describe('screenShake', () => {
  it('toggles the mc-shake class onto the element (normal case)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    screenShake(el);

    expect(el.classList.contains('mc-shake')).toBe(true);
  });

  it('removes the mc-shake class after the shake duration elapses (boundary case)', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    screenShake(el, { durationMs: 5 });
    expect(el.classList.contains('mc-shake')).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(el.classList.contains('mc-shake')).toBe(false);
  });
});

describe('attachPressFX', () => {
  it('plays the squash animation on pointerdown and bursts paint on pointerup (normal case)', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    const bodyBefore = document.body.querySelectorAll('.mc-splat-particle').length;

    attachPressFX(button);
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(button.classList.contains('mc-squash')).toBe(true);

    button.dispatchEvent(pointerEventAt('pointerup', 42, 24));
    expect(document.body.querySelectorAll('.mc-splat-particle').length).toBeGreaterThan(bodyBefore);
  });

  it('stops reacting to pointer events once detached (normal case)', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);

    const detach = attachPressFX(button);
    detach();

    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(button.classList.contains('mc-squash')).toBe(false);
  });

  it('is safe to call the returned detach function twice (boundary case)', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);

    const detach = attachPressFX(button);

    expect(() => {
      detach();
      detach();
    }).not.toThrow();
  });
});
