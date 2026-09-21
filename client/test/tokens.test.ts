import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.resolve(__dirname, '../src/tokens.css'), 'utf-8');

// Every custom-property name referenced via var() under client/src — must stay defined.
const KEPT_TOKENS = [
  '--color-card',
  '--color-danger',
  '--color-focus',
  '--color-go',
  '--color-hint',
  '--color-ink',
  '--color-ink-soft',
  '--color-ink-strong',
  '--color-keycap',
  '--color-line',
  '--color-paint-cyan',
  '--color-paint-green',
  '--color-paint-orange',
  '--color-paint-red',
  '--color-paint-violet',
  '--color-paint-yellow',
  '--color-paper',
  '--dur-quick',
  '--ease-out',
  '--font-body',
  '--font-display',
  '--font-numeral',
  '--radius-card',
  '--radius-chip',
  '--space-lg',
  '--space-md',
  '--space-sm',
  '--space-xl',
  '--space-xs',
];

describe('tokens.css', () => {
  it('defines the original-game palette, fonts and accent aliases', () => {
    expect(css).toContain('--color-card: oklch(');
    expect(css).toContain('--color-accent: oklch(');
    expect(css).toContain('--color-danger: oklch(');
    expect(css).toContain('--color-mint: oklch(');
    expect(css).toContain('--color-code: oklch(');
    expect(css).toContain('--color-brick: oklch(');
    expect(css).toContain("--font-display: 'Jua'");
    expect(css).toContain("--font-body: 'Gothic A1'");
    expect(css).toContain("--font-numeral: 'Fredoka'");
    expect(css).toContain('--color-go: var(--color-accent)');
    expect(css).toContain('--color-focus: var(--color-accent)');
    expect(css).toContain('--color-keycap: var(--color-mint)');
  });

  it('no longer references any retired font family', () => {
    expect(css).not.toContain('Black Han Sans');
    expect(css).not.toContain('IBM Plex Sans KR');
    expect(css).not.toContain('Playfair Display');
  });

  it('keeps every custom property referenced under client/src defined', () => {
    expect(KEPT_TOKENS).toHaveLength(29);
    for (const name of KEPT_TOKENS) {
      expect(css.includes(`${name}:`), `${name} must stay defined`).toBe(true);
    }
  });
});
