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
  const { code, playerId: hostId } = engine.createRoom('host');
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
    const { playerId: hostId } = engine.createRoom('solo');
    expect(engine.start(hostId)).toEqual({ ok: false, code: 'NEED_PLAYERS' });
  });

  it('rejects starting without a background set (NEED_BACKGROUND)', () => {
    const { engine } = createEngine();
    const { code, playerId: hostId } = engine.createRoom('host');
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
  it('auto-transitions hide -> seek exactly at the 60s hide timer expiry', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);

    expect(events.some((e) => e.event === 'phase:seek')).toBe(false);
    vi.advanceTimersByTime(HIDE_MS);
    expect(events.some((e) => e.event === 'phase:seek')).toBe(true);
  });

  it('declares the hider the winner when the 120s seek timer expires', () => {
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

  it('ends the game as a seekers-forfeit when the hider leaves mid-game', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);

    engine.leave(hiderId);
    const endEvent = events.find((e) => e.event === 'game:end');
    expect(endEvent?.payload).toMatchObject({ winner: 'seekers', reason: 'forfeit' });
  });

  it('ends the game as a hider win when the last seeker leaves', () => {
    const { engine, events } = createEngine();
    const { hostId, joinerId } = setupTwoPlayerRoom(engine);
    engine.start(hostId);
    const hiderId = hiderIdFrom(events);
    const seekerId = hiderId === hostId ? joinerId : hostId;

    engine.leave(seekerId);
    const endEvent = events.find((e) => e.event === 'game:end');
    expect(endEvent?.payload).toMatchObject({ winner: 'hider', reason: 'forfeit' });
  });

  it('throws after 5 room-code collision retries', () => {
    const { engine } = createEngine(() => 0); // constant rng => same code every attempt
    engine.createRoom('first');
    expect(() => engine.createRoom('second')).toThrow('ROOM_CODE_EXHAUSTED');
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
