import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIDE_MS, LOCKOUT_MS, MAX_PLAYERS, MAX_SCALE, MIN_SCALE, SEEK_MS, type Background } from 'shared/protocol';
import { type Emit, RoomEngine, realScheduler } from '../src/engine/room-engine';

interface RecordedEvent {
  target: string;
  event: string;
  payload: unknown;
}

function createEngine(rng: () => number = () => 0) {
  const events: RecordedEvent[] = [];
  const emit: Emit = (target, event, payload) => {
    events.push({ target, event, payload });
  };
  const engine = new RoomEngine({ scheduler: realScheduler, rng, emit });
  return { engine, events };
}

const background: Background = {
  imageUrl: 'https://example.com/shot.png',
  width: 1440,
  height: 2000,
};

const solidColors = (hex: string) => ({
  head: hex,
  torso: hex,
  leftArm: hex,
  rightArm: hex,
  leftLeg: hex,
  rightLeg: hex,
});

function hiderIdFrom(events: RecordedEvent[]): string {
  const roleEvent = events.find(
    (e) => e.event === 'game:role' && (e.payload as { role: string }).role === 'hider',
  );
  if (!roleEvent) throw new Error('no hider role event recorded');
  return roleEvent.target;
}

/** host creates + a second player joins + host sets a background, room still in lobby. */
function setupTwoPlayerRoom(engine: RoomEngine) {
  const { code, playerId: hostId } = engine.createRoom('host', PUBLIC_ROOM);
  const joinResult = engine.join(code, 'joiner');
  if (!joinResult.ok) throw new Error('join failed in test setup');
  engine.setBackground(hostId, background);
  return { code, hostId, joinerId: joinResult.playerId };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const PUBLIC_ROOM = { name: '테스트방', isPrivate: false } as const;

describe('RoomEngine — normal flow', () => {
  it('runs a full round: create -> join -> start -> hideConfirm -> seeker click hit -> game:end', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = setupTwoPlayerRoom(engine);

    const startResult = engine.start(hostId);
    expect(startResult.ok).toBe(true);

    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === hostId ? joinerId : hostId;

    expect(engine.hideConfirm(hiderId)).toEqual({ ok: true });

    // default stickman's feet are centered on the background at (720, 1000),
    // scale 1; the torso center is 70px above that (see shared/test/stickman.test.ts).
    const result = engine.click(seekerId, 720, 930);
    expect(result).toBe('hit');

    const endEvent = events.find((e) => e.event === 'game:end');
    expect(endEvent?.payload).toMatchObject({ winner: 'seekers', foundBy: seekerId, reason: 'found' });
  });
});

describe('RoomEngine — error cases', () => {
  it('rejects joining a room that does not exist (ROOM_NOT_FOUND)', () => {
    const { engine } = createEngine();
    expect(engine.join('NOPE01', 'x')).toEqual({ ok: false, code: 'ROOM_NOT_FOUND' });
  });

  it('rejects starting with only 1 player (NEED_PLAYERS)', () => {
    const { engine } = createEngine();
    const { playerId: hostId } = engine.createRoom('solo', PUBLIC_ROOM);
    expect(engine.start(hostId)).toEqual({ ok: false, code: 'NEED_PLAYERS' });
  });

  it('rejects starting without a background set (NEED_BACKGROUND)', () => {
    const { engine } = createEngine();
    const { code, playerId: hostId } = engine.createRoom('host', PUBLIC_ROOM);
    engine.join(code, 'joiner');
    expect(engine.start(hostId)).toEqual({ ok: false, code: 'NEED_BACKGROUND' });
  });

  it('rejects a click from the hider (not a seeker)', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    engine.hideConfirm(hiderId);

    // The hider is not a seeker, so any click from them is rejected regardless
    // of coordinates -- this is the engine-level equivalent of NOT_SEEKER.
    expect(engine.click(hiderId, 0, 0)).toBe('rejected');
  });

  it('reports "locked" for a click made during the 3s post-miss lockout', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === hostId ? joinerId : hostId;
    engine.hideConfirm(hiderId);

    expect(engine.click(seekerId, 0, 0)).toBe('miss');
    expect(engine.click(seekerId, 0, 0)).toBe('locked');
  });
});

