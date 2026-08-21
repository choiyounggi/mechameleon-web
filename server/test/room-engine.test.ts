import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HIDE_MS,
  LOCKOUT_MS,
  MAX_PLAYERS,
  MAX_SCALE,
  MIN_SCALE,
  RESULT_MS,
  SEEK_MS,
  type Background,
  zSetHiderCountReq,
} from 'shared/protocol';
import { INITIAL_FEET_Y } from 'shared/stickman';
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

const PUBLIC_ROOM = { name: '테스트방', isPrivate: false } as const;

/** One painted brush stroke, used only to prove hideUpdate persists what was sent. */
const painted = (color: string) => [{ color, size: 10, points: [{ x: 0, y: 0 }] }];

/** host (nickname p0) creates + (n-1) more players join + host sets a background; room stays in lobby. */
function setupRoom(engine: RoomEngine, n: number, roomOpts: { name: string; isPrivate: boolean } = PUBLIC_ROOM) {
  const { code, playerId: hostId } = engine.createRoom('p0', roomOpts);
  const ids = [hostId];
  for (let i = 1; i < n; i++) {
    const result = engine.join(code, `p${i}`);
    if (!result.ok) throw new Error('join failed in test setup');
    ids.push(result.playerId);
  }
  engine.setBackground(hostId, background);
  return { code, hostId, ids };
}

/** All player ids that were told they are the hider, in the order their game:role event was recorded. */
function hiderIdsFrom(events: RecordedEvent[]): string[] {
  return events
    .filter((e) => e.event === 'game:role' && (e.payload as { role: string }).role === 'hider')
    .map((e) => e.target);
}

/**
 * The click coordinate that hits the hider at `index` (0-based, in hiderIds
 * insertion order) out of `hiderCount` total hiders — mirrors room-engine's
 * defaultStickman x-spread (D5) and the torso capsule's -70px y offset from
 * feet (see shared/test/stickman.test.ts).
 */
function hitCoordFor(index: number, hiderCount: number): { x: number; y: number } {
  return {
    x: Math.round((background.width * (index + 1)) / (hiderCount + 1)),
    y: INITIAL_FEET_Y - 70,
  };
}

