import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottled } from '../src/util/throttle';

describe('createThrottled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the first call immediately (leading edge)', () => {
    const fn = vi.fn();
    const { send } = createThrottled(fn, 100);

    send('a');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('collapses calls within one 100ms window into a leading send + one trailing send', () => {
    const fn = vi.fn();
    const { send } = createThrottled(fn, 100);

    send('a');
    vi.advanceTimersByTime(20);
    send('b');
    vi.advanceTimersByTime(20);
    send('c');
    vi.advanceTimersByTime(20);
    send('d');

    // still inside the 100ms window from the leading call: only the leading send fired
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);

    // trailing call fires with the latest args, not every intermediate call
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('d');
  });

  it('cancel() drops a pending trailing call', () => {
    const fn = vi.fn();
    const { send, cancel } = createThrottled(fn, 100);

    send('a');
    send('b');
    cancel();
    vi.advanceTimersByTime(200);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });
});
