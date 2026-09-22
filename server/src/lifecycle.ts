// contract: t1-crash-guard owns the implementation
// Shutdown closer registry. t2-browser-lifecycle registers Chromium's
// closeBrowser() here; index.ts's shutdown awaits runClosers() before
// engine.shutdown(). Signatures are the cross-task contract — do not change
// them without a plan-gap report to the coordinator.

export function registerCloser(name: string, close: () => Promise<void>): void {
  throw new Error(`contract stub: registerCloser(${name}) — t1-crash-guard implements this; ${typeof close}`);
}

export function runClosers(timeoutMs: number): Promise<void> {
  throw new Error(`contract stub: runClosers(${timeoutMs}) — t1-crash-guard implements this`);
}