const MISS_COORD = { x: 0, y: 0 };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RoomEngine — normal multi-hider flow', () => {
  it('runs a full round with 2 hiders: each hit reveals one hider via seek:found, then game:end on the last', () => {
    const { engine, events } = createEngine(); // rng=0 -> hiders = p0,p1 (first 2 of 4)
    const { hostId, ids } = setupRoom(engine, 4);
    expect(engine.start(hostId)).toEqual({ ok: true });

    const hiders = hiderIdsFrom(events);
    expect(hiders).toEqual([ids[0], ids[1]]);
    const seekerId = ids[2];

    for (const hiderId of hiders) {
      expect(engine.hideConfirm(hiderId)).toEqual({ ok: true });
    }
    expect(events.some((e) => e.event === 'phase:seek')).toBe(true);

    // first hit: one hider revealed, game continues (no game:end yet)
    const firstHit = hitCoordFor(0, 2);
    expect(engine.click(seekerId, firstHit.x, firstHit.y)).toBe('hit');
    const firstFound = events.find((e) => e.event === 'seek:found');
    expect(firstFound?.payload).toMatchObject({ playerId: hiders[0], by: seekerId, remaining: 1 });
    expect(events.some((e) => e.event === 'game:end')).toBe(false);

    // second hit: last hider revealed -> game:end
    const secondHit = hitCoordFor(1, 2);
    expect(engine.click(seekerId, secondHit.x, secondHit.y)).toBe('hit');
    const foundEvents = events.filter((e) => e.event === 'seek:found');
    expect(foundEvents).toHaveLength(2);
    expect(foundEvents[1].payload).toMatchObject({ playerId: hiders[1], by: seekerId, remaining: 0 });

    const endEvent = events.find((e) => e.event === 'game:end')!;
    expect(endEvent.payload).toMatchObject({ winner: 'seekers', reason: 'all_found' });
    const payload = endEvent.payload as { stickmen: Array<{ playerId: string; found: boolean }> };
    expect(payload.stickmen).toHaveLength(2);
    expect(payload.stickmen.every((s) => s.found)).toBe(true);

    // seek:found for the final hider must be emitted before game:end (D7 ordering)
    const lastFoundIdx = events.indexOf(foundEvents[1]);
    const endIdx = events.indexOf(endEvent);
    expect(lastFoundIdx).toBeLessThan(endIdx);
  });

  it('phase:seek carries every hider\'s own stickman and nickname', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id));

    const seekEvent = events.find((e) => e.event === 'phase:seek')!;
    const payload = seekEvent.payload as {
      stickmen: Array<{ playerId: string; nickname: string; stickman: unknown }>;
    };
    expect(payload.stickmen.map((s) => s.playerId).sort()).toEqual([...hiders].sort());
    expect(payload.stickmen.every((s) => typeof s.nickname === 'string' && s.nickname.length > 0)).toBe(true);
  });

  it('phase:seek carries each hider\'s own distinct stroke-color count (0/1/3-color hiders mixed in one room)', () => {
    const { engine, events } = createEngine(); // rng=0 -> hiders = first 3 of 6 players
    const { hostId } = setupRoom(engine, 6);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    expect(hiders).toHaveLength(3);

    // hiders[0]: never paints -> 0 colors (default stickman has no strokes)
    engine.hideUpdate(hiders[1], { x: 200, y: 300, scale: 1, strokes: painted('#ff0000') });
    engine.hideUpdate(hiders[2], {
      x: 200,
      y: 300,
      scale: 1,
      strokes: [
        { color: '#ff0000', size: 10, points: [{ x: 0, y: 0 }] },
        { color: '#00ff00', size: 10, points: [{ x: 0, y: 0 }] },
        { color: '#0000ff', size: 10, points: [{ x: 0, y: 0 }] },
      ],
    });
    hiders.forEach((id) => engine.hideConfirm(id));

    const seekEvent = events.find((e) => e.event === 'phase:seek')!;
    const payload = seekEvent.payload as { stickmen: Array<{ playerId: string; colorCount: number }> };
    const byPlayer = new Map(payload.stickmen.map((s) => [s.playerId, s.colorCount]));
    expect(byPlayer.get(hiders[0])).toBe(0);
    expect(byPlayer.get(hiders[1])).toBe(1);
    expect(byPlayer.get(hiders[2])).toBe(3);
  });
});

describe('RoomEngine — phase:hide payload carries the assigned stickman (B1-B3)', () => {
  it("each hider's phase:hide carries their own D5-spread stickman, distinct per hider, with background/endsAt unchanged", () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 3);
    expect(engine.setHiderCount(hostId, 2)).toEqual({ ok: true }); // force 2 hiders in a 3-player room
    engine.start(hostId);

    const hiders = hiderIdsFrom(events);
    expect(hiders).toHaveLength(2);

    const hideEvents = events.filter((e) => e.event === 'phase:hide');
    expect(hideEvents).toHaveLength(2);

    hideEvents.forEach((e) => {
      const idx = hiders.indexOf(e.target);
      expect(idx).toBeGreaterThanOrEqual(0); // every phase:hide target must be a hider
      const payload = e.payload as { background: Background; endsAt: number; stickman: { x: number } };
      expect(payload.background).toEqual(background);
      expect(typeof payload.endsAt).toBe('number');
      const expectedX = Math.round((background.width * (idx + 1)) / (hiders.length + 1));
      expect(payload.stickman.x).toBe(expectedX);
    });

    // the two hiders' x positions must actually differ (not both collapsing to the same spot)
    const xs = hideEvents.map((e) => (e.payload as { stickman: { x: number } }).stickman.x);
    expect(new Set(xs).size).toBe(2);
  });
});

describe('RoomEngine — hider count: default 50/50 split (D3)', () => {
  it('8-player room with no explicit hiderCount starts with 4 hiders', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 8);
    engine.start(hostId);
    expect(hiderIdsFrom(events)).toHaveLength(4);
  });

  it('7-player room with no explicit hiderCount starts with 3 hiders (seekers outnumber hiders on odd n)', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 7);
    engine.start(hostId);
    expect(hiderIdsFrom(events)).toHaveLength(3);
  });

  it('2-player room (minimum size) starts with exactly 1 hider (boundary)', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 2);
    engine.start(hostId);
    expect(hiderIdsFrom(events)).toHaveLength(1);
  });
});

