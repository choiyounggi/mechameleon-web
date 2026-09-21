import { afterEach, describe, expect, it, vi } from 'vitest';

describe('DEFAULT_BRUSH_COLOR (D5): resolves through canvasToken at module-import time, once', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--color-ink-soft');
  });

  it('resolves from --color-ink-soft when set before the module is first imported (normal)', async () => {
    document.documentElement.style.setProperty('--color-ink-soft', 'oklch(75% 0.02 100)');
    vi.resetModules();

    const { DEFAULT_BRUSH_COLOR } = await import('../src/hide/paint');

    expect(DEFAULT_BRUSH_COLOR).toBe('oklch(75% 0.02 100)');
  });

  it('falls back to the exact current literal when --color-ink-soft is unset at import time (boundary)', async () => {
    vi.resetModules();

    const { DEFAULT_BRUSH_COLOR } = await import('../src/hide/paint');

    expect(DEFAULT_BRUSH_COLOR).toBe('#8a8a8a');
  });

  it('falls back to the exact current literal when --color-ink-soft is a self-referential cycle at import time (error: malformed token value)', async () => {
    document.documentElement.style.setProperty('--color-ink-soft', 'var(--color-ink-soft)');
    vi.resetModules();

    const { DEFAULT_BRUSH_COLOR } = await import('../src/hide/paint');

    expect(DEFAULT_BRUSH_COLOR).toBe('#8a8a8a');
  });
});
