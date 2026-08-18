import type { Background } from 'shared/protocol';

export type CaptureErrorCode = 'INVALID_URL' | 'CAPTURE_FAILED' | 'INVALID_IMAGE' | 'UNKNOWN';

export type CaptureResult = { ok: true; background: Background } | { ok: false; code: CaptureErrorCode };

const KNOWN_CODES: readonly CaptureErrorCode[] = ['INVALID_URL', 'CAPTURE_FAILED', 'INVALID_IMAGE'];

async function parseCaptureResponse(res: Response): Promise<CaptureResult> {
  if (res.ok) {
    const data = (await res.json()) as { imageUrl: string; width: number; height: number };
    return { ok: true, background: { imageUrl: data.imageUrl, width: data.width, height: data.height } };
  }
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  const code = body?.error?.code;
  if (code && (KNOWN_CODES as readonly string[]).includes(code)) {
    return { ok: false, code: code as CaptureErrorCode };
  }
  return { ok: false, code: 'UNKNOWN' };
}

export async function requestCaptureFromUrl(url: string): Promise<CaptureResult> {
  const res = await fetch('/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return parseCaptureResponse(res);
}

export async function requestCaptureFromUpload(file: File): Promise<CaptureResult> {
  const form = new FormData();
  form.append('image', file);
  const res = await fetch('/api/upload', { method: 'POST', body: form });
  return parseCaptureResponse(res);
}