describe('RoomEngine — room:setHiderCount', () => {
  it('rejects a non-host caller (NOT_HOST)', () => {
    const { engine } = createEngine();
    const { ids } = setupRoom(engine, 4);
    expect(engine.setHiderCount(ids[1], 2)).toEqual({ ok: false, code: 'NOT_HOST' });
  });

  it('rejects being set outside the lobby phase (BAD_PHASE)', () => {
    const { engine } = createEngine();
    const { hostId } = setupRoom(engine, 4);
    engine.start(hostId); // now in 'hide' phase
    expect(engine.setHiderCount(hostId, 1)).toEqual({ ok: false, code: 'BAD_PHASE' });
  });

  it('rejects an out-of-range count: 0 (too low), n, and n+5 (too high) all -> BAD_COUNT', () => {
    const { engine } = createEngine();
    const { hostId } = setupRoom(engine, 4); // valid range is 1..3
    expect(engine.setHiderCount(hostId, 0)).toEqual({ ok: false, code: 'BAD_COUNT' });
    expect(engine.setHiderCount(hostId, 4)).toEqual({ ok: false, code: 'BAD_COUNT' });
    expect(engine.setHiderCount(hostId, 9)).toEqual({ ok: false, code: 'BAD_COUNT' });
  });

  it('rejects a non-integer count reaching the engine directly (defense in depth alongside the zod layer)', () => {
    const { engine } = createEngine();
    const { hostId } = setupRoom(engine, 4);
    expect(engine.setHiderCount(hostId, 1.5)).toEqual({ ok: false, code: 'BAD_COUNT' });
  });

  it('accepts a valid count, applies it at start, and broadcasts it via room:state', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 4); // auto default would be 2
    expect(engine.setHiderCount(hostId, 1)).toEqual({ ok: true });

    const stateAfterSet = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(stateAfterSet.payload).toMatchObject({ hiderCount: 1 });

    engine.start(hostId);
    expect(hiderIdsFrom(events)).toHaveLength(1);
  });

  it('null reverts an explicit count back to auto (floor(n/2))', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 4);
    engine.setHiderCount(hostId, 1);
    expect(engine.setHiderCount(hostId, null)).toEqual({ ok: true });

    const stateAfterNull = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(stateAfterNull.payload).toMatchObject({ hiderCount: null });

    engine.start(hostId);
    expect(hiderIdsFrom(events)).toHaveLength(2); // floor(4/2), not the earlier override of 1
  });

  it('zod schema rejects a non-integer count (the sockets-layer path to BAD_PAYLOAD)', () => {
    expect(zSetHiderCountReq.safeParse({ count: 1.5 }).success).toBe(false);
  });

  it('zod schema rejects a malformed request shape', () => {
    expect(zSetHiderCountReq.safeParse({ count: 'two' }).success).toBe(false);
    expect(zSetHiderCountReq.safeParse({}).success).toBe(false);
  });

  it('zod schema accepts a valid integer and null', () => {
    expect(zSetHiderCountReq.safeParse({ count: 3 }).success).toBe(true);
    expect(zSetHiderCountReq.safeParse({ count: null }).success).toBe(true);
  });
});

describe('RoomEngine — hide-phase confirm gate (D6)', () => {
  it('does not enter seek until every hider has confirmed; partial confirmation keeps the hide phase', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 4); // 2 hiders
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);

    expect(engine.hideConfirm(hiders[0])).toEqual({ ok: true });
    expect(events.some((e) => e.event === 'phase:seek')).toBe(false);
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(lastState.payload).toMatchObject({ phase: 'hide' });
  });

  it('enters seek the moment the last hider confirms', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);

    engine.hideConfirm(hiders[0]);
    expect(events.some((e) => e.event === 'phase:seek')).toBe(false);
    expect(engine.hideConfirm(hiders[1])).toEqual({ ok: true });
    expect(events.some((e) => e.event === 'phase:seek')).toBe(true);
  });

  it('rejects hideConfirm from a non-hider (NOT_HIDER)', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    const seekerId = ids.find((id) => !hiders.includes(id))!;
    expect(engine.hideConfirm(seekerId)).toEqual({ ok: false, code: 'NOT_HIDER' });
  });

  it('treats re-confirming the same hider as idempotent (does not force an early transition)', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);

    expect(engine.hideConfirm(hiders[0])).toEqual({ ok: true });
    expect(engine.hideConfirm(hiders[0])).toEqual({ ok: true }); // idempotent, not an error
    expect(events.some((e) => e.event === 'phase:seek')).toBe(false);
  });

  it('the hide timer expiring enters seek even when a hider never confirmed', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    engine.hideConfirm(hiders[0]); // only 1 of 2 confirms

    expect(events.some((e) => e.event === 'phase:seek')).toBe(false);
    vi.advanceTimersByTime(HIDE_MS);
    expect(events.some((e) => e.event === 'phase:seek')).toBe(true);
  });
});

