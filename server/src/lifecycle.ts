// Shutdown closer registry. t2-browser-lifecycle registers Chromium's
// closeBrowser() here; index.ts's shutdown awaits runClosers() before
// engine.shutdown(). Signatures are the cross-task contract — do not change
// them without a plan-gap report to the coordinator.
import type { Request, Response } from 'express';

interface Closer {
  name: string;
  close: () => Promise<void>;
}

let closers: Closer[] = [];

export function registerCloser(name: string, close: () => Promise<void>): void {
  closers.push({ name, close });
}

// Runs every closer registered so far, in registration order, each raced
// against its own `timeoutMs` deadline so one hung closer cannot block the
// rest. A rejection is logged and never stops the loop. The registry is
// drained, so a later call only runs closers registered since.
export async function runClosers(timeoutMs: number): Promise<void> {
  const toRun = closers;
  closers = [];
  for (const closer of toRun) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closer.close().catch((err) => {
        console.error(`[closer] ${closer.name} rejected`, err);
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }
}

export function healthzHandler(_req: Request, res: Response): void {
  res.status(200).json({ ok: true });
}


// uncaughtException/unhandledRejection are fatal: process state after an
// uncaught throw is undefined, so log with the stack and exit non-zero for the
// supervisor (launchd KeepAlive) to restart -- never resume serving.
export function installFatalHandlers(
  proc: { on: NodeJS.Process['on']; exit: NodeJS.Process['exit'] },
  log: (message: string, err: unknown) => void,
): void {
  proc.on('uncaughtException', (err) => {
    log('[fatal] uncaughtException', err);
    proc.exit(1);
  });
  proc.on('unhandledRejection', (reason) => {
    log('[fatal] unhandledRejection', reason);
    proc.exit(1);
  });
}

export interface ShutdownDeps {
  io: { close: (cb: () => void) => void };
  httpServer: { close: (cb: () => void) => void };
  engine: { shutdown: () => void };
  runClosers: (timeoutMs: number) => Promise<void>;
  exit: (code: number) => void;
  closerTimeoutMs?: number;
  forceExitMs?: number;
}

// io.close -> httpServer.close -> runClosers -> engine.shutdown -> exit(0),
// bounded by a force-exit timer. Repeat signals are ignored.
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  let started = false;
  return function shutdown(signal: string): void {
    if (started) return;
    started = true;
    console.log(`${signal} received, shutting down`);
    const forceExit = setTimeout(() => deps.exit(1), deps.forceExitMs ?? 5_000);
    forceExit.unref();

    deps.io.close(() => {
      deps.httpServer.close(() => {
        deps.runClosers(deps.closerTimeoutMs ?? 2_000).then(() => {
          deps.engine.shutdown();
          clearTimeout(forceExit);
          deps.exit(0);
        });
      });
    });
  };
}

export function wireShutdownSignals(
  proc: { on: NodeJS.Process['on'] },
  shutdown: (signal: string) => void,
): void {
  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('SIGINT', () => shutdown('SIGINT'));
}
