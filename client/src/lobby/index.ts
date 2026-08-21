import type { Background, ErrorCode, RoomSummary } from 'shared/protocol';
import { MIN_PLAYERS } from 'shared/protocol';
import type { AppContext } from '../net';
import { createRoom, joinRoom, listRooms, setBackground, startGame } from '../net';
import type { PhaseController } from '../phases';
import { registerPhase } from '../phases';
import { requestCaptureFromUpload, requestCaptureFromUrl } from './capture-client';
import { captureErrorMessage } from './capture-messages';
import { attachPressFX, paintBurst } from '../fx';

type CaptureUiState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; background: Background }
  | { status: 'error'; message: string };

const ROOM_LIST_POLL_MS = 3000;
const NICKNAME_STORAGE_KEY = 'mc-nickname';

function isHost(ctx: AppContext): boolean {
  const players = ctx.state.room?.players ?? [];
  return players.find((p) => p.id === ctx.state.playerId)?.isHost ?? false;
}

export function joinErrorMessage(code: ErrorCode): string {
  switch (code) {
    case 'WRONG_PASSWORD':
      return '비밀번호가 달라요';
    case 'ROOM_FULL':
      return '방이 가득 찼어요';
    case 'BAD_PHASE':
      return '이미 게임 중이에요';
    case 'ROOM_NOT_FOUND':
      return '방이 사라졌어요';
    default:
      return '입장할 수 없어요';
  }
}

/** A room-list row is clickable only while it is joinable. */
export function isJoinable(room: RoomSummary): boolean {
  return room.phase === 'lobby' && room.playerCount < room.maxPlayers;
}

