import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomSummary } from 'shared/protocol';
import type { AppContext } from '../src/net';
import { createLobbyController, isJoinable, joinErrorMessage } from '../src/lobby/index';

function summary(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    code: 'ABCDEF',
    name: '몰컴방',
    isPrivate: false,
    playerCount: 1,
    maxPlayers: 8,
    phase: 'lobby',
    ...overrides,
  };
}

interface MockNet {
  rooms: RoomSummary[];
  joinAck: { ok: true; playerId: string } | { ok: false; code: string };
  joinCalls: Array<{ code: string; nickname: string; password?: string }>;
}

function makeCtx(net: MockNet): AppContext {
  const socket = {
    emit: vi.fn((event: string, ...args: unknown[]) => {
      const ack = args.at(-1) as (res: unknown) => void;
      if (event === 'rooms:list') ack({ ok: true, rooms: net.rooms });
      if (event === 'room:join') {
        net.joinCalls.push(args[0] as MockNet['joinCalls'][number]);
        ack(net.joinAck);
      }
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    socket: socket as unknown as AppContext['socket'],
    state: { playerId: null, role: null, room: null, hidePayload: null },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  // jsdom in this vitest setup may not provide localStorage; the lobby code
  // treats it as best-effort, so the tests do too.
  try {
    window.localStorage?.clear();
  } catch {
    /* noop */
  }
});

describe('lobby home — room list & private join', () => {
  it('renders the room list with name, privacy chip and player count (normal)', async () => {
    const net: MockNet = { rooms: [summary(), summary({ code: 'PRIVAT', name: '비밀방', isPrivate: true })], joinAck: { ok: false, code: 'ROOM_NOT_FOUND' }, joinCalls: [] };
    const ctx = makeCtx(net);
    const root = document.createElement('div');
    const ctrl = createLobbyController();
    ctrl.mount(root, ctx);
    await flush();

    expect(root.textContent).toContain('몰컴방');
    expect(root.textContent).toContain('비밀방');
    expect(root.textContent).toContain('🔒 비공개');
    expect(root.textContent).toContain('1/8');
    ctrl.unmount();
  });

  it('joins a private room only through the password row, and shows the wrong-password error (error)', async () => {
    const net: MockNet = { rooms: [summary({ code: 'PRIVAT', name: '비밀방', isPrivate: true })], joinAck: { ok: false, code: 'WRONG_PASSWORD' }, joinCalls: [] };
    const ctx = makeCtx(net);
    const root = document.createElement('div');
    const ctrl = createLobbyController();
    ctrl.mount(root, ctx);
    await flush();

    root.querySelector<HTMLInputElement>('input[aria-label="닉네임"]')!.value = '영기';
    // clicking a private card must NOT emit room:join — it expands the password row
    root.querySelector<HTMLButtonElement>('.mc-room-card')!.click();
    await flush();
    expect(net.joinCalls).toHaveLength(0);

    const pw = root.querySelector<HTMLInputElement>('input[aria-label="방 비밀번호"]')!;
    pw.value = 'nope';
    const joinBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '입장')!;
    joinBtn.click();
    await flush();

    expect(net.joinCalls).toEqual([{ code: 'PRIVAT', nickname: '영기', password: 'nope' }]);
    expect(root.textContent).toContain('비밀번호가 달라요');
    ctrl.unmount();
  });

  it('disables full or in-game rooms (boundary) and maps error codes (unit)', async () => {
    const net: MockNet = {
      rooms: [summary({ code: 'FULLRM', playerCount: 8 }), summary({ code: 'INGAME', phase: 'seek' })],
      joinAck: { ok: false, code: 'ROOM_FULL' },
      joinCalls: [],
    };
    const ctx = makeCtx(net);
    const root = document.createElement('div');
    const ctrl = createLobbyController();
    ctrl.mount(root, ctx);
    await flush();

    const cards = root.querySelectorAll<HTMLButtonElement>('.mc-room-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].disabled).toBe(true);
    expect(cards[1].disabled).toBe(true);

    expect(isJoinable(summary({ playerCount: 7 }))).toBe(true);
    expect(isJoinable(summary({ playerCount: 8 }))).toBe(false);
    expect(isJoinable(summary({ phase: 'result' }))).toBe(false);
    expect(joinErrorMessage('WRONG_PASSWORD')).toBe('비밀번호가 달라요');
    expect(joinErrorMessage('ROOM_FULL')).toBe('방이 가득 찼어요');
    ctrl.unmount();
  });
});

describe('lobby home — title stamp', () => {
  it('renders the title as mc-title-paint spans with no legacy per-letter classes (regression: t1 D2)', async () => {
    const net: MockNet = { rooms: [], joinAck: { ok: false, code: 'ROOM_NOT_FOUND' }, joinCalls: [] };
    const ctx = makeCtx(net);
    const root = document.createElement('div');
    const ctrl = createLobbyController();
    ctrl.mount(root, ctx);
    await flush();

    const h1 = root.querySelector('h1.mc-title-paint');
    expect(h1).not.toBeNull();
    const spans = Array.from(h1!.querySelectorAll('span'));
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((s) => !s.className.includes('mc-letter'))).toBe(true);
    ctrl.unmount();
  });
});

describe('lobby home — room list status pill', () => {
  it('shows a mint 대기 중 pill on a lobby-phase room and a red 게임 중 pill on a non-lobby room in the same list (normal)', async () => {
    const net: MockNet = {
      rooms: [summary({ code: 'WAITNG', phase: 'lobby' }), summary({ code: 'INGAME', phase: 'seek' })],
      joinAck: { ok: false, code: 'ROOM_NOT_FOUND' },
      joinCalls: [],
    };
    const ctx = makeCtx(net);
    const root = document.createElement('div');
    const ctrl = createLobbyController();
    ctrl.mount(root, ctx);
    await flush();

    const cards = root.querySelectorAll<HTMLButtonElement>('.mc-room-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.mc-chip--waiting')?.textContent).toBe('대기 중');
    expect(cards[1].querySelector('.mc-chip--playing')?.textContent).toBe('게임 중');
    ctrl.unmount();
  });

  it('never mixes the two status texts onto one card (negative: mutual exclusivity)', async () => {
    const net: MockNet = {
      rooms: [summary({ code: 'WAITNG', phase: 'lobby' }), summary({ code: 'INGAME', phase: 'seek' })],
      joinAck: { ok: false, code: 'ROOM_NOT_FOUND' },
      joinCalls: [],
    };
    const ctx = makeCtx(net);
    const root = document.createElement('div');
    const ctrl = createLobbyController();
    ctrl.mount(root, ctx);
    await flush();

    const cards = root.querySelectorAll<HTMLButtonElement>('.mc-room-card');
    expect(cards[0].textContent).not.toContain('게임 중');
    expect(cards[1].textContent).not.toContain('대기 중');
    ctrl.unmount();
  });

  it('shows both the lock chip and the waiting pill on a private, lobby-phase room (boundary)', async () => {
    const net: MockNet = {
      rooms: [summary({ code: 'PRIVAT', name: '비밀방', isPrivate: true, phase: 'lobby' })],
      joinAck: { ok: false, code: 'ROOM_NOT_FOUND' },
      joinCalls: [],
    };
    const ctx = makeCtx(net);
    const root = document.createElement('div');
    const ctrl = createLobbyController();
    ctrl.mount(root, ctx);
    await flush();

    const card = root.querySelector<HTMLButtonElement>('.mc-room-card')!;
    expect(card.querySelector('.mc-chip--locked')?.textContent).toBe('🔒 비공개');
    expect(card.querySelector('.mc-chip--waiting')?.textContent).toBe('대기 중');
    ctrl.unmount();
  });
});