describe('RoomEngine — boundary cases', () => {
  it('auto-transitions hide -> seek exactly at the hide timer expiry', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);

    expect(events.some((e) => e.event === 'phase:seek')).toBe(false);
    vi.advanceTimersByTime(HIDE_MS);
    expect(events.some((e) => e.event === 'phase:seek')).toBe(true);
  });

  it('declares the hider the winner when the seek timer expires', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    vi.advanceTimersByTime(HIDE_MS); // enter seek

    vi.advanceTimersByTime(SEEK_MS);
    const endEvent = events.find((e) => e.event === 'game:end');
    expect(endEvent?.payload).toMatchObject({ winner: 'hider', reason: 'timeout' });
  });

  it(`rejects the (${MAX_PLAYERS + 1})th player joining a full room (ROOM_FULL)`, () => {
    const { engine } = createEngine();
    const { code } = setupTwoPlayerRoom(engine); // 2 players already
    for (let i = 0; i < MAX_PLAYERS - 2; i++) {
      expect(engine.join(code, `extra${i}`).ok).toBe(true);
    }
    expect(engine.join(code, 'overflow')).toEqual({ ok: false, code: 'ROOM_FULL' });
  });

  it('allows a click again exactly at the 3s lockout expiry boundary', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === hostId ? joinerId : hostId;
    engine.hideConfirm(hiderId);

    expect(engine.click(seekerId, 0, 0)).toBe('miss');
    vi.advanceTimersByTime(LOCKOUT_MS);
    expect(engine.click(seekerId, 0, 0)).toBe('miss'); // unlocked, not 'locked'
  });

  it('hits exactly at the capsule radius + 4px margin boundary coordinate', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === hostId ? joinerId : hostId;
    engine.hideConfirm(hiderId);

    // default stickman centered at (720, 1000); torso boundary point per the
    // same geometry verified in shared/test/stickman.test.ts.
    expect(engine.click(seekerId, 730, 945)).toBe('hit');
  });

  it('aborts back to the lobby (not result) when the hider leaves mid-game', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);

    engine.leave(hiderId);
    const abortEvent = events.find((e) => e.event === 'game:aborted');
    expect(abortEvent?.payload).toEqual({ reason: 'hider_left' });
    expect(events.some((e) => e.event === 'game:end')).toBe(false);
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(lastState.payload).toMatchObject({ phase: 'lobby', endsAt: null });
  });

  it('aborts back to the lobby when the last seeker leaves and only the hider remains', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === hostId ? joinerId : hostId;

    engine.leave(seekerId);
    const abortEvent = events.find((e) => e.event === 'game:aborted');
    expect(abortEvent?.payload).toEqual({ reason: 'not_enough_players' });
    expect(events.some((e) => e.event === 'game:end')).toBe(false);
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(lastState.payload).toMatchObject({ phase: 'lobby' });
  });

  it('keeps the game running and reassigns host when a non-hider host leaves a 3-player game', () => {
    // rng 0.7 makes the hider pick floor(0.7 * 3) = 2 — the third player —
    // keeping the host a plain seeker.
    const { engine, events } = createEngine(() => 0.7);
    const { code, hostId } = setupTwoPlayerRoom(engine);
    engine.join(code, 'third');
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    expect(hiderId).not.toBe(hostId);

    engine.leave(hostId);
    expect(events.some((e) => e.event === 'game:aborted')).toBe(false);
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    const payload = lastState.payload as { phase: string; players: Array<{ isHost: boolean }> };
    expect(payload.phase).toBe('hide');
    expect(payload.players.filter((p) => p.isHost)).toHaveLength(1);
  });

  it('throws after 5 room-code collision retries', () => {
    const { engine } = createEngine(() => 0); // constant rng => same code every attempt
    engine.createRoom('first', PUBLIC_ROOM);
    expect(() => engine.createRoom('second', PUBLIC_ROOM)).toThrow('ROOM_CODE_EXHAUSTED');
  });
});

