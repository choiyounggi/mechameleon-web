import { describe, expect, it } from 'vitest';
import type { CaptureErrorCode } from '../src/lobby/capture-client';
import { captureErrorMessage } from '../src/lobby/capture-messages';

describe('captureErrorMessage', () => {
  it('tells the player the page itself refused (403/404) instead of blaming the capture (normal)', () => {
    expect(captureErrorMessage('TARGET_HTTP_ERROR')).toContain('페이지가 열리지 않아요');
  });

  it('gives every known code its own copy — no two codes share a message (error)', () => {
    const codes: CaptureErrorCode[] = ['INVALID_URL', 'CAPTURE_FAILED', 'TARGET_HTTP_ERROR', 'INVALID_IMAGE'];
    const messages = codes.map(captureErrorMessage);
    expect(new Set(messages).size).toBe(codes.length);
  });

  it('falls back to the generic retry copy for UNKNOWN (boundary)', () => {
    expect(captureErrorMessage('UNKNOWN')).toBe('잠시 후 다시 시도');
  });
});
