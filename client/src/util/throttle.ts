// Leading+trailing throttle (D4): the first call in a window fires immediately;
// calls while a window is open collapse into one trailing call with the latest
// args, fired when the window elapses.
export interface Throttled<Args extends unknown[]> {
  send: (...args: Args) => void;
  cancel: () => void;
}

export function createThrottled<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): Throttled<Args> {
  let lastCallTime = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Args | null = null;

  function invoke(args: Args): void {
    lastCallTime = Date.now();
    fn(...args);
  }

  function send(...args: Args): void {
    const elapsed = Date.now() - lastCallTime;
    if (elapsed >= waitMs) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingArgs = null;
      invoke(args);
      return;
    }
    pendingArgs = args;
    if (!timer) {
      const remaining = waitMs - elapsed;
      timer = setTimeout(() => {
        timer = null;
        if (pendingArgs) {
          const toSend = pendingArgs;
          pendingArgs = null;
          invoke(toSend);
        }
      }, remaining);
    }
  }

  function cancel(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingArgs = null;
  }

  return { send, cancel };
}
