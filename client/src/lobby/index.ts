import type { Background } from 'shared/protocol';
import { MIN_PLAYERS } from 'shared/protocol';
import type { AppContext } from '../net';
import { createRoom, joinRoom, setBackground, startGame } from '../net';
import type { PhaseController } from '../phases';
import { registerPhase } from '../phases';
import { requestCaptureFromUpload, requestCaptureFromUrl } from './capture-client';
import { captureErrorMessage } from './capture-messages';

type CaptureUiState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; background: Background }
  | { status: 'error'; message: string };

function isHost(ctx: AppContext): boolean {
  const players = ctx.state.room?.players ?? [];
  return players.find((p) => p.id === ctx.state.playerId)?.isHost ?? false;
}

export function createLobbyController(): PhaseController {
  let cleanup: (() => void) | null = null;

  return {
    mount(root: HTMLElement, ctx: AppContext) {
      let captureState: CaptureUiState = { status: 'idle' };

      function render(): void {
        root.innerHTML = '';
        root.appendChild(ctx.state.playerId && ctx.state.room ? renderRoomScreen() : renderJoinScreen());
      }

      function renderJoinScreen(): HTMLElement {
        const wrap = document.createElement('div');

        const nicknameInput = document.createElement('input');
        nicknameInput.type = 'text';
        nicknameInput.placeholder = '이름';
        nicknameInput.setAttribute('aria-label', '닉네임');

        const createBtn = document.createElement('button');
        createBtn.type = 'button';
        createBtn.textContent = '만들기';
        createBtn.addEventListener('click', () => {
          void handleCreate(nicknameInput.value);
        });

        const codeInput = document.createElement('input');
        codeInput.type = 'text';
        codeInput.placeholder = '코드';
        codeInput.setAttribute('aria-label', '방 코드');

        const joinBtn = document.createElement('button');
        joinBtn.type = 'button';
        joinBtn.textContent = '입장';
        joinBtn.addEventListener('click', () => {
          void handleJoin(codeInput.value, nicknameInput.value);
        });

        wrap.append(nicknameInput, createBtn, codeInput, joinBtn);
        return wrap;
      }

      async function handleCreate(nickname: string): Promise<void> {
        const res = await createRoom(ctx, nickname);
        if (res.ok) {
          ctx.state.playerId = res.playerId;
        }
        render();
      }

      async function handleJoin(code: string, nickname: string): Promise<void> {
        const res = await joinRoom(ctx, code, nickname);
        if (res.ok) {
          ctx.state.playerId = res.playerId;
        }
        render();
      }

      function renderRoomScreen(): HTMLElement {
        const wrap = document.createElement('div');
        const room = ctx.state.room!;

        const codeEl = document.createElement('div');
        codeEl.textContent = `코드: ${room.code}`;
        wrap.appendChild(codeEl);

        const list = document.createElement('ul');
        for (const p of room.players) {
          const li = document.createElement('li');
          li.textContent = p.isHost ? `${p.nickname} (host)` : p.nickname;
          list.appendChild(li);
        }
        wrap.appendChild(list);

        const host = isHost(ctx);
        if (host) {
          wrap.appendChild(renderCaptureSection());
        }

        const startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.textContent = '시작';
        const canStart = host && room.players.length >= MIN_PLAYERS && room.background !== null;
        startBtn.disabled = !canStart;
        startBtn.addEventListener('click', () => {
          void startGame(ctx);
        });
        wrap.appendChild(startBtn);

        return wrap;
      }

      function renderCaptureSection(): HTMLElement {
        const wrap = document.createElement('div');

        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.placeholder = 'https://...';
        urlInput.setAttribute('aria-label', '배경 URL');

        const captureBtn = document.createElement('button');
        captureBtn.type = 'button';
        captureBtn.textContent = captureState.status === 'loading' ? '가져오는 중…' : '가져오기';
        captureBtn.disabled = captureState.status === 'loading';
        captureBtn.addEventListener('click', () => {
          void handleCapture(urlInput.value);
        });
        wrap.append(urlInput, captureBtn);

        if (captureState.status === 'success') {
          const preview = document.createElement('img');
          preview.src = captureState.background.imageUrl;
          preview.alt = '배경 미리보기';
          const dims = document.createElement('span');
          dims.textContent = `${captureState.background.width}×${captureState.background.height}`;
          wrap.append(preview, dims);
        }

        if (captureState.status === 'error') {
          const err = document.createElement('div');
          err.textContent = captureState.message;
          wrap.appendChild(err);

          const retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.textContent = '다시 시도';
          retryBtn.addEventListener('click', () => {
            void handleCapture(urlInput.value);
          });
          wrap.appendChild(retryBtn);

          const uploadLabel = document.createElement('label');
          uploadLabel.textContent = '파일 업로드';
          const uploadInput = document.createElement('input');
          uploadInput.type = 'file';
          uploadInput.accept = 'image/png,image/jpeg';
          uploadInput.setAttribute('aria-label', '파일 업로드');
          uploadInput.addEventListener('change', () => {
            const file = uploadInput.files?.[0];
            if (file) void handleUpload(file);
          });
          uploadLabel.appendChild(uploadInput);
          wrap.appendChild(uploadLabel);
        }

        return wrap;
      }

      async function handleCapture(url: string): Promise<void> {
        if (captureState.status === 'loading') return; // single in-flight (D6)
        captureState = { status: 'loading' };
        render();
        const result = await requestCaptureFromUrl(url);
        await applyCaptureResult(result);
      }

      async function handleUpload(file: File): Promise<void> {
        if (captureState.status === 'loading') return; // single in-flight (D6)
        captureState = { status: 'loading' };
        render();
        const result = await requestCaptureFromUpload(file);
        await applyCaptureResult(result);
      }

      async function applyCaptureResult(
        result: Awaited<ReturnType<typeof requestCaptureFromUrl>>,
      ): Promise<void> {
        if (result.ok) {
          captureState = { status: 'success', background: result.background };
          render();
          await setBackground(ctx, result.background);
        } else {
          captureState = { status: 'error', message: captureErrorMessage(result.code) };
          render();
        }
      }

      function onRoomState(): void {
        render();
      }
      ctx.socket.on('room:state', onRoomState);
      cleanup = () => ctx.socket.off('room:state', onRoomState);

      render();
    },
    unmount() {
      cleanup?.();
      cleanup = null;
    },
  };
}

export const lobbyController = createLobbyController();
registerPhase('lobby', lobbyController);