describe('RoomEngine — click adjudication with multiple hiders (D7)', () => {
  it('rejects a click from any hider, unfound or already found (they are not seekers)', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id));
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    expect(engine.click(hiders[0], MISS_COORD.x, MISS_COORD.y)).toBe('rejected'); // still unfound

    const spot = hitCoordFor(0, 2);
    expect(engine.click(seekerId, spot.x, spot.y)).toBe('hit'); // now hiders[0] is found
    expect(engine.click(hiders[0], MISS_COORD.x, MISS_COORD.y)).toBe('rejected'); // found, still rejected
  });

  it('excludes an already-found hider from further hit tests: re-clicking their spot is a miss, not a duplicate hit', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id));
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    const spot = hitCoordFor(0, 2);
    expect(engine.click(seekerId, spot.x, spot.y)).toBe('hit');
    expect(engine.click(seekerId, spot.x, spot.y)).toBe('miss'); // already found -> excluded from the loop

    const foundEventsForHider0 = events.filter(
      (e) => e.event === 'seek:found' && (e.payload as { playerId: string }).playerId === hiders[0],
    );
    expect(foundEventsForHider0).toHaveLength(1);
  });

  it('reports "locked" for a click made during the 3s post-miss lockout', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id));
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    expect(engine.click(seekerId, MISS_COORD.x, MISS_COORD.y)).toBe('miss');
    expect(engine.click(seekerId, MISS_COORD.x, MISS_COORD.y)).toBe('locked');
  });

  it('allows a click again exactly at the 3s lockout expiry boundary', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id));
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    expect(engine.click(seekerId, MISS_COORD.x, MISS_COORD.y)).toBe('miss');
    vi.advanceTimersByTime(LOCKOUT_MS);
    expect(engine.click(seekerId, MISS_COORD.x, MISS_COORD.y)).toBe('miss'); // unlocked, not 'locked'
  });

  it('hits exactly at the capsule radius + 4px margin boundary coordinate', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id));
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    const spot = hitCoordFor(0, 2);
    expect(engine.click(seekerId, spot.x + 10, spot.y)).toBe('hit');
  });
});

describe('RoomEngine — game end scenarios (D9)', () => {
  it('declares the seekers the winner and marks every hider found when all are hit (all_found)', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id));
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    hiders.forEach((_, i) => {
      const spot = hitCoordFor(i, hiders.length);
      expect(engine.click(seekerId, spot.x, spot.y)).toBe('hit');
    });

    const endEvent = events.find((e) => e.event === 'game:end')!;
    expect(endEvent.payload).toMatchObject({ winner: 'seekers', reason: 'all_found' });
  });

  it('declares the hider team the winner on timeout, with found flags accurate for a partial reveal', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 4); // 2 hiders
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id)); // -> seek phase
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    // find only the first hider before time runs out; the second stays hidden
    const spot = hitCoordFor(0, 2);
    expect(engine.click(seekerId, spot.x, spot.y)).toBe('hit');

    vi.advanceTimersByTime(SEEK_MS);
    const endEvent = events.find((e) => e.event === 'game:end')!;
    expect(endEvent.payload).toMatchObject({ winner: 'hider', reason: 'timeout' });
    const payload = endEvent.payload as { stickmen: Array<{ playerId: string; found: boolean }> };
    const byId = new Map(payload.stickmen.map((s) => [s.playerId, s.found]));
    expect(byId.get(hiders[0])).toBe(true);
    expect(byId.get(hiders[1])).toBe(false);
  });

  it('declares the hider team the winner on timeout when nobody was found at all', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 4);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id));

    vi.advanceTimersByTime(SEEK_MS);
    const endEvent = events.find((e) => e.event === 'game:end')!;
    expect(endEvent.payload).toMatchObject({ winner: 'hider', reason: 'timeout' });
    const payload = endEvent.payload as { stickmen: Array<{ found: boolean }> };
    expect(payload.stickmen.every((s) => !s.found)).toBe(true);
  });
});

