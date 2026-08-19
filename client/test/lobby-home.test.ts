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
