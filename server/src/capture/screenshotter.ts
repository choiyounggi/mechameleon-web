import { chromium, type Browser } from 'playwright';

export interface CaptureResult {
  png: Buffer;
  width: number;
  height: number;
}

export interface Screenshotter {
  capture(url: string): Promise<CaptureResult>;
}

const VIEWPORT_WIDTH = 1440;
const MIN_HEIGHT = 900;
const MAX_HEIGHT = 15000;
const PRIMARY_TIMEOUT_MS = 15000;
const RETRY_TIMEOUT_MS = 10000;

// page.evaluate() below runs inside the browser page, not this Node process,
// so `document` is real at runtime -- this server package has no "dom" lib,
// hence the minimal local ambient shape instead of widening tsconfig.
declare const document: { documentElement: { scrollHeight: number } };

// D2: single chromium instance for the process lifetime, lazily launched and
// cached on the module scope so concurrent first-callers share one launch.
let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch();
  }
  return browserPromise;
}

// Narrow structural subset of playwright's Page -- lets gotoWithRetry (and its
// tests) depend on just the one method it needs, instead of a real browser.
export interface Navigable {
  goto(url: string, options: { waitUntil: 'networkidle' | 'domcontentloaded'; timeout: number }): Promise<unknown>;
}

// D3: one retry with a shorter timeout and a looser wait condition; if that
// also fails the error propagates to the caller (mapped to 502 CAPTURE_FAILED).
export async function gotoWithRetry(page: Navigable, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: PRIMARY_TIMEOUT_MS });
  } catch {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RETRY_TIMEOUT_MS });
  }
}

// D4: pure clamp, extracted so the height-cap arithmetic is unit-testable
// without a real page.
export function clampCaptureHeight(scrollHeight: number): number {
  return Math.min(Math.max(scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
}

export const playwrightScreenshotter: Screenshotter = {
  async capture(url: string): Promise<CaptureResult> {
    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: MIN_HEIGHT },
      deviceScaleFactor: 1,
    });
    try {
      const page = await context.newPage();
      await gotoWithRetry(page, url);

      // D4: width is fixed; height is the page's real scroll height, floored
      // at the viewport height and capped so a pathological page can't
      // produce an unbounded screenshot.
      const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const height = clampCaptureHeight(scrollHeight);

      const png = await page.screenshot({
        clip: { x: 0, y: 0, width: VIEWPORT_WIDTH, height },
      });
      return { png, width: VIEWPORT_WIDTH, height };
    } finally {
      await context.close();
    }
  },
};

// D5: bound concurrent captures to `limit`; excess requests wait in FIFO
// order instead of being rejected. Kept as a Screenshotter wrapper so it
// composes independently of the router and of the underlying implementation.
export function withConcurrencyLimit(s: Screenshotter, limit = 2): Screenshotter {
  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  function release(): void {
    const next = queue.shift();
    if (next) {
      next();
    } else {
      active--;
    }
  }

  return {
    async capture(url: string): Promise<CaptureResult> {
      await acquire();
      try {
        return await s.capture(url);
      } finally {
        release();
      }
    },
  };
}