describe('RoomEngine — hideUpdate authorization (server is the sole judge)', () => {
  it('applies the hider\'s hideUpdate to the stickman used for later hit tests (normal case)', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === hostId ? joinerId : hostId;

    engine.hideUpdate(hiderId, { x: 200, y: 300, scale: 1, colors: solidColors('#ff0000') });
    engine.hideConfirm(hiderId);

    // the default center (720, 930) no longer hits...
    expect(engine.click(seekerId, 720, 930)).toBe('miss');
    vi.advanceTimersByTime(LOCKOUT_MS);
    // ...but the hider's new torso center (200, 300-70) does.
    expect(engine.click(seekerId, 200, 230)).toBe('hit');
  });

  it('ignores a hideUpdate attempted by a non-hider seeker (error/security case)', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === hostId ? joinerId : hostId;

    // A seeker trying to move the stickman during hide phase must be a no-op --
    // the server, not any client, is the sole authority over stickman state.
    engine.hideUpdate(seekerId, { x: 5, y: 5, scale: 1, colors: solidColors('#00ff00') });
    engine.hideConfirm(hiderId);

    // the default center still hits: the spoofed update never took effect.
    expect(engine.click(seekerId, 720, 930)).toBe('hit');
  });
});

describe('RoomEngine — hideUpdate coordinate/scale clamping (review r1 F1)', () => {
  it('stores an in-bounds hideUpdate unchanged (normal case)', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = setupTwoPlayerRoom(engine); // background is 1440x2000
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === hostId ? joinerId : hostId;

    engine.hideUpdate(hiderId, { x: 300, y: 400, scale: 1, colors: solidColors('#ff0000') });
    engine.hideConfirm(hiderId);

    expect(engine.click(seekerId, 300, 330)).toBe('hit'); // torso midpoint: y - 70
  });

  it('accepts coordinates/scale exactly at the background width/height/MAX_SCALE boundary', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = setupTwoPlayerRoom(engine); // background is 1440x2000
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === hostId ? joinerId : hostId;

    engine.hideUpdate(hiderId, {
      x: background.width,
      y: background.height,
      scale: MAX_SCALE,
      colors: solidColors('#ff0000'),
    });
    engine.hideConfirm(hiderId);

    // torso midpoint at MAX_SCALE, offset -106 (isolated from the scaled arm/leg
    // capsules -- see the equivalent scale-2 case in shared/test/stickman.test.ts).
    expect(engine.click(seekerId, background.width, background.height - 106)).toBe('hit');
  });

  it('clamps out-of-range coordinates and scale so hitTest runs against the clamped position (error/abuse case)', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = setupTwoPlayerRoom(engine); // background is 1440x2000
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === hostId ? joinerId : hostId;

    // A malicious/buggy hider tries to hide off-canvas and near-invisible.
    engine.hideUpdate(hiderId, { x: -9999, y: 999_999, scale: 0.01, colors: solidColors('#ff0000') });
    engine.hideConfirm(hiderId);

    // x clamps to 0, y clamps to background.height, scale clamps to MIN_SCALE.
    const torsoMidpointAtMinScale = -70 * MIN_SCALE;
    expect(engine.click(seekerId, 0, background.height + torsoMidpointAtMinScale)).toBe('hit');
  });
});

describe('RoomEngine — private rooms & room list', () => {
  it('joins a private room with the correct password (normal case)', () => {
    const { engine } = createEngine();
    const { code } = engine.createRoom('host', { name: '비밀방', isPrivate: true, password: '1234' });
    const result = engine.join(code, 'joiner', '1234');
    expect(result.ok).toBe(true);
  });

  it('rejects a private-room join with a wrong or missing password (error case)', () => {
    const { engine } = createEngine();
    const { code } = engine.createRoom('host', { name: '비밀방', isPrivate: true, password: '1234' });
    const wrong = engine.join(code, 'joiner', '9999');
    const missing = engine.join(code, 'joiner');
    expect(wrong).toEqual({ ok: false, code: 'WRONG_PASSWORD' });
    expect(missing).toEqual({ ok: false, code: 'WRONG_PASSWORD' });
  });

  it('lists rooms with name, privacy, count and phase; public join ignores password (boundary case)', () => {
    let n = 0;
    const { engine } = createEngine(() => ((n += 7) % 31) / 31);
    const pub = engine.createRoom('a', { name: '공개방', isPrivate: false });
    engine.createRoom('b', { name: '비밀방', isPrivate: true, password: 'pw' });
    const publicJoin = engine.join(pub.code, 'c', '아무거나');
    expect(publicJoin.ok).toBe(true);

    const rooms = engine.listRooms();
    expect(rooms).toHaveLength(2);
    const pubRow = rooms.find((r) => r.code === pub.code)!;
    expect(pubRow).toMatchObject({ name: '공개방', isPrivate: false, playerCount: 2, maxPlayers: MAX_PLAYERS, phase: 'lobby' });
    const privRow = rooms.find((r) => r.name === '비밀방')!;
    expect(privRow.isPrivate).toBe(true);
    // the summary must never leak the password
    expect(JSON.stringify(rooms)).not.toContain('pw');
  });

  it('room:state carries name and isPrivate (normal case)', () => {
    const { engine, events } = createEngine();
    engine.createRoom('host', { name: '이름표시', isPrivate: true, password: 'pw' });
    const stateEvent = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(stateEvent.payload).toMatchObject({ name: '이름표시', isPrivate: true });
    expect(JSON.stringify(stateEvent.payload)).not.toContain('pw');
  });
});