describe('RoomEngine — leave edge cases (D8)', () => {
  it('keeps the game running when only some hiders leave (their stickman is dropped, others stay hidden)', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 4); // hiders = ids[0], ids[1]
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id));

    engine.leave(hiders[0]); // one of two hiders leaves mid-seek
    expect(events.some((e) => e.event === 'game:aborted')).toBe(false);
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(lastState.payload).toMatchObject({ phase: 'seek' });

    // the departed hider must be gone from the final stickmen list. The
    // survivor's stickman is NOT repositioned on a leave, so it's still at
    // its original index-1-of-2 spot.
    const seekerId = ids.find((id) => !hiders.includes(id))!;
    const spot = hitCoordFor(1, 2);
    expect(engine.click(seekerId, spot.x, spot.y)).toBe('hit');
    const endEvent = events.find((e) => e.event === 'game:end')!;
    const payload = endEvent.payload as { stickmen: Array<{ playerId: string }> };
    expect(payload.stickmen.map((s) => s.playerId)).toEqual([hiders[1]]);
  });

  it('aborts with hider_left only once every hider has left, not on the first partial departure', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 4); // 2 hiders
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id));

    engine.leave(hiders[0]);
    expect(events.some((e) => e.event === 'game:aborted')).toBe(false);

    engine.leave(hiders[1]); // now 0 hiders remain
    const abortEvent = events.find((e) => e.event === 'game:aborted');
    expect(abortEvent?.payload).toEqual({ reason: 'hider_left' });
    expect(events.some((e) => e.event === 'game:end')).toBe(false);
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(lastState.payload).toMatchObject({ phase: 'lobby', endsAt: null });
  });

  it('does NOT end the game early when an unfound hider leaves while another unfound hider remains (regression: r1 fix)', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 6); // rng=0 -> 3 hiders: ids[0..2]
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    expect(hiders).toHaveLength(3);
    hiders.forEach((id) => engine.hideConfirm(id));
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    // find exactly one of the three hiders, leaving two unfound
    const spot = hitCoordFor(0, 3);
    expect(engine.click(seekerId, spot.x, spot.y)).toBe('hit');
    expect(events.some((e) => e.event === 'game:end')).toBe(false);

    // one of the remaining *unfound* hiders leaves — one unfound hider (hiders[2]) still remains
    engine.leave(hiders[1]);
    expect(events.some((e) => e.event === 'game:aborted')).toBe(false);
    expect(events.some((e) => e.event === 'game:end')).toBe(false); // must NOT end early
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(lastState.payload).toMatchObject({ phase: 'seek' });
  });

  it('ends the game as all_found when a leave removes the last unfound hider', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 4); // 2 hiders
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    hiders.forEach((id) => engine.hideConfirm(id));
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    const spot = hitCoordFor(0, 2);
    expect(engine.click(seekerId, spot.x, spot.y)).toBe('hit'); // hiders[0] found, hiders[1] still unfound

    engine.leave(hiders[1]); // the last unfound hider leaves
    const endEvent = events.find((e) => e.event === 'game:end');
    expect(endEvent?.payload).toMatchObject({ winner: 'seekers', reason: 'all_found' });
    expect(events.some((e) => e.event === 'game:aborted')).toBe(false);
  });

  it('enters seek immediately when a hide-phase leave makes every remaining hider confirmed', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 4); // 2 hiders
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    engine.hideConfirm(hiders[0]); // only hiders[0] confirmed; hiders[1] never will

    expect(events.some((e) => e.event === 'phase:seek')).toBe(false);
    engine.leave(hiders[1]); // the only unconfirmed hider leaves
    expect(events.some((e) => e.event === 'phase:seek')).toBe(true);
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(lastState.payload).toMatchObject({ phase: 'seek' });
  });

  it('aborts with not_enough_players when the last seeker leaves and only hiders remain', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 3); // rng=0 -> 1 hider (floor(3/2))
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    const seekers = ids.filter((id) => !hiders.includes(id));

    seekers.forEach((id) => engine.leave(id));
    const abortEvent = events.find((e) => e.event === 'game:aborted');
    expect(abortEvent?.payload).toEqual({ reason: 'not_enough_players' });
    expect(events.some((e) => e.event === 'game:end')).toBe(false);
  });

  it('aborts with seeker_left when the last non-hider leaves but >= MIN_PLAYERS hiders remain (D3)', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 3);
    engine.setHiderCount(hostId, 2); // 2 hiders, 1 seeker
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    expect(hiders).toHaveLength(2);
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    engine.leave(seekerId); // 2 hiders remain -> players.length(2) is NOT < MIN_PLAYERS(2)
    const abortEvent = events.find((e) => e.event === 'game:aborted');
    expect(abortEvent?.payload).toEqual({ reason: 'seeker_left' });
    expect(events.some((e) => e.event === 'game:end')).toBe(false);
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(lastState.payload).toMatchObject({ phase: 'lobby', endsAt: null });
  });

  it('prioritizes not_enough_players over hider_left when a 2-player game drops below MIN_PLAYERS on a hider leave (D3)', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 2);
    engine.setHiderCount(hostId, 1); // 1 hider, 1 seeker
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    expect(hiders).toHaveLength(1);
    // the hider leaving would independently satisfy hider_left (hiderIds.size -> 0),
    // but only 1 player remains (< MIN_PLAYERS) so not_enough_players must win.
    engine.leave(hiders[0]);

    const abortEvent = events.find((e) => e.event === 'game:aborted');
    expect(abortEvent?.payload).toEqual({ reason: 'not_enough_players' });
  });

  it('keeps the game running and reassigns host when a non-hider host leaves', () => {
    // createRoom consumes 6 rng() calls for the room code first; then
    // pickHiders (k=floor(5/2)=2) consumes 2 more. Sequence [0.9, 0] on
    // those 2 calls: swap(0,4) moves host (pool[0]) to index 4, then
    // swap(1,1) is a no-op -- leaving host outside the first-2 hider slice.
    const rngValues = [0, 0, 0, 0, 0, 0, 0.9, 0];
    let call = 0;
    const { engine, events } = createEngine(() => rngValues[call++] ?? 0);
    const { hostId } = setupRoom(engine, 5);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    expect(hiders).not.toContain(hostId);

    engine.leave(hostId);
    expect(events.some((e) => e.event === 'game:aborted')).toBe(false);
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    const payload = lastState.payload as { phase: string; players: Array<{ isHost: boolean; id: string }> };
    expect(payload.phase).toBe('hide');
    expect(payload.players.filter((p) => p.isHost)).toHaveLength(1);
  });

  it('deletes the room when the last remaining player leaves (boundary)', () => {
    const { engine } = createEngine();
    const { code, hostId, ids } = setupRoom(engine, 2);
    const joinerId = ids.find((id) => id !== hostId)!;

    engine.leave(hostId);
    engine.leave(joinerId); // room now has 0 players -> deleted

    expect(engine.join(code, 'late')).toEqual({ ok: false, code: 'ROOM_NOT_FOUND' });
  });
});