// Studied-DNA mascot (Tier B hand-built SVG): the white blob with a doodle
// smile, one side already painted — the core MECCHA visual joke.
function mascotSvg(): string {
  return `
<svg width="72" height="88" viewBox="0 0 72 88" role="img" aria-label="위장 중인 마스코트" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="mc-blob"><path d="M36 4c14 0 22 10 22 24v34c0 14-8 22-22 22S14 76 14 62V28C14 14 22 4 36 4z"/></clipPath>
  </defs>
  <path d="M36 4c14 0 22 10 22 24v34c0 14-8 22-22 22S14 76 14 62V28C14 14 22 4 36 4z"
        fill="oklch(99% 0.004 90)" stroke="oklch(28% 0.03 60)" stroke-width="2.5"/>
  <g clip-path="url(#mc-blob)">
    <path d="M40 -2 L78 30 L78 92 L52 92 Z" fill="oklch(68% 0.16 145)" opacity="0.85"/>
    <path d="M48 -4 L60 6 L30 92 L22 92 Z" fill="oklch(76% 0.11 200)" opacity="0.6"/>
  </g>
  <circle cx="28" cy="30" r="2.6" fill="oklch(28% 0.03 60)"/>
  <circle cx="44" cy="30" r="2.6" fill="oklch(28% 0.03 60)"/>
  <path d="M26 40q10 8 20 0" fill="none" stroke="oklch(28% 0.03 60)" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;
}

// White stickman-silhouette mini icon for the in-room player list (design-dna:
// player counter). Decorative only — host status is conveyed via the chip's
// aria-label, not this glyph.
function playerSvg(): string {
  return `
<svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <circle cx="7" cy="4" r="3.6" fill="oklch(99% 0.004 90)"/>
  <path d="M7 8.8c-4.2 0-6.6 2.7-6.6 6.6v1.6h13.2v-1.6c0-3.9-2.4-6.6-6.6-6.6z" fill="oklch(99% 0.004 90)"/>
</svg>`;
}

const BUNTING_PAINTS = [
  'var(--color-paint-red)',
  'var(--color-paint-orange)',
  'var(--color-paint-yellow)',
  'var(--color-paint-green)',
  'var(--color-paint-cyan)',
  'var(--color-paint-violet)',
];

export function createLobbyController(): PhaseController {
  let cleanup: (() => void) | null = null;

  return {
    mount(root: HTMLElement, ctx: AppContext) {
      let captureState: CaptureUiState = { status: 'idle' };
      let rooms: RoomSummary[] = [];
      let creating = false;
      let isPrivate = false;
      let expandedCode: string | null = null;
      let joinError: string | null = null;
      let createError: string | null = null;
      let pollTimer: number | null = null;
      let titleAnimated = false;
      let pressFxDetachers: Array<() => void> = [];

      function withPressFX<T extends HTMLElement>(el: T): T {
        pressFxDetachers.push(attachPressFX(el));
        return el;
      }

      function nickname(): string {
        return (root.querySelector<HTMLInputElement>('input[aria-label="닉네임"]')?.value ?? '').trim();
      }

      function savedNickname(): string {
        try {
          return window.localStorage.getItem(NICKNAME_STORAGE_KEY) ?? '';
        } catch {
          return '';
        }
      }

      function saveNickname(value: string): void {
        try {
          window.localStorage.setItem(NICKNAME_STORAGE_KEY, value);
        } catch {
          /* private mode — non-fatal */
        }
      }

      function render(): void {
        // Detach the outgoing screen's press-FX listeners before it's discarded.
        pressFxDetachers.forEach((detach) => detach());
        pressFxDetachers = [];
        // Preserve in-progress inputs across re-renders.
        const keep = new Map<string, string>();
        for (const input of root.querySelectorAll<HTMLInputElement>('input[aria-label]')) {
          keep.set(input.getAttribute('aria-label')!, input.value);
        }
        root.innerHTML = '';
        root.appendChild(ctx.state.playerId && ctx.state.room ? renderRoomScreen() : renderHomeScreen());
        for (const input of root.querySelectorAll<HTMLInputElement>('input[aria-label]')) {
          const prev = keep.get(input.getAttribute('aria-label')!);
          if (prev !== undefined && input.value === '') input.value = prev;
        }
      }

      // ---- home: title · nickname · room list · create form ----------------

      function renderHomeScreen(): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'mc-home';

        const bunting = document.createElement('div');
        bunting.className = 'mc-bunting';
        bunting.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < 12; i++) {
          const flag = document.createElement('span');
          flag.style.borderTopColor = BUNTING_PAINTS[i % BUNTING_PAINTS.length];
          bunting.appendChild(flag);
        }
        wrap.appendChild(bunting);

        const titleRow = document.createElement('div');
        titleRow.className = 'mc-title';
        if (!titleAnimated) {
          titleRow.classList.add('mc-title-enter');
          titleAnimated = true;
        }
        const h1 = document.createElement('h1');
        h1.className = 'mc-title-paint';
        const titleText = '메차멜레온';
        [...titleText].forEach((ch) => {
          const span = document.createElement('span');
          span.textContent = ch;
          h1.appendChild(span);
        });
        const mascot = document.createElement('div');
        mascot.className = 'mc-mascot';
        mascot.innerHTML = mascotSvg();
        titleRow.append(h1, mascot);
        wrap.appendChild(titleRow);

        const tagline = document.createElement('p');
        tagline.className = 'mc-tagline';
        tagline.textContent = '배경색으로 위장해서 숨고, 동료의 눈을 피해 살아남으세요';
        wrap.appendChild(tagline);

        const nickRow = document.createElement('div');
        nickRow.className = 'mc-nick';
        const nickInput = document.createElement('input');
        nickInput.type = 'text';
        nickInput.placeholder = '이름';
        nickInput.maxLength = 12;
        nickInput.setAttribute('aria-label', '닉네임');
        nickInput.value = savedNickname();
        nickInput.addEventListener('change', () => saveNickname(nickInput.value.trim()));
        nickRow.appendChild(nickInput);
        wrap.appendChild(nickRow);

        const panels = document.createElement('div');
        panels.className = 'mc-panels';
        panels.append(renderRoomListPanel(), renderCreatePanel());
        wrap.appendChild(panels);

        return wrap;
      }

      function renderRoomListPanel(): HTMLElement {
        const panel = document.createElement('section');
        panel.className = 'mc-panel';
        const h2 = document.createElement('h2');
        h2.textContent = '방 목록';
        panel.appendChild(h2);

        if (rooms.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'mc-empty';
          empty.textContent = '아직 열린 방이 없어요 — 첫 방을 만들어 보세요';
          panel.appendChild(empty);
          return panel;
        }

        const list = document.createElement('ul');
        list.className = 'mc-room-list';
        for (const room of rooms) {
          const li = document.createElement('li');
          const card = document.createElement('button');
          card.type = 'button';
          card.className = 'mc-room-card';
          card.disabled = !isJoinable(room);

          const name = document.createElement('span');
          name.className = 'mc-room-name';
          name.textContent = room.name;

          const privacy = document.createElement('span');
          privacy.className = room.isPrivate ? 'mc-chip mc-chip--locked' : 'mc-chip';
          privacy.textContent = room.isPrivate ? '🔒 비공개' : '공개';

          const count = document.createElement('span');
          count.className = 'mc-room-count';
          count.textContent = `${room.playerCount}/${room.maxPlayers}`;

          card.append(name, privacy, count);
          if (room.phase !== 'lobby') {
            const playing = document.createElement('span');
            playing.className = 'mc-chip mc-chip--playing';
            playing.textContent = '게임 중';
            card.appendChild(playing);
          }

          card.addEventListener('click', () => {
            joinError = null;
            if (room.isPrivate) {
              expandedCode = expandedCode === room.code ? null : room.code;
              render();
            } else {
              void handleJoin(room.code);
            }
          });
          li.appendChild(card);

          if (expandedCode === room.code && room.isPrivate) {
            li.appendChild(renderPasswordRow(room.code));
          }
          list.appendChild(li);
        }
        panel.appendChild(list);

        if (joinError) {
          const err = document.createElement('p');
          err.className = 'mc-error';
          err.setAttribute('role', 'alert');
          err.textContent = joinError;
          panel.appendChild(err);
        }
        return panel;
      }

      function renderPasswordRow(code: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'mc-form';
        const pwInput = document.createElement('input');
        pwInput.type = 'password';
        pwInput.placeholder = '비밀번호';
        pwInput.setAttribute('aria-label', '방 비밀번호');
        const joinBtn = document.createElement('button');
        joinBtn.type = 'button';
        joinBtn.className = 'mc-btn mc-btn--ghost';
        joinBtn.textContent = '입장';
        joinBtn.addEventListener('click', () => {
          void handleJoin(code, pwInput.value);
        });
        withPressFX(joinBtn);
        pwInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') void handleJoin(code, pwInput.value);
        });
        row.append(pwInput, joinBtn);
        return row;
      }

      function renderCreatePanel(): HTMLElement {
        const panel = document.createElement('section');
        panel.className = 'mc-panel';
        const h2 = document.createElement('h2');
        h2.textContent = '방 만들기';
        panel.appendChild(h2);

        const form = document.createElement('div');
        form.className = 'mc-form';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = '방 이름';
        nameInput.maxLength = 20;
        nameInput.setAttribute('aria-label', '방 이름');

        const visibility = document.createElement('div');
        visibility.className = 'mc-visibility';
        const publicBtn = document.createElement('button');
        publicBtn.type = 'button';
        publicBtn.textContent = '공개';
        publicBtn.setAttribute('aria-pressed', String(!isPrivate));
        const privateBtn = document.createElement('button');
        privateBtn.type = 'button';
        privateBtn.textContent = '🔒 비공개';
        privateBtn.setAttribute('aria-pressed', String(isPrivate));
        publicBtn.addEventListener('click', () => {
          isPrivate = false;
          render();
        });
        privateBtn.addEventListener('click', () => {
          isPrivate = true;
          render();
        });
        visibility.append(publicBtn, privateBtn);

        form.append(nameInput, visibility);

        if (isPrivate) {
          const pwInput = document.createElement('input');
          pwInput.type = 'password';
          pwInput.placeholder = '비밀번호 (2자 이상)';
          pwInput.setAttribute('aria-label', '비밀번호');
          form.appendChild(pwInput);
        }

        const createBtn = document.createElement('button');
        createBtn.type = 'button';
        createBtn.className = 'mc-btn mc-btn--green mc-form-submit';
        createBtn.textContent = creating ? '만드는 중…' : '만들기';
        createBtn.disabled = creating;
        createBtn.addEventListener('click', () => {
          void handleCreate();
        });
        withPressFX(createBtn);
        form.appendChild(createBtn);

        if (createError) {
          const err = document.createElement('p');
          err.className = 'mc-error';
          err.setAttribute('role', 'alert');
          err.textContent = createError;
          form.appendChild(err);
        }

        panel.appendChild(form);
        return panel;
      }

      async function handleCreate(): Promise<void> {
        if (creating) return;
        const nick = nickname();
        const roomName = (root.querySelector<HTMLInputElement>('input[aria-label="방 이름"]')?.value ?? '').trim();
        const password = root.querySelector<HTMLInputElement>('input[aria-label="비밀번호"]')?.value ?? '';
        createError = null;
        if (!nick) createError = '이름을 입력해 주세요';
        else if (!roomName) createError = '방 이름을 입력해 주세요';
        else if (isPrivate && password.length < 2) createError = '비밀번호는 2자 이상이어야 해요';
        if (createError) {
          render();
          return;
        }
        creating = true;
        render();
        saveNickname(nick);
        const res = await createRoom(ctx, nick, {
          roomName,
          isPrivate,
          password: isPrivate ? password : undefined,
        });
        creating = false;
        if (res.ok) {
          ctx.state.playerId = res.playerId;
        } else {
          createError = '방을 만들 수 없어요 — 입력을 확인해 주세요';
        }
        render();
      }

      async function handleJoin(code: string, password?: string): Promise<void> {
        const nick = nickname();
        if (!nick) {
          joinError = '먼저 이름을 입력해 주세요';
          render();
          return;
        }
        saveNickname(nick);
        const res = await joinRoom(ctx, code, nick, password);
        if (res.ok) {
          ctx.state.playerId = res.playerId;
          joinError = null;
        } else {
          joinError = joinErrorMessage(res.code);
        }
        render();
      }

      async function refreshRooms(): Promise<void> {
        if (ctx.state.playerId && ctx.state.room) return; // in a room — list hidden
        const res = await listRooms(ctx);
        if (!mounted) return; // resolved after a phase switch — don't repaint
        rooms = res.rooms;
        render();
      }

      // ---- in-room screen (host tools preserved from the original lobby) ---

      function renderRoomScreen(): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'mc-room-screen';
        const room = ctx.state.room!;

        const header = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'mc-room-name';
        title.textContent = room.isPrivate ? `🔒 ${room.name}` : room.name;
        const codeEl = document.createElement('div');
        codeEl.className = 'mc-code';
        codeEl.textContent = `코드: ${room.code}`;
        header.append(title, codeEl);
        wrap.appendChild(header);

        if (ctx.state.abortNotice) {
          const notice = document.createElement('p');
          notice.className = 'mc-error';
          notice.setAttribute('role', 'alert');
          notice.textContent = ctx.state.abortNotice;
          wrap.appendChild(notice);
        }

        const list = document.createElement('ul');
        for (const p of room.players) {
          const li = document.createElement('li');
          li.className = p.isHost ? 'mc-player-chip mc-player-chip--host' : 'mc-player-chip';
          li.setAttribute('aria-label', p.isHost ? `${p.nickname} (호스트)` : p.nickname);
          li.innerHTML = playerSvg();
          const nameSpan = document.createElement('span');
          nameSpan.textContent = p.nickname;
          li.appendChild(nameSpan);
          list.appendChild(li);
        }
        wrap.appendChild(list);

        const host = isHost(ctx);
        if (host) {
          wrap.appendChild(renderCaptureSection());
        }

        const startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.className = 'mc-btn mc-btn--green';
        startBtn.textContent = '시작';
        const canStart = host && room.players.length >= MIN_PLAYERS && room.background !== null;
        startBtn.disabled = !canStart;
        startBtn.addEventListener('click', (event) => {
          const { clientX, clientY } = event;
          void startGame(ctx).then((res) => {
            if (res.ok) paintBurst(clientX, clientY);
          });
        });
        withPressFX(startBtn);
        wrap.appendChild(startBtn);

        // The start conditions were invisible — a full room with no background
        // looked like a broken button. Spell them out.
        if (!canStart) {
          const hints = document.createElement('ul');
          hints.className = 'mc-start-hints';
          if (host) {
            const enough = room.players.length >= MIN_PLAYERS;
            const items: Array<{ ok: boolean; text: string }> = [
              { ok: enough, text: enough ? `인원 ${room.players.length}명 — 준비 완료` : `인원 ${room.players.length}/${MIN_PLAYERS} — 한 명 더 필요해요` },
              { ok: room.background !== null, text: room.background !== null ? '배경 준비 완료' : '배경이 필요해요 — 위에서 웹 주소를 가져오세요' },
            ];
            for (const item of items) {
              const li = document.createElement('li');
              li.className = item.ok ? 'mc-hint-ok' : 'mc-hint-todo';
              li.textContent = `${item.ok ? '✓' : '•'} ${item.text}`;
              hints.appendChild(li);
            }
          } else {
            const li = document.createElement('li');
            li.className = 'mc-hint-todo';
            li.textContent = '호스트가 배경을 정하고 시작하면 게임이 열려요';
            hints.appendChild(li);
          }
          wrap.appendChild(hints);
        }

        return wrap;
      }

      function renderCaptureSection(): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'mc-form';

        const label = document.createElement('div');
        label.className = 'mc-field-label';
        label.textContent = '배경 (필수) — 이 웹페이지에 숨게 돼요';
        wrap.appendChild(label);

        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.placeholder = 'https://...';
        urlInput.setAttribute('aria-label', '배경 URL');

        const captureBtn = document.createElement('button');
        captureBtn.type = 'button';
        captureBtn.className = 'mc-btn mc-btn--ghost';
        captureBtn.textContent = captureState.status === 'loading' ? '가져오는 중…' : '가져오기';
        captureBtn.disabled = captureState.status === 'loading';
        captureBtn.addEventListener('click', () => {
          void handleCapture(urlInput.value);
        });
        withPressFX(captureBtn);
        wrap.append(urlInput, captureBtn);

        if (captureState.status === 'success') {
          const preview = document.createElement('img');
          preview.src = captureState.background.imageUrl;
          preview.alt = '배경 미리보기';
          preview.style.maxWidth = '100%';
          preview.style.borderRadius = '10px';
          const dims = document.createElement('span');
          dims.textContent = `${captureState.background.width}×${captureState.background.height}`;
          wrap.append(preview, dims);
        }

        if (captureState.status === 'error') {
          const err = document.createElement('div');
          err.className = 'mc-error';
          err.textContent = captureState.message;
          wrap.appendChild(err);

          const retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.className = 'mc-btn mc-btn--ghost';
          retryBtn.textContent = '다시 시도';
          retryBtn.addEventListener('click', () => {
            void handleCapture(urlInput.value);
          });
          withPressFX(retryBtn);
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
          const applied = await setBackground(ctx, result.background);
          if (!applied.ok) {
            // A silently-ignored rejection here is exactly how the relative-
            // imageUrl bug stayed invisible — surface it.
            captureState = { status: 'error', message: '배경 적용이 거부됐어요 — 다시 시도해 주세요' };
            render();
          }
        } else {
          captureState = { status: 'error', message: captureErrorMessage(result.code) };
          render();
        }
      }

      // socket.io (EventEmitter) snapshots the listener list when an event
      // fires, so when this same room:state event unmounts the lobby (phase
      // switch), this handler still runs once AFTER unmount — without the
      // guard it repaints the lobby right over the newly mounted phase screen.
      let mounted = true;
      function onRoomState(): void {
        if (!mounted) return;
        render();
      }
      ctx.socket.on('room:state', onRoomState);
      void refreshRooms();
      pollTimer = window.setInterval(() => void refreshRooms(), ROOM_LIST_POLL_MS);
      cleanup = () => {
        mounted = false;
        ctx.socket.off('room:state', onRoomState);
        if (pollTimer !== null) window.clearInterval(pollTimer);
        pressFxDetachers.forEach((detach) => detach());
        pressFxDetachers = [];
      };

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