describe('RoomEngine — in-game rooms reject new joins', () => {
  it('rejects joining during the hide phase (BAD_PHASE)', () => {
    const { engine } = createEngine();
    const { code, hostId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    expect(engine.join(code, 'latecomer')).toEqual({ ok: false, code: 'BAD_PHASE' });
  });

  it('rejects joining during the seek phase (BAD_PHASE)', () => {
    const { engine, events } = createEngine();
    const { code, hostId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    engine.hideConfirm(hiderIdFrom(events));
    expect(engine.join(code, 'latecomer')).toEqual({ ok: false, code: 'BAD_PHASE' });
  });
});

describe('RoomEngine — restart from the result screen', () => {
  /** Plays a full round to the result phase (seeker clicks the default stickman). */
  function playToResult(engine: RoomEngine, events: RecordedEvent[]) {
    const ids = setupTwoPlayerRoom(engine);
    engine.start(ids.hostId);
    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === ids.hostId ? ids.joinerId : ids.hostId;
    engine.hideConfirm(hiderId);
    expect(engine.click(seekerId, 720, 930)).toBe('hit');
    return ids;
  }

  it('returns the room to the lobby and allows starting a new round (normal case)', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = playToResult(engine, events);

    expect(engine.restart(joinerId)).toEqual({ ok: true });
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(lastState.payload).toMatchObject({ phase: 'lobby', endsAt: null });

    // the background is kept, so the host can start round 2 immediately
    expect(engine.start(hostId)).toEqual({ ok: true });
  });

  it('rejects a restart outside the result phase (BAD_PHASE)', () => {
    const { engine } = createEngine();
    const { hostId } = setupTwoPlayerRoom(engine); // still in lobby
    expect(engine.restart(hostId)).toEqual({ ok: false, code: 'BAD_PHASE' });
  });

  it('rejects a restart from a player who is in no room (ROOM_NOT_FOUND boundary)', () => {
    const { engine } = createEngine();
    expect(engine.restart('ghost-id')).toEqual({ ok: false, code: 'ROOM_NOT_FOUND' });
  });

  it('clears an active seek lockout across a restart so round 2 starts unlocked', () => {
    // rng 0 always picks players[0] (the host) as hider, in both rounds.
    const { engine, events } = createEngine(() => 0);
    const { code, hostId, joinerId } = setupTwoPlayerRoom(engine);
    const join2 = engine.join(code, 'third');
    if (!join2.ok) throw new Error('join failed');
    engine.start(hostId);
    expect(hiderIdFrom(events)).toBe(hostId);
    engine.hideConfirm(hostId);
    expect(engine.click(joinerId, 0, 0)).toBe('miss'); // joiner locked for 3s
    expect(engine.click(join2.playerId, 720, 930)).toBe('hit'); // round ends

    expect(engine.restart(hostId)).toEqual({ ok: true });
    engine.start(hostId);
    engine.hideConfirm(hostId);
    // fake time never advanced, so without lockouts.clear() this would be 'locked'
    expect(engine.click(joinerId, 0, 0)).toBe('miss');
  });
});