describe('RoomEngine — error cases (unaffected by multi-hider changes)', () => {
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

  it(`rejects the (${MAX_PLAYERS + 1})th player joining a full room (ROOM_FULL)`, () => {
    const { engine } = createEngine();
    const { code } = setupRoom(engine, 2);
    for (let i = 0; i < MAX_PLAYERS - 2; i++) {
      expect(engine.join(code, `extra${i}`).ok).toBe(true);
    }
    expect(engine.join(code, 'overflow')).toEqual({ ok: false, code: 'ROOM_FULL' });
  });

  it('throws after 5 room-code collision retries', () => {
    const { engine } = createEngine(() => 0); // constant rng => same code every attempt
    engine.createRoom('first', PUBLIC_ROOM);
    expect(() => engine.createRoom('second', PUBLIC_ROOM)).toThrow('ROOM_CODE_EXHAUSTED');
  });
});

describe('RoomEngine — hideUpdate authorization (server is the sole judge)', () => {
  it("applies the hider's hideUpdate to the stickman used for later hit tests (normal case)", () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 2); // 1 hider
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    engine.hideUpdate(hiders[0], { x: 200, y: 300, scale: 1, strokes: painted('#ff0000') });
    engine.hideConfirm(hiders[0]);

    // a spot far from the new position does not hit...
    expect(engine.click(seekerId, 720, 930)).toBe('miss');
    vi.advanceTimersByTime(LOCKOUT_MS);
    // ...but the hider's new torso center (200, 300-70) does.
    expect(engine.click(seekerId, 200, 230)).toBe('hit');
  });

  it('ignores a hideUpdate attempted by a non-hider seeker (error/security case)', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 2);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    // A seeker trying to move the stickman during hide phase must be a no-op --
    // the server, not any client, is the sole authority over stickman state.
    engine.hideUpdate(seekerId, { x: 5, y: 5, scale: 1, strokes: painted('#00ff00') });
    engine.hideConfirm(hiders[0]);

    // the default torso (1-hider room, top-center x=720) still hits: the spoofed update never took effect.
    expect(engine.click(seekerId, 720, 80)).toBe('hit');
  });
});

