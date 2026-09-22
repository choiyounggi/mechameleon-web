import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { safeHandler } from '../src/sockets';
import {
  createShutdown,
  healthzHandler,
  installFatalHandlers,
  registerCloser,
  runClosers,
  wireShutdownSignals,
} from '../src/lifecycle';

describe('safeHandler', () => {
  it('runs the handler normally and leaves its ack call unchanged', () => {
    const ack = vi.fn();
    const wrapped = safeHandler('room:create', (req: { a: number }, cb: (r: unknown) => void) => {
      cb({ ok: true, a: req.a });
    });
    wrapped({ a: 1 }, ack);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true, a: 1 });
  });

  it('acks INTERNAL exactly once and logs when the handler throws and an ack is present', () => {
    const ack = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapped = safeHandler('room:create', () => {
      throw new Error('boom');
    });
    wrapped({}, ack);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: false, code: 'INTERNAL' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('logs and does not throw when the handler throws with no ack argument (boundary)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapped = safeHandler('hide:update', () => {
      throw new Error('boom');
    });
    expect(() => wrapped({})).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

describe('registerCloser / runClosers', () => {
  it('runs closers in registration order', async () => {
    const order: string[] = [];
    registerCloser('a', async () => { order.push('a'); });
    registerCloser('b', async () => { order.push('b'); });
    await runClosers(50);
    expect(order).toEqual(['a', 'b']);
  });

  it('logs a rejecting closer and still runs the next one (error path)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const order: string[] = [];
    registerCloser('bad', async () => { throw new Error('nope'); });
    registerCloser('good', async () => { order.push('good'); });
    await runClosers(50);
    expect(order).toEqual(['good']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('does not let a closer exceeding the timeout block runClosers past it', async () => {
    const order: string[] = [];
    registerCloser('slow', () => new Promise<void>(() => {}));
    registerCloser('after', async () => { order.push('after'); });
    const start = Date.now();
    await runClosers(30);
    expect(order).toEqual(['after']);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('resolves immediately with zero registered closers (boundary)', async () => {
    const start = Date.now();
    await runClosers(1000);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe('healthzHandler', () => {
  it('responds 200 with { ok: true }', () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    healthzHandler({} as never, { status } as never);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true });
  });
});

type FakeProc = { on: NodeJS.Process['on']; exit: NodeJS.Process['exit'] } & {
  emit: (event: string, ...args: unknown[]) => void;
};

function makeFakeProc(): FakeProc {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const proc = {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return proc;
    },
    exit: (_code?: number) => undefined as never,
    emit: (event: string, ...args: unknown[]) => {
      listeners.get(event)?.(...args);
    },
  };
  return proc as unknown as FakeProc;
}

describe('installFatalHandlers', () => {
  it('logs the stack and exits 1 on uncaughtException', () => {
    const proc = makeFakeProc();
    const exitSpy = vi.spyOn(proc, 'exit');
    const log = vi.fn();
    installFatalHandlers(proc, log);
    const err = new Error('boom');
    proc.emit('uncaughtException', err);
    expect(log).toHaveBeenCalledWith('[fatal] uncaughtException', err);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs and exits 1 on unhandledRejection with an Error reason (error path)', () => {
    const proc = makeFakeProc();
    const exitSpy = vi.spyOn(proc, 'exit');
    const log = vi.fn();
    installFatalHandlers(proc, log);
    const reason = new Error('rejected');
    proc.emit('unhandledRejection', reason);
    expect(log).toHaveBeenCalledWith('[fatal] unhandledRejection', reason);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('still logs and exits 1 when the rejection reason is not an Error (boundary)', () => {
    const proc = makeFakeProc();
    const exitSpy = vi.spyOn(proc, 'exit');
    const log = vi.fn();
    installFatalHandlers(proc, log);
    proc.emit('unhandledRejection', 'a plain string reason');
    expect(log).toHaveBeenCalledWith('[fatal] unhandledRejection', 'a plain string reason');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('createShutdown', () => {
  it('runs io.close -> httpServer.close -> runClosers -> engine.shutdown -> exit(0) in order', async () => {
    const order: string[] = [];
    const deps = {
      io: { close: (cb: () => void) => { order.push('io'); cb(); } },
      httpServer: { close: (cb: () => void) => { order.push('httpServer'); cb(); } },
      engine: { shutdown: () => { order.push('engine'); } },
      runClosers: async (_ms: number) => { order.push('runClosers'); },
      exit: (code: number) => { order.push(`exit(${code})`); },
    };
    const shutdown = createShutdown(deps);
    shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['io', 'httpServer', 'runClosers', 'engine', 'exit(0)']);
  });

  it('force-exits with code 1 if httpServer.close never calls back (hang/error path)', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const deps = {
      io: { close: (cb: () => void) => cb() },
      httpServer: { close: (_cb: () => void) => { /* never calls cb: simulates a hang */ } },
      engine: { shutdown: vi.fn() },
      runClosers: async (_ms: number) => {},
      exit,
      forceExitMs: 5_000,
    };
    try {
      const shutdown = createShutdown(deps);
      shutdown('SIGTERM');
      vi.advanceTimersByTime(5_000);
      expect(exit).toHaveBeenCalledWith(1);
      expect(deps.engine.shutdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('calling the returned function twice only runs the sequence once (boundary)', async () => {
    let calls = 0;
    const deps = {
      io: { close: (cb: () => void) => cb() },
      httpServer: { close: (cb: () => void) => cb() },
      engine: { shutdown: () => { calls += 1; } },
      runClosers: async (_ms: number) => {},
      exit: () => {},
    };
    const shutdown = createShutdown(deps);
    shutdown('SIGTERM');
    shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
  });
});

describe('wireShutdownSignals', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('calls shutdown(%s) exactly once when that signal fires', (signal) => {
    const proc = makeFakeProc();
    const shutdown = vi.fn();
    wireShutdownSignals(proc, shutdown);
    proc.emit(signal);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith(signal);
  });
});

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LAUNCHD_DIR = path.join(REPO_ROOT, 'ops', 'launchd');
const SCRATCH_ROOT = path.join(REPO_ROOT, '.claude', 'tmp');

function makeScratchDir(name: string): string {
  const dir = path.join(SCRATCH_ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeFakeLaunchctl(binDir: string, markerFile: string): void {
  const scriptPath = path.join(binDir, 'launchctl');
  writeFileSync(scriptPath, '#!/bin/sh\necho "$@" >> "' + markerFile + '"\n');
  chmodSync(scriptPath, 0o755);
}

describe('fake launchctl (positive control for the marker assertions below)', () => {
  it('records an invocation made through the shadowed PATH, so an absent marker means "never called"', () => {
    const runId = `fake-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const binDir = makeScratchDir(`install-${runId}-bin`);
    const marker = path.join(binDir, 'launchctl.calls');
    makeFakeLaunchctl(binDir, marker);
    try {
      // PATH holds ONLY the fake, so the real /bin/launchctl is unreachable here.
      execFileSync('/bin/bash', ['-c', 'launchctl bootstrap probe'], { env: { PATH: binDir } });
      expect(readFileSync(marker, 'utf8')).toBe('bootstrap probe\n');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe('ops/launchd/install.sh --dry-run', () => {
  it('renders both plists with no placeholders, valid per plutil, KeepAlive/RunAtLoad true, log paths under ~/Library/Logs/mechameleon/, and never invokes launchctl', () => {
    const runId = `install-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const renderDir = makeScratchDir(`${runId}-render`);
    const binDir = makeScratchDir(`${runId}-bin`);
    const marker = path.join(binDir, 'launchctl.calls');
    makeFakeLaunchctl(binDir, marker);
    try {
      execFileSync('bash', [path.join(LAUNCHD_DIR, 'install.sh'), '--dry-run', renderDir], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      });

      const serverPlist = path.join(renderDir, 'com.mechameleon.server.plist');
      const cloudflaredPlist = path.join(renderDir, 'com.mechameleon.cloudflared.plist');
      expect(existsSync(serverPlist)).toBe(true);
      expect(existsSync(cloudflaredPlist)).toBe(true);

      for (const plist of [serverPlist, cloudflaredPlist]) {
        const content = readFileSync(plist, 'utf8');
        expect(content).not.toMatch(/__[A-Z_]+__/);
        expect(() => execFileSync('plutil', ['-lint', plist])).not.toThrow();
        expect(content).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
        expect(content).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
        expect(content).toMatch(/<key>StandardOutPath<\/key>\s*<string>[^<]*\/Library\/Logs\/mechameleon\/[^<]*<\/string>/);
        expect(content).toMatch(/<key>StandardErrorPath<\/key>\s*<string>[^<]*\/Library\/Logs\/mechameleon\/[^<]*<\/string>/);
      }

      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(renderDir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe('ops/launchd/*.sh never actually invoke launchctl (source check)', () => {
  // A comment line (first non-blank character '#') executes nothing, and
  // the header comments in both scripts document the "never calls
  // launchctl" invariant using the word itself -- exclude comment lines
  // before checking that every remaining launchctl-mentioning line is
  // print-only, or the header comments themselves would false-fail this
  // check (caught by a worker adoption check, re-plan round 2).
  // Returns every non-comment line naming launchctl, and the subset that is not
  // a plain echo/printf -- i.e. anything that could actually run it.
  function launchctlLinesOf(scriptPath: string): { mentioning: string[]; notPrintOnly: string[] } {
    const mentioning = readFileSync(scriptPath, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#') && line.includes('launchctl'));
    const notPrintOnly = mentioning.filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('echo') || trimmed.startsWith('printf'));
    });
    return { mentioning, notPrintOnly };
  }

  it('every non-comment launchctl-mentioning line in install.sh is print-only, including absolute-path invocations', () => {
    const { mentioning, notPrintOnly } = launchctlLinesOf(path.join(LAUNCHD_DIR, 'install.sh'));
    expect(mentioning.length).toBeGreaterThan(0);
    expect(notPrintOnly).toEqual([]);
  });

  it('every non-comment launchctl-mentioning line in uninstall.sh is print-only, including absolute-path invocations', () => {
    const { mentioning, notPrintOnly } = launchctlLinesOf(path.join(LAUNCHD_DIR, 'uninstall.sh'));
    expect(mentioning.length).toBeGreaterThan(0);
    expect(notPrintOnly).toEqual([]);
  });
});

describe('ops/launchd/uninstall.sh', () => {
  function setupTargetDir(name: string): string {
    const dir = makeScratchDir(name);
    writeFileSync(path.join(dir, 'com.mechameleon.server.plist'), '<plist/>');
    writeFileSync(path.join(dir, 'com.mechameleon.cloudflared.plist'), '<plist/>');
    return dir;
  }

  it('removes both plists with --yes and never invokes launchctl (normal)', () => {
    const runId = `uninstall-normal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const targetDir = setupTargetDir(`${runId}-target`);
    const binDir = makeScratchDir(`${runId}-bin`);
    const marker = path.join(binDir, 'launchctl.calls');
    makeFakeLaunchctl(binDir, marker);
    try {
      const output = execFileSync(
        'bash',
        [path.join(LAUNCHD_DIR, 'uninstall.sh'), '--yes', '--target-dir', targetDir],
        { env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }, encoding: 'utf8' },
      );
      expect(existsSync(path.join(targetDir, 'com.mechameleon.server.plist'))).toBe(false);
      expect(existsSync(path.join(targetDir, 'com.mechameleon.cloudflared.plist'))).toBe(false);
      expect(output).toContain('launchctl bootout');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('leaves both plists in place when confirmation is declined (error/negative path)', () => {
    const runId = `uninstall-decline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const targetDir = setupTargetDir(`${runId}-target`);
    try {
      execFileSync('bash', [path.join(LAUNCHD_DIR, 'uninstall.sh'), '--target-dir', targetDir], {
        input: 'n\n',
        encoding: 'utf8',
      });
      expect(existsSync(path.join(targetDir, 'com.mechameleon.server.plist'))).toBe(true);
      expect(existsSync(path.join(targetDir, 'com.mechameleon.cloudflared.plist'))).toBe(true);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('exits 0 and removes nothing when the target dir has no rendered plists (boundary)', () => {
    const runId = `uninstall-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const targetDir = makeScratchDir(`${runId}-target`);
    try {
      const output = execFileSync(
        'bash',
        [path.join(LAUNCHD_DIR, 'uninstall.sh'), '--yes', '--target-dir', targetDir],
        { encoding: 'utf8' },
      );
      expect(output).toContain('nothing to remove');
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