describe('lobby home — typing survives re-renders', () => {
  function mountInDocument(net: MockNet) {
    const ctx = makeCtx(net);
    const root = document.createElement('div');
    document.body.appendChild(root); // focus() only takes on attached nodes
    const ctrl = createLobbyController();
    ctrl.mount(root, ctx);
    return {
      ctx,
      root,
      done() {
        ctrl.unmount();
        root.remove();
      },
    };
  }

  function nickInput(root: HTMLElement): HTMLInputElement {
    return root.querySelector<HTMLInputElement>('input[aria-label="닉네임"]')!;
  }

  it('keeps focus, value and caret in the nickname input when a room:state repaint lands mid-typing (normal)', async () => {
    const net: MockNet = { rooms: [summary()], joinAck: { ok: false, code: 'ROOM_NOT_FOUND' }, joinCalls: [] };
    const m = mountInDocument(net);
    await flush();

    const input = nickInput(m.root);
    input.focus();
    input.value = '영기';
    input.setSelectionRange(1, 1);
    expect(document.activeElement).toBe(input);

    // Grab the socket 'room:state' handler the lobby registered and fire it.
    const on = (m.ctx.socket as unknown as { on: ReturnType<typeof vi.fn> }).on;
    const onRoomState = on.mock.calls.find((c: unknown[]) => c[0] === 'room:state')![1] as () => void;
    onRoomState();

    const rebuilt = nickInput(m.root);
    expect(rebuilt).not.toBe(input); // the DOM really was torn down
    expect(document.activeElement).toBe(rebuilt);
    expect(rebuilt.value).toBe('영기');
    expect(rebuilt.selectionStart).toBe(1);
    expect(rebuilt.selectionEnd).toBe(1);
    m.done();
  });

  it('defers the room-list poll repaint while an input is focused, then catches up once typing stops (normal)', async () => {
    vi.useFakeTimers();
    try {
      const net: MockNet = { rooms: [summary()], joinAck: { ok: false, code: 'ROOM_NOT_FOUND' }, joinCalls: [] };
      const m = mountInDocument(net);
      await flush();

      const nameInput = m.root.querySelector<HTMLInputElement>('input[aria-label="방 이름"]')!;
      nameInput.focus();
      nameInput.value = '몰';
      net.rooms = [summary(), summary({ code: 'NEWROO', name: '새로운방' })];

      await vi.advanceTimersByTimeAsync(3000);
      // Same node — no repaint happened under the user's caret.
      expect(m.root.querySelector<HTMLInputElement>('input[aria-label="방 이름"]')).toBe(nameInput);
      expect(document.activeElement).toBe(nameInput);
      expect(m.root.textContent).not.toContain('새로운방');

      nameInput.blur();
      await vi.advanceTimersByTimeAsync(3000);
      expect(m.root.textContent).toContain('새로운방');
      expect(m.root.querySelector<HTMLInputElement>('input[aria-label="방 이름"]')!.value).toBe('몰');
      m.done();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not tear down the screen when the polled room list is unchanged (boundary)', async () => {
    vi.useFakeTimers();
    try {
      const net: MockNet = { rooms: [summary()], joinAck: { ok: false, code: 'ROOM_NOT_FOUND' }, joinCalls: [] };
      const m = mountInDocument(net);
      await flush();

      const before = nickInput(m.root);
      await vi.advanceTimersByTimeAsync(3000);
      expect(nickInput(m.root)).toBe(before);
      m.done();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the poll repaint even when the room list comes back empty while typing (boundary)', async () => {
    vi.useFakeTimers();
    try {
      const net: MockNet = { rooms: [summary()], joinAck: { ok: false, code: 'ROOM_NOT_FOUND' }, joinCalls: [] };
      const m = mountInDocument(net);
      await flush();

      const input = nickInput(m.root);
      input.focus();
      net.rooms = [];
      await vi.advanceTimersByTimeAsync(3000);
      expect(document.activeElement).toBe(input);
      expect(m.root.textContent).toContain('몰컴방'); // stale on purpose until typing stops
      m.done();
    } finally {
      vi.useRealTimers();
    }
  });
});
