import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomStatePublic } from 'shared/protocol';
import type { AppContext } from '../src/net';
import { createLobbyController } from '../src/lobby';

function makeRoom(overrides: Partial<RoomStatePublic> = {}): RoomStatePublic {
  return {
    code: 'ABCDEF',
    phase: 'lobby',
    players: [
      { id: 'host-1', nickname: 'host', isHost: true },
      { id: 'guest-1', nickname: 'guest', isHost: false },
    ],
    background: null,
    endsAt: null,
    ...overrides,
  };
}

function makeHostCtx(room: RoomStatePublic): AppContext {
  return {
    socket: {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as AppContext['socket'],
    state: {
      playerId: 'host-1',
      role: null,
      room,
      hidePayload: null,
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('lobby capture flow', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('on a successful capture, calls setBackground (via socket ack) and shows the preview (normal)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { imageUrl: '/api/screenshots/abc.png', width: 1440, height: 900 }),
    );
    const room = makeRoom();
    const ctx = makeHostCtx(room);
    (ctx.socket.emit as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, req: unknown, ack?: (res: unknown) => void) => {
        if (event === 'room:setBackground' && typeof ack === 'function') ack({ ok: true });
      },
    );
    const controller = createLobbyController();
    const root = document.createElement('div');

    controller.mount(root, ctx);
    const urlInput = root.querySelector<HTMLInputElement>('input[aria-label="배경 URL"]')!;
    urlInput.value = 'https://example.com/doc';
    const captureBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '가져오기')!;
    captureBtn.click();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    // flush the microtask chain triggered by the click handler
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledWith('/api/capture', expect.objectContaining({ method: 'POST' }));
    expect(ctx.socket.emit).toHaveBeenCalledWith(
      'room:setBackground',
      { background: { imageUrl: '/api/screenshots/abc.png', width: 1440, height: 900 } },
      expect.any(Function),
    );
    const preview = root.querySelector('img[alt="배경 미리보기"]');
    expect(preview).not.toBeNull();
    expect(root.textContent).toContain('1440×900');

    controller.unmount();
  });

  it('on a 502 CAPTURE_FAILED response, shows the exact D6 error copy and the upload fallback (error)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { error: { code: 'CAPTURE_FAILED' } }));
    const ctx = makeHostCtx(makeRoom());
    const controller = createLobbyController();
    const root = document.createElement('div');

    controller.mount(root, ctx);
    const captureBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '가져오기')!;
    captureBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(root.textContent).toContain('이 페이지는 캡처가 안 돼요 — 파일 업로드를 사용하세요');
    expect(root.querySelector('input[type="file"]')).not.toBeNull();

    controller.unmount();
  });

  it('keeps the capture button disabled for the whole in-flight request, then re-enables it once it resolves (boundary)', async () => {
    let resolveFetch!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const ctx = makeHostCtx(makeRoom());
    const controller = createLobbyController();
    const root = document.createElement('div');

    controller.mount(root, ctx);
    const findCaptureBtn = () =>
      Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('가져오')) as
        | HTMLButtonElement
        | undefined;

    findCaptureBtn()!.click();
    expect(findCaptureBtn()!.disabled).toBe(true);
    expect(findCaptureBtn()!.textContent).toBe('가져오는 중…');

    // a second click while in-flight must not issue a second fetch (single in-flight policy)
    findCaptureBtn()!.click();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse(200, { imageUrl: '/x.png', width: 10, height: 10 }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(findCaptureBtn()!.disabled).toBe(false);

    controller.unmount();
  });
});

function makeCtxAs(playerId: string, room: RoomStatePublic): AppContext {
  return {
    socket: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as AppContext['socket'],
    state: { playerId, role: null, room, hidePayload: null },
  };
}

describe('lobby capture section visibility', () => {
  it('never renders the capture URL input/button for a non-host (host-only gate)', () => {
    const ctx = makeCtxAs('guest-1', makeRoom());
    const controller = createLobbyController();
    const root = document.createElement('div');

    controller.mount(root, ctx);

    expect(root.querySelector('input[aria-label="배경 URL"]')).toBeNull();
    expect(Array.from(root.querySelectorAll('button')).some((b) => b.textContent === '가져오기')).toBe(false);

    controller.unmount();
  });
});

describe('lobby start button', () => {
  it('disables start for a non-host even with enough players and a background set (host-only gate)', () => {
    const room = makeRoom({ background: { imageUrl: '/x.png', width: 10, height: 10 } });
    const ctx = makeCtxAs('guest-1', room);
    const controller = createLobbyController();
    const root = document.createElement('div');

    controller.mount(root, ctx);
    const startBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '시작')!;

    expect(startBtn.disabled).toBe(true);

    controller.unmount();
  });

  it('enables start once the host has >= MIN_PLAYERS players and a background set (normal)', () => {
    const room = makeRoom({ background: { imageUrl: '/x.png', width: 10, height: 10 } });
    const ctx = makeCtxAs('host-1', room); // 2 players, matches MIN_PLAYERS
    const controller = createLobbyController();
    const root = document.createElement('div');

    controller.mount(root, ctx);
    const startBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '시작')!;

    expect(startBtn.disabled).toBe(false);

    controller.unmount();
  });

  it('disables start for the host when fewer than MIN_PLAYERS players are in the room (boundary: player count)', () => {
    const room = makeRoom({
      players: [{ id: 'host-1', nickname: 'host', isHost: true }],
      background: { imageUrl: '/x.png', width: 10, height: 10 },
    });
    const ctx = makeCtxAs('host-1', room);
    const controller = createLobbyController();
    const root = document.createElement('div');

    controller.mount(root, ctx);
    const startBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '시작')!;

    expect(startBtn.disabled).toBe(true);

    controller.unmount();
  });

  it('disables start for the host when no background has been set yet (boundary: no background)', () => {
    const room = makeRoom({ background: null });
    const ctx = makeCtxAs('host-1', room);
    const controller = createLobbyController();
    const root = document.createElement('div');

    controller.mount(root, ctx);
    const startBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '시작')!;

    expect(startBtn.disabled).toBe(true);

    controller.unmount();
  });
});
