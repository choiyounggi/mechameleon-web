const DEFAULT_COLORS = [
  'var(--color-paint-red)',
  'var(--color-paint-orange)',
  'var(--color-paint-yellow)',
  'var(--color-paint-green)',
  'var(--color-paint-cyan)',
  'var(--color-paint-violet)',
];
const DEFAULT_PARTICLE_COUNT = 8;
const DEFAULT_PARTICLE_SIZE = 10;
const PARTICLE_REMOVE_TIMEOUT_MS = 1500;
const DEFAULT_SHAKE_INTENSITY_PX = 4;
const DEFAULT_SHAKE_DURATION_MS = 350;
const PRESS_BURST_COUNT = 5;
const PRESS_BURST_SIZE = 6;

export interface PaintBurstOptions {
  colors?: string[];
  count?: number;
  parent?: HTMLElement;
  sizePx?: number;
}

export interface ShakeOptions {
  intensityPx?: number;
  durationMs?: number;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function paintBurst(x: number, y: number, opts: PaintBurstOptions = {}): void {
  const count = opts.count ?? DEFAULT_PARTICLE_COUNT;
  if (count <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) return;
  if (prefersReducedMotion()) return;

  const parent = opts.parent ?? document.body;
  const colors = opts.colors ?? DEFAULT_COLORS;
  const sizePx = opts.sizePx ?? DEFAULT_PARTICLE_SIZE;

  for (let i = 0; i < count; i += 1) {
    const particle = document.createElement('div');
    particle.className = 'mc-splat-particle';
    const angle = (i / count) * Math.PI * 2;
    const distance = sizePx * (1.5 + Math.random());
    particle.style.position = 'absolute';
    particle.style.left = `${x}px`;
    particle.style.top = `${y}px`;
    particle.style.width = `${sizePx}px`;
    particle.style.height = `${sizePx}px`;
    particle.style.marginLeft = `${-sizePx / 2}px`;
    particle.style.marginTop = `${-sizePx / 2}px`;
    particle.style.borderRadius = '50%';
    particle.style.pointerEvents = 'none';
    particle.style.background = colors[i % colors.length];
    particle.style.setProperty('--mc-splat-dx', `${Math.cos(angle) * distance}px`);
    particle.style.setProperty('--mc-splat-dy', `${Math.sin(angle) * distance}px`);
    particle.style.animation = 'mc-splat 500ms ease-out forwards';

    const remove = (): void => {
      particle.remove();
    };
    particle.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, PARTICLE_REMOVE_TIMEOUT_MS);

    parent.appendChild(particle);
  }
}

export function screenShake(el: HTMLElement, opts: ShakeOptions = {}): void {
  if (prefersReducedMotion()) return;

  const intensityPx = opts.intensityPx ?? DEFAULT_SHAKE_INTENSITY_PX;
  const durationMs = opts.durationMs ?? DEFAULT_SHAKE_DURATION_MS;

  el.style.setProperty('--mc-shake-intensity', `${intensityPx}px`);
  el.style.setProperty('--mc-shake-duration', `${durationMs}ms`);
  el.classList.add('mc-shake');

  setTimeout(() => {
    el.classList.remove('mc-shake');
  }, durationMs);
}

export function attachPressFX(el: HTMLElement): () => void {
  let attached = true;

  const onPointerDown = (): void => {
    el.classList.remove('mc-squash');
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    el.offsetWidth; // force reflow so the animation restarts on rapid presses
    el.classList.add('mc-squash');
  };

  const onPointerUp = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    paintBurst(pointerEvent.clientX, pointerEvent.clientY, {
      count: PRESS_BURST_COUNT,
      sizePx: PRESS_BURST_SIZE,
    });
  };

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointerup', onPointerUp);

  return () => {
    if (!attached) return;
    attached = false;
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointerup', onPointerUp);
  };
}
