import { describe, expect, it } from 'vitest';
import { withConcurrencyLimit, type CaptureResult, type Screenshotter } from '../src/capture/screenshotter';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every currently-queued microtask run before the test continues. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeResult(tag: string): CaptureResult {
  return { png: Buffer.from(tag), width: 1440, height: 900 };
}

function fakeScreenshotterOf(deferreds: Record<string, Deferred<CaptureResult>>): {
  screenshotter: Screenshotter;
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    screenshotter: {
      capture(url: string) {
        order.push(url);
        return deferreds[url].promise;
      },
    },
  };
}

describe('withConcurrencyLimit', () => {
  it('runs up to the limit concurrently', async () => {
    const deferreds = { a: deferred<CaptureResult>(), b: deferred<CaptureResult>() };
    const { screenshotter, order } = fakeScreenshotterOf(deferreds);
    const limited = withConcurrencyLimit(screenshotter, 2);

    const pA = limited.capture('a');
    const pB = limited.capture('b');
    await flush();

    expect(order).toEqual(['a', 'b']);

    deferreds.a.resolve(fakeResult('a'));
    deferreds.b.resolve(fakeResult('b'));
    await expect(pA).resolves.toEqual(fakeResult('a'));
    await expect(pB).resolves.toEqual(fakeResult('b'));
  });

  it('queues a 3rd call and starts it only after one of the first two resolves (FIFO)', async () => {
    const deferreds = {
      a: deferred<CaptureResult>(),
      b: deferred<CaptureResult>(),
      c: deferred<CaptureResult>(),
    };
    const { screenshotter, order } = fakeScreenshotterOf(deferreds);
    const limited = withConcurrencyLimit(screenshotter, 2);

    const pA = limited.capture('a');
    const pB = limited.capture('b');
    const pC = limited.capture('c');
    await flush();

    expect(order).toEqual(['a', 'b']);

    deferreds.a.resolve(fakeResult('a'));
    await pA;
    await flush();

    expect(order).toEqual(['a', 'b', 'c']);

    deferreds.b.resolve(fakeResult('b'));
    deferreds.c.resolve(fakeResult('c'));
    await expect(pB).resolves.toEqual(fakeResult('b'));
    await expect(pC).resolves.toEqual(fakeResult('c'));
  });

  it('lets the next queued call run even when the slot ahead of it rejects', async () => {
    const deferreds = {
      a: deferred<CaptureResult>(),
      b: deferred<CaptureResult>(),
      c: deferred<CaptureResult>(),
    };
    const { screenshotter, order } = fakeScreenshotterOf(deferreds);
    const limited = withConcurrencyLimit(screenshotter, 2);

    const pA = limited.capture('a');
    const pB = limited.capture('b');
    const pC = limited.capture('c');
    await flush();

    deferreds.a.reject(new Error('boom'));
    await expect(pA).rejects.toThrow('boom');
    await flush();

    expect(order).toEqual(['a', 'b', 'c']);

    deferreds.b.resolve(fakeResult('b'));
    deferreds.c.resolve(fakeResult('c'));
    await expect(pB).resolves.toEqual(fakeResult('b'));
    await expect(pC).resolves.toEqual(fakeResult('c'));
  });
});