describe('RoomEngine — hideUpdate coordinate/scale clamping (review r1 F1)', () => {
  it('stores an in-bounds hideUpdate unchanged (normal case)', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 2); // background is 1440x2000, 1 hider
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    engine.hideUpdate(hiders[0], { x: 300, y: 400, scale: 1, strokes: painted('#ff0000') });
    engine.hideConfirm(hiders[0]);

    expect(engine.click(seekerId, 300, 330)).toBe('hit'); // torso midpoint: y - 70
  });

  it('accepts coordinates/scale exactly at the background width/height/MAX_SCALE boundary', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 2);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    engine.hideUpdate(hiders[0], {
      x: background.width,
      y: background.height,
      scale: MAX_SCALE,
      strokes: painted('#ff0000'),
    });
    engine.hideConfirm(hiders[0]);

    // torso midpoint at MAX_SCALE, offset -106 (isolated from the scaled arm/leg
    // capsules -- see the equivalent scale-2 case in shared/test/stickman.test.ts).
    expect(engine.click(seekerId, background.width, background.height - 106)).toBe('hit');
  });

  it('clamps out-of-range coordinates and scale so hitTest runs against the clamped position (error/abuse case)', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = setupRoom(engine, 2);
    engine.start(hostId);
    const hiders = hiderIdsFrom(events);
    const seekerId = ids.find((id) => !hiders.includes(id))!;

    // A malicious/buggy hider tries to hide off-canvas and near-invisible.
    engine.hideUpdate(hiders[0], { x: -9999, y: 999_999, scale: 0.01, strokes: painted('#ff0000') });
    engine.hideConfirm(hiders[0]);

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

  it('room:state carries name, isPrivate, and hiderCount (normal case)', () => {
    const { engine, events } = createEngine();
    engine.createRoom('host', { name: '이름표시', isPrivate: true, password: 'pw' });
    const stateEvent = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(stateEvent.payload).toMatchObject({ name: '이름표시', isPrivate: true, hiderCount: null });
    expect(JSON.stringify(stateEvent.payload)).not.toContain('pw');
  });
});

describe('RoomEngine — in-game rooms reject new joins', () => {
  it('rejects joining during the hide phase (BAD_PHASE)', () => {
    const { engine } = createEngine();
    const { code, hostId } = setupRoom(engine, 2);
    engine.start(hostId);
    expect(engine.join(code, 'latecomer')).toEqual({ ok: false, code: 'BAD_PHASE' });
  });

  it('rejects joining during the seek phase (BAD_PHASE)', () => {
    const { engine, events } = createEngine();
    const { code, hostId } = setupRoom(engine, 2);
    engine.start(hostId);
    hiderIdsFrom(events).forEach((id) => engine.hideConfirm(id));
    expect(engine.join(code, 'latecomer')).toEqual({ ok: false, code: 'BAD_PHASE' });
  });
});

