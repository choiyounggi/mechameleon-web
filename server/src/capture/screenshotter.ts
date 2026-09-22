import { chromium, type Browser } from 'playwright';
import { isPublicUrl } from './url-guard';

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
// so `document`/`window` are real at runtime -- this server package has no
// "dom" lib, hence the minimal local ambient shapes instead of widening tsconfig.
declare const document: { documentElement: { scrollHeight: number } };
declare const window: { innerHeight: number; scrollTo(x: number, y: number): void };

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
  goto(
    url: string,
    options: { waitUntil: 'networkidle' | 'domcontentloaded'; timeout: number },
  ): Promise<{ status(): number } | null>;
}

// The target answered, but not with a page worth hiding in: a 403 "access
// denied" or 404 body screenshots just fine, and once did — the game ran on a
// picture of an error page. Distinct from a navigation failure so the router
// can tell the player what actually happened.
export class TargetHttpError extends Error {
  constructor(public readonly status: number) {
    super(`target responded with HTTP ${status}`);
    this.name = 'TargetHttpError';
  }
}

function assertOk(response: { status(): number } | null): void {
  // goto() resolves null only for same-document navigations, which an http(s)
  // entry URL never is — treat it as "could not verify" and refuse.
  const status = response?.status() ?? 0;
  if (status < 200 || status > 299) throw new TargetHttpError(status);
}

// D3: one retry with a shorter timeout and a looser wait condition; if that
// also fails the error propagates to the caller (mapped to 502 CAPTURE_FAILED).
// A non-2xx answer is final — the server has spoken — so it is not retried.
export async function gotoWithRetry(page: Navigable, url: string): Promise<void> {
  let response: { status(): number } | null;
  try {
    response = await page.goto(url, { waitUntil: 'networkidle', timeout: PRIMARY_TIMEOUT_MS });
  } catch {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RETRY_TIMEOUT_MS });
  }
  assertOk(response);
}

const MAX_REDIRECT_HOPS = 5;

// Structural subsets of playwright's Route / APIResponse, so guardRoute can be
// driven by fakes in tests the same way gotoWithRetry is.
export interface HopResponse {
  status(): number;
  headers(): { [key: string]: string };
  body(): Promise<Buffer>;
}
export interface HopFetch {
  (url: string, init: { method: string; headers: { [key: string]: string }; data?: Buffer }): Promise<HopResponse>;
}
export interface GuardableRoute {
  request(): { url(): string; method(): string; headers(): { [key: string]: string }; postDataBuffer(): Buffer | null };
  abort(errorCode: 'blockedbyclient' | 'failed'): Promise<void>;
  fulfill(options: { status: number; headers: { [key: string]: string }; body: Buffer }): Promise<void>;
}

// Every hop of a redirect chain is checked with isPublicUrl before it is
// fetched, because the browser would otherwise follow a 3xx into this host or
// the LAN without ever consulting route(). The browser is never handed a
// redirect of its own to follow (that follow-up would be unrouted too): the
// final response is served for the original request. Relative links then
// resolve against the entry URL instead of the final one, and each of those
// simply walks the same guarded chain again.
export async function guardRoute(route: GuardableRoute, fetch: HopFetch): Promise<void> {
  try {
    const request = route.request();
    let url = request.url();
    for (let hop = 0; ; hop++) {
      if (!(await isPublicUrl(new URL(url)))) {
        return await route.abort('blockedbyclient');
      }
      const response = await fetch(url, {
        method: request.method(),
        headers: request.headers(),
        data: request.postDataBuffer() ?? undefined,
      });
      const status = response.status();
      const headers = { ...response.headers() };
      const location = headers['location'];
      if (status < 300 || status > 399 || !location) {
        // The fetch already decoded the body; a stale content-encoding would
        // make Chromium try to decode plaintext and drop the resource.
        delete headers['content-encoding'];
        delete headers['content-length'];
        return await route.fulfill({ status, headers, body: await response.body() });
      }
      if (hop >= MAX_REDIRECT_HOPS) {
        return await route.abort('blockedbyclient');
      }
      url = new URL(location, url).toString();
    }
  } catch {
    await route.abort('failed').catch(() => undefined);
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
      // A service worker's fetches bypass context.route() entirely.
      serviceWorkers: 'block',
    });
    try {
      // The router already vetted the entry URL; this covers what happens
      // after it -- redirects, iframes, images -- so a public page cannot pull
      // this host's or the LAN's services into the screenshot. Chromium never
      // asks route() about a redirect hop, so guardRoute follows redirects
      // itself. WebSockets are outside route() too; a capture target has no
      // business opening one.
      await context.routeWebSocket('**', (ws) => ws.close());
      await context.route('**/*', (route) =>
        guardRoute(route, (url, init) => context.request.fetch(url, { ...init, maxRedirects: 0 })),
      );
      const page = await context.newPage();
      await gotoWithRetry(page, url);

      // Walk down the page once before capturing: lazy-loaded content below
      // the first viewport never renders otherwise, which left everything
      // under the fold blank in the screenshot. Capped a little above
      // MAX_HEIGHT so infinite-scroll pages can't keep us walking forever.
      await page.evaluate(async (maxY: number) => {
        for (
          let y = 0;
          y < Math.min(document.documentElement.scrollHeight, maxY);
          y += window.innerHeight
        ) {
          window.scrollTo(0, y);
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        window.scrollTo(0, 0);
      }, MAX_HEIGHT);

      // D4: width is fixed; height is the page's real scroll height, floored
      // at the viewport height and capped so a pathological page can't
      // produce an unbounded screenshot.
      const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const height = clampCaptureHeight(scrollHeight);

      // The viewport must cover the whole capture area: Chromium leaves
      // off-viewport regions unpainted, so clipping beyond the default 900px
      // viewport produced blank pixels below the fold.
      await page.setViewportSize({ width: VIEWPORT_WIDTH, height });
      await page.waitForTimeout(300); // let the resized page settle/repaint

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
