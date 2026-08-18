import { describe, expect, it } from 'vitest';
import { clampCaptureHeight, gotoWithRetry, type Navigable } from '../src/capture/screenshotter';

describe('clampCaptureHeight', () => {
  it('returns the scroll height unchanged when within bounds', () => {
    expect(clampCaptureHeight(2200)).toBe(2200);
  });

  it('floors a very short page to the minimum height (900)', () => {
    expect(clampCaptureHeight(200)).toBe(900);
  });

  it('caps a very tall page at the maximum height (15000)', () => {
    expect(clampCaptureHeight(50_000)).toBe(15000);
  });
});

interface GotoCall {
  url: string;
  options: { waitUntil: 'networkidle' | 'domcontentloaded'; timeout: number };
}

describe('gotoWithRetry', () => {
  it('navigates once and returns when the primary attempt succeeds', async () => {
    const calls: GotoCall[] = [];
    const fake: Navigable = {
      async goto(url, options) {
        calls.push({ url, options });
      },
    };

    await gotoWithRetry(fake, 'https://example.com');

    expect(calls).toEqual([
      { url: 'https://example.com', options: { waitUntil: 'networkidle', timeout: 15000 } },
    ]);
  });

  it('retries once with a looser wait condition and shorter timeout after the primary attempt fails', async () => {
    const calls: GotoCall[] = [];
    let attempt = 0;
    const fake: Navigable = {
      async goto(url, options) {
        calls.push({ url, options });
        attempt++;
        if (attempt === 1) throw new Error('primary nav timeout');
      },
    };

    await gotoWithRetry(fake, 'https://example.com');

    expect(calls).toEqual([
      { url: 'https://example.com', options: { waitUntil: 'networkidle', timeout: 15000 } },
      { url: 'https://example.com', options: { waitUntil: 'domcontentloaded', timeout: 10000 } },
    ]);
  });

  it('throws when both the primary and retry navigation fail', async () => {
    const fake: Navigable = {
      async goto() {
        throw new Error('nav failed');
      },
    };

    await expect(gotoWithRetry(fake, 'https://example.com')).rejects.toThrow('nav failed');
  });
});