describe('RoomEngine — auto-return to lobby after the result countdown', () => {
  /** Plays a full 2-player (1-hider) round to the result phase (seeker finds the default stickman). */
  function playToResult(engine: RoomEngine, events: RecordedEvent[]) {
    const setup = setupRoom(engine, 2);
    engine.start(setup.hostId);
    const hiders = hiderIdsFrom(events);
    const seekerId = setup.ids.find((id) => !hiders.includes(id))!;
    engine.hideConfirm(hiders[0]);
    expect(engine.click(seekerId, 720, 80)).toBe('hit');
    return setup;
  }

  it('sets endsAt to now + RESULT_MS on a found result, then auto-returns to the lobby with the background preserved (normal case)', () => {
    const { engine, events } = createEngine();
    const before = Date.now();
    const { hostId } = playToResult(engine, events);

    const resultState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(resultState.payload).toMatchObject({ phase: 'result', endsAt: before + RESULT_MS });

    vi.advanceTimersByTime(RESULT_MS);
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(lastState.payload).toMatchObject({ phase: 'lobby', endsAt: null, background });

    // background survived the auto-return, so the host can start round 2 immediately
    expect(engine.start(hostId)).toEqual({ ok: true });
  });

  it('sets endsAt to exactly now + RESULT_MS on a timeout result too, then auto-returns (boundary case)', () => {
    const { engine, events } = createEngine();
    const { hostId } = setupRoom(engine, 2);
    engine.start(hostId);
    vi.advanceTimersByTime(HIDE_MS); // enter seek
    const beforeTimeout = Date.now();
    vi.advanceTimersByTime(SEEK_MS); // seek timer expires -> enterResult

    const resultState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(resultState.payload).toMatchObject({
      phase: 'result',
      endsAt: beforeTimeout + SEEK_MS + RESULT_MS,
    });

    vi.advanceTimersByTime(RESULT_MS);
    const lastState = events.filter((e) => e.event === 'room:state').at(-1)!;
    expect(lastState.payload).toMatchObject({ phase: 'lobby', endsAt: null });
  });

  it('clears the result timer when the room empties during the countdown, so the expiry is a no-op (error/cleanup case)', () => {
    const { engine, events } = createEngine();
    const { hostId, ids } = playToResult(engine, events);
    const joinerId = ids.find((id) => id !== hostId)!;

    engine.leave(hostId);
    engine.leave(joinerId); // room now empty -> clearTimers deletes the resultTimer
    events.length = 0;

    expect(() => vi.advanceTimersByTime(RESULT_MS)).not.toThrow();
    expect(events).toHaveLength(0); // no room:state for a room that no longer exists
  });

  it('clears an active seek lockout via the auto-return so round 2 starts unlocked', () => {
    // rng 0 always picks players[0] (the host) as the (sole) hider, in both rounds.
    const { engine, events } = createEngine(() => 0);
    const { code, hostId, ids } = setupRoom(engine, 2);
    const join2 = engine.join(code, 'third');
    if (!join2.ok) throw new Error('join failed');
    engine.start(hostId);
    expect(hiderIdsFrom(events)).toEqual([hostId]);
    engine.hideConfirm(hostId);
    const lockedAt = Date.now();
    const otherSeekerId = ids[1];
    expect(engine.click(otherSeekerId, 0, 0)).toBe('miss'); // otherSeekerId locked until lockedAt + LOCKOUT_MS
    expect(engine.click(join2.playerId, 720, 80)).toBe('hit'); // round ends -> result

    vi.advanceTimersByTime(RESULT_MS); // auto-return fires resetToLobby()

    // RESULT_MS (10s) already exceeds LOCKOUT_MS (3s), so by the time the
    // auto-return lands, the lock would look expired by elapsed time alone
    // even if resetToLobby's lockouts.clear() were dropped. Rewind behind the
    // lock's original expiry so an unlocked verdict can only be explained by
    // the explicit clear, not by time passing.
    vi.setSystemTime(lockedAt + LOCKOUT_MS - 1);

    engine.start(hostId);
    engine.hideConfirm(hostId);
    expect(engine.click(otherSeekerId, 0, 0)).toBe('miss');
  });
});
