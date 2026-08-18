import type { CaptureErrorCode } from './capture-client';

// D6 error copy, verbatim.
export function captureErrorMessage(code: CaptureErrorCode): string {
  switch (code) {
    case 'INVALID_URL':
      return '주소를 확인해 주세요';
    case 'CAPTURE_FAILED':
      return '이 페이지는 캡처가 안 돼요 — 파일 업로드를 사용하세요';
    default:
      return '잠시 후 다시 시도';
  }
}
