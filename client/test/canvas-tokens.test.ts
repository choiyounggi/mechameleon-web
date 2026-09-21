import { afterEach, describe, expect, it } from 'vitest';
import { canvasToken, canvasTokenOpen, closeAlpha } from '../src/render/canvas-tokens';

const root = document.documentElement;

afterEach(() => {
  root.style.cssText = '';
});

describe('canvasToken', () => {
  it('returns the computed value of a defined custom property', () => {
    root.style.setProperty('--x', 'oklch(50% 0.1 200)');
    expect(canvasToken('--x', '#000')).toBe('oklch(50% 0.1 200)');
  });

  it('falls back when the property is set to an empty value', () => {
    root.style.setProperty('--x', '');
    expect(canvasToken('--x', '#000')).toBe('#000');
  });

  it('falls back when the property was never set', () => {
    expect(canvasToken('--never-set', '#000')).toBe('#000');
  });

  it('falls back when doc is null even if the property is set on the real document', () => {
    root.style.setProperty('--x', 'oklch(50% 0.1 200)');
    expect(canvasToken('--x', '#000', null)).toBe('#000');
  });

  it('resolves a single var() alias to the aliased literal', () => {
    root.style.setProperty('--color-accent', 'oklch(86% 0.28 140)');
    root.style.setProperty('--color-go', 'var(--color-accent)');
    expect(canvasToken('--color-go', '#000')).toBe('oklch(86% 0.28 140)');
  });

  it('resolves a two-hop alias chain', () => {
    root.style.setProperty('--a', 'var(--b)');
    root.style.setProperty('--b', 'var(--c)');
    root.style.setProperty('--c', 'oklch(10% 0 0)');
    expect(canvasToken('--a', '#000')).toBe('oklch(10% 0 0)');
  });

  it('falls back when an alias points at an undefined property', () => {
    root.style.setProperty('--a', 'var(--b)');
    expect(canvasToken('--a', '#000')).toBe('#000');
  });

  it('falls back on an alias cycle instead of looping', () => {
    root.style.setProperty('--a', 'var(--b)');
    root.style.setProperty('--b', 'var(--a)');
    expect(canvasToken('--a', '#000')).toBe('#000');
  });

  it('falls back when the alias chain exceeds the 8-hop bound', () => {
    for (let n = 0; n < 9; n++) {
      root.style.setProperty(`--c${n}`, `var(--c${n + 1})`);
    }
    root.style.setProperty('--c9', 'oklch(10% 0 0)');
    expect(canvasToken('--c0', '#000')).toBe('#000');
    // the walk reads at most 8 properties: --c1 needs 9 reads (falls back), --c2 needs exactly 8 (resolves)
    expect(canvasToken('--c1', '#000')).toBe('#000');
    expect(canvasToken('--c2', '#000')).toBe('oklch(10% 0 0)');
  });
});

describe('canvasTokenOpen', () => {
  it('strips exactly one trailing ) from the resolved value', () => {
    root.style.setProperty('--x', 'oklch(50% 0.1 200)');
    expect(canvasTokenOpen('--x', '#000')).toBe('oklch(50% 0.1 200');
  });

  it('returns an already-open fallback unchanged', () => {
    expect(canvasTokenOpen('--never-set', 'oklch(10% 0 0')).toBe('oklch(10% 0 0');
  });

  it('opens the fallback when doc is null', () => {
    expect(canvasTokenOpen('--x', 'oklch(10% 0 0)', null)).toBe('oklch(10% 0 0');
  });
});

describe('closeAlpha', () => {
  it('appends the alpha and closes the colour', () => {
    expect(closeAlpha('oklch(50% 0.1 200', 0.5)).toBe('oklch(50% 0.1 200 / 0.5)');
  });

  it('keeps alpha 0 at the lower bound', () => {
    expect(closeAlpha('oklch(50% 0.1 200', 0)).toBe('oklch(50% 0.1 200 / 0)');
  });

  it('keeps alpha 1 at the upper bound', () => {
    expect(closeAlpha('oklch(50% 0.1 200', 1)).toBe('oklch(50% 0.1 200 / 1)');
  });

  it('clamps an alpha above 1 down to 1', () => {
    expect(closeAlpha('oklch(50% 0.1 200', 1.5)).toBe('oklch(50% 0.1 200 / 1)');
  });

  it('clamps a negative alpha up to 0', () => {
    expect(closeAlpha('oklch(50% 0.1 200', -0.3)).toBe('oklch(50% 0.1 200 / 0)');
  });

  it('treats a NaN alpha as opaque', () => {
    expect(closeAlpha('oklch(50% 0.1 200', NaN)).toBe('oklch(50% 0.1 200 / 1)');
  });

  it('does not double-close an already-closed colour', () => {
    expect(closeAlpha('oklch(50% 0.1 200)', 0.5)).toBe('oklch(50% 0.1 200 / 0.5)');
  });
});
