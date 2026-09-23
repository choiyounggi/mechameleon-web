import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import {
  TargetHttpError,
  _getBrowserForTests,
  _resetBrowserStateForTests,
  _setBrowserLauncherForTests,
  _setCloserRegistrarForTests,
  clampCaptureHeight,
  closeBrowser,
  gotoWithRetry,
  guardRoute,
  type GuardableRoute,
  type HopFetch,
  type HopResponse,
  type Navigable,
} from '../src/capture/screenshotter';

// Literal public IPs keep isPublicUrl off real DNS.
const PUBLIC_A = 'http://8.8.8.8/start';
const PUBLIC_B = 'http://1.1.1.1/next';
const INTERNAL = 'http://127.0.0.1:8642/';

function hop(status: number, location?: string, extraHeaders: { [key: string]: string } = {}): HopResponse {
  return {
    status: () => status,
    headers: () => (location ? { location, ...extraHeaders } : extraHeaders),
    body: () => Promise.resolve(Buffer.from(`body-of-${status}`)),
  };
}

function fakeRoute(url: string) {
  const calls: { abort: string[]; fulfill: unknown[] } = { abort: [], fulfill: [] };
  const route: GuardableRoute = {
    request: () => ({ url: () => url, method: () => 'GET', headers: () => ({}), postDataBuffer: () => null }),
    async abort(code) {
      calls.abort.push(code);
    },
    async fulfill(options) {
      calls.fulfill.push(options);
    },
  };
  return { route, calls };
}

