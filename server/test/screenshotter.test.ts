import { describe, expect, it } from 'vitest';
import {
  clampCaptureHeight,
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