// Scripted fetch: answers hop by hop and records every URL it was asked for.
function scriptedFetch(responses: HopResponse[]) {
  const fetched: string[] = [];
  const fetch: HopFetch = async (url) => {
    fetched.push(url);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch of ${url}`);
    return next;
  };
  return { fetch, fetched };
}

describe('guardRoute', () => {
  it('fulfills a non-redirecting public request with its decoded body and no stale encoding headers', async () => {
    const { route, calls } = fakeRoute(PUBLIC_A);
    const ok = hop(200, undefined, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': '999' });
    const { fetch, fetched } = scriptedFetch([ok]);

    await guardRoute(route, fetch);

    expect(fetched).toEqual([PUBLIC_A]);
    expect(calls.fulfill).toEqual([{ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('body-of-200') }]);
    expect(calls.abort).toEqual([]);
  });

  it('aborts before fetching when the entry URL itself is private', async () => {
    const { route, calls } = fakeRoute(INTERNAL);
    const { fetch, fetched } = scriptedFetch([]);

    await guardRoute(route, fetch);

    expect(fetched).toEqual([]);
    expect(calls.abort).toEqual(['blockedbyclient']);
    expect(calls.fulfill).toEqual([]);
  });

  it('aborts a public URL that redirects to a private one and never fetches the private hop', async () => {
    const { route, calls } = fakeRoute(PUBLIC_A);
    const { fetch, fetched } = scriptedFetch([hop(302, INTERNAL)]);

    await guardRoute(route, fetch);

    expect(fetched).toEqual([PUBLIC_A]);
    expect(calls.abort).toEqual(['blockedbyclient']);
    expect(calls.fulfill).toEqual([]);
  });

  it('resolves a relative Location against the current hop and blocks it when private', async () => {
    const { route, calls } = fakeRoute(PUBLIC_A);
    const { fetch, fetched } = scriptedFetch([hop(301, '//127.0.0.1:8642/x')]);

    await guardRoute(route, fetch);

    expect(fetched).toEqual([PUBLIC_A]);
    expect(calls.abort).toEqual(['blockedbyclient']);
  });

  it('follows a public->public chain itself and serves the final response for the original request (no browser-side redirect)', async () => {
    const { route, calls } = fakeRoute(PUBLIC_A);
    const { fetch, fetched } = scriptedFetch([hop(302, PUBLIC_B), hop(200)]);

    await guardRoute(route, fetch);

    expect(fetched).toEqual([PUBLIC_A, PUBLIC_B]);
    expect(calls.fulfill).toEqual([{ status: 200, headers: {}, body: Buffer.from('body-of-200') }]);
    expect(calls.abort).toEqual([]);
  });

  it('aborts a redirect loop after the hop cap (boundary)', async () => {
    const { route, calls } = fakeRoute(PUBLIC_A);
    const { fetch, fetched } = scriptedFetch(Array.from({ length: 6 }, () => hop(302, PUBLIC_A)));

    await guardRoute(route, fetch);

    expect(fetched).toHaveLength(6);
    expect(calls.abort).toEqual(['blockedbyclient']);
    expect(calls.fulfill).toEqual([]);
  });

  it('treats a 3xx without a Location header as a final response', async () => {
    const { route, calls } = fakeRoute(PUBLIC_A);
    const noLocation = hop(304);
    const { fetch } = scriptedFetch([noLocation]);

    await guardRoute(route, fetch);

    expect(calls.fulfill).toEqual([{ status: 304, headers: {}, body: await noLocation.body() }]);
  });

  it('aborts with "failed" when the fetch throws (error path)', async () => {
    const { route, calls } = fakeRoute(PUBLIC_A);
    const fetch: HopFetch = () => Promise.reject(new Error('ECONNRESET'));

    await guardRoute(route, fetch);

    expect(calls.abort).toEqual(['failed']);
    expect(calls.fulfill).toEqual([]);
  });
});

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

const ok = { status: () => 200 };

describe('gotoWithRetry', () => {
  it('navigates once and returns when the primary attempt succeeds', async () => {
    const calls: GotoCall[] = [];
    const fake: Navigable = {
      async goto(url, options) {
        calls.push({ url, options });
        return ok;
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
        return ok;
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

  it('refuses a page that answers 403 and does not retry — an "access denied" body is not a background', async () => {
    const calls: GotoCall[] = [];
    const fake: Navigable = {
      async goto(url, options) {
        calls.push({ url, options });
        return { status: () => 403 };
      },
    };

    const err = await gotoWithRetry(fake, 'https://example.com').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TargetHttpError);
    expect((err as TargetHttpError).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it('refuses a non-2xx answer that only arrives on the retry attempt', async () => {
    let attempt = 0;
    const fake: Navigable = {
      async goto() {
        attempt++;
        if (attempt === 1) throw new Error('primary nav timeout');
        return { status: () => 503 };
      },
    };

    await expect(gotoWithRetry(fake, 'https://example.com')).rejects.toMatchObject({ status: 503 });
  });

  it('refuses when goto resolves null — the status cannot be verified (boundary)', async () => {
    const fake: Navigable = {
      async goto() {
        return null;
      },
    };

    await expect(gotoWithRetry(fake, 'https://example.com')).rejects.toMatchObject({ status: 0 });
  });

  it('accepts the 2xx boundaries (200 and 299) and rejects 199 and 300', async () => {
    const outcome = async (status: number) =>
      gotoWithRetry({ async goto() { return { status: () => status }; } }, 'https://example.com')
        .then(() => 'ok')
        .catch(() => 'refused');

    expect(await outcome(200)).toBe('ok');
    expect(await outcome(299)).toBe('ok');
    expect(await outcome(199)).toBe('refused');
    expect(await outcome(300)).toBe('refused');
  });
});

function makeFakeBrowser(onClose?: () => Promise<void>) {
  let disconnectHandler: (() => void) | undefined;
  const state = { closeCount: 0 };
  const fake = {
    on: (event: string, cb: () => void) => {
      if (event === 'disconnected') disconnectHandler = cb;
    },
    close: async () => {
      state.closeCount++;
      if (onClose) await onClose();
    },
  };
  return { browser: fake as unknown as Browser, disconnect: () => disconnectHandler?.(), state };
}

describe('browser lifecycle', () => {
  let registrarCalls: Array<[string, () => Promise<void>]>;

  beforeEach(() => {
    registrarCalls = [];
    _setCloserRegistrarForTests((name, close) => {
      registrarCalls.push([name, close]);
    });
  });

  afterEach(() => {
    _resetBrowserStateForTests();
  });

  it('launches once and reuses the same browser on a second call', async () => {
    let launchCount = 0;
    const { browser } = makeFakeBrowser();
    _setBrowserLauncherForTests(async () => {
      launchCount++;
      return browser;
    });

    const first = await _getBrowserForTests();
    const second = await _getBrowserForTests();

    expect(launchCount).toBe(1);
    expect(first).toBe(browser);
    expect(second).toBe(browser);
  });

  it('relaunches after a rejected launch (error path)', async () => {
    let launchCount = 0;
    const { browser } = makeFakeBrowser();
    _setBrowserLauncherForTests(async () => {
      launchCount++;
      if (launchCount === 1) throw new Error('binary missing');
      return browser;
    });

    await expect(_getBrowserForTests()).rejects.toThrow('binary missing');
    const second = await _getBrowserForTests();

    expect(launchCount).toBe(2);
    expect(second).toBe(browser);
  });

  it('logs a [capture]-prefixed message distinguishing a launch failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    _setBrowserLauncherForTests(async () => {
      throw new Error('binary missing');
    });

    await expect(_getBrowserForTests()).rejects.toThrow('binary missing');
    await Promise.resolve(); // let the reject side-chain's .catch run

    expect(errorSpy).toHaveBeenCalledWith('[capture] chromium launch failed:', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('relaunches after the live browser disconnects (normal)', async () => {
    let launchCount = 0;
    const first = makeFakeBrowser();
    const second = makeFakeBrowser();
    const browsers = [first.browser, second.browser];
    _setBrowserLauncherForTests(async () => {
      launchCount++;
      return browsers[launchCount - 1];
    });

    const gotFirst = await _getBrowserForTests();
    expect(gotFirst).toBe(first.browser);

    first.disconnect();
    const gotSecond = await _getBrowserForTests();

    expect(launchCount).toBe(2);
    expect(gotSecond).toBe(second.browser);
    expect(gotSecond).not.toBe(gotFirst);
  });

  it('ignores a stale disconnected event from a superseded browser (boundary)', async () => {
    let launchCount = 0;
    const oldBrowser = makeFakeBrowser();
    const newBrowser = makeFakeBrowser();
    const browsers = [oldBrowser.browser, newBrowser.browser];
    _setBrowserLauncherForTests(async () => {
      launchCount++;
      return browsers[launchCount - 1];
    });

    await _getBrowserForTests(); // launch 1 (oldBrowser)
    _resetBrowserStateForTests(); // simulates the cache being superseded before oldBrowser's own disconnected event fires
    const gotNew = await _getBrowserForTests(); // launch 2 (newBrowser)
    expect(gotNew).toBe(newBrowser.browser);

    oldBrowser.disconnect(); // stale event, arrives after newBrowser already replaced it

    const gotAfterStaleEvent = await _getBrowserForTests();
    expect(launchCount).toBe(2); // no third launch triggered by the stale event
    expect(gotAfterStaleEvent).toBe(newBrowser.browser);
  });

  it('registers the chromium closer exactly once across two launches', async () => {
    let launchCount = 0;
    const first = makeFakeBrowser();
    const second = makeFakeBrowser();
    const browsers = [first.browser, second.browser];
    _setBrowserLauncherForTests(async () => {
      launchCount++;
      return browsers[launchCount - 1];
    });

    await _getBrowserForTests();
    first.disconnect();
    await _getBrowserForTests();

    expect(launchCount).toBe(2);
    expect(registrarCalls).toHaveLength(1);
    expect(registrarCalls[0][0]).toBe('chromium');
    expect(registrarCalls[0][1]).toBe(closeBrowser);
  });

  it('closeBrowser() with no browser ever launched resolves without calling close', async () => {
    await expect(closeBrowser()).resolves.toBeUndefined();
  });

  it('closeBrowser() called twice calls the real close() once', async () => {
    const { browser, state } = makeFakeBrowser();
    _setBrowserLauncherForTests(async () => browser);
    await _getBrowserForTests();

    await closeBrowser();
    await closeBrowser();

    expect(state.closeCount).toBe(1);
  });

  it('closeBrowser() logs and still resolves when close() rejects (error path)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { browser } = makeFakeBrowser(async () => {
      throw new Error('close failed');
    });
    _setBrowserLauncherForTests(async () => browser);
    await _getBrowserForTests();

    await expect(closeBrowser()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[capture] closeBrowser failed:', expect.any(Error));
    errorSpy.mockRestore();
  });
});
