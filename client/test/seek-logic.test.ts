import { describe, expect, it } from 'vitest';
import {
  applySeekClickAck,
  canClick,
  lockoutBadgeText,
  RESULT_PULSE_BASE_RADIUS,
  resolveResultText,
  resultPulseRadius,
} from '../src/seek/logic';
import type { SeekEndPayload } from '../src/seek/logic';
import type { RoomStatePublic } from 'shared/protocol';

const STICKMAN = {
  x: 100,
  y: 100,
  scale: 1,
  colors: {
    head: '#000000',
    torso: '#000000',
    leftArm: '#000000',
    rightArm: '#000000',
    leftLeg: '#000000',
    rightLeg: '#000000',
  },
};

function makeRoom(players: RoomStatePublic['players']): RoomStatePublic {
  return { code: 'ABCDEF', phase: 'seek', players, background: null, endsAt: null };
}

describe('canClick (D3): local lockout gate mirrors server Date.now() < lockedUntil', () => {
  it('allows a click when there is no active lock (normal)', () => {
    expect(canClick(1_000, null)).toBe(true);
  });

  it('blocks a click 1ms before the lock expires (error/blocked)', () => {
    expect(canClick(2_999, 3_000)).toBe(false);
  });

  it('allows a click exactly at lockedUntil, matching the server\'s strict-less-than gate (boundary)', () => {
    expect(canClick(3_000, 3_000)).toBe(true);
  });
});

describe('lockoutBadgeText (D5): countdown badge text', () => {
  it('shows the ceiling of remaining seconds while locked (normal)', () => {
    expect(lockoutBadgeText(0, 2_500)).toBe('3…');
  });

  it('returns null once there is no active lock (error/absent)', () => {
    expect(lockoutBadgeText(0, null)).toBeNull();
  });

  it('returns null exactly at lockedUntil, the instant the lock releases (boundary)', () => {
    expect(lockoutBadgeText(3_000, 3_000)).toBeNull();
  });
});

describe('applySeekClickAck (D3): ack -> next lockedUntil', () => {
  it('starts a fresh LOCKOUT_MS=3000 lock on a miss (normal)', () => {
    expect(applySeekClickAck({ ok: true, result: 'miss' }, 10_000, null)).toBe(13_000);
  });

  it('leaves the lock untouched on a failed (ok:false) ack (error/defensive)', () => {
    expect(applySeekClickAck({ ok: false, code: 'BAD_PAYLOAD' }, 10_000, null)).toBeNull();
    expect(applySeekClickAck({ ok: false, code: 'BAD_PAYLOAD' }, 10_000, 12_000)).toBe(12_000);
  });

  it('leaves the lock untouched on hit and rejected (normal: no-op results)', () => {
    expect(applySeekClickAck({ ok: true, result: 'hit' }, 10_000, null)).toBeNull();
    expect(applySeekClickAck({ ok: true, result: 'rejected' }, 10_000, 5_000)).toBe(5_000);
  });

  it('on a locked ack, extends but never shortens an existing lock past it (boundary: max, not overwrite)', () => {
    // already locked well past the 1s info-flash window -> stays at the longer value
    expect(applySeekClickAck({ ok: true, result: 'locked' }, 10_000, 12_000)).toBe(12_000);
    // no active lock recorded locally (race) -> shows the 1s flash
    expect(applySeekClickAck({ ok: true, result: 'locked' }, 10_000, null)).toBe(11_000);
  });
});

describe('resolveResultText (D8): winner/reason -> displayed text', () => {
  it('names the finder by nickname when winner=seekers, reason=found, foundBy resolves (normal)', () => {
    const end: SeekEndPayload = { winner: 'seekers', foundBy: 'p2', stickman: STICKMAN, reason: 'found' };
    const room = makeRoom([
      { id: 'p1', nickname: '숨은이', isHost: true },
      { id: 'p2', nickname: '찾은이', isHost: false },
    ]);
    expect(resolveResultText(end, room)).toBe('찾은이님이 찾았다!');
  });

  it('falls back to "게임 종료" when the end payload has not arrived yet (error/defensive)', () => {
    expect(resolveResultText(null, makeRoom([]))).toBe('게임 종료');
  });

  it('falls back to a nameless finder text when foundBy does not resolve to a known player (error/defensive)', () => {
    const end: SeekEndPayload = { winner: 'seekers', foundBy: 'ghost', stickman: STICKMAN, reason: 'found' };
    expect(resolveResultText(end, makeRoom([{ id: 'p1', nickname: '숨은이', isHost: true }]))).toBe('찾았다!');
  });

  it('shows the timeout text when the hider wins by running out the clock (boundary: hider+timeout)', () => {
    const end: SeekEndPayload = { winner: 'hider', stickman: STICKMAN, reason: 'timeout' };
    expect(resolveResultText(end, makeRoom([]))).toBe('끝까지 못 찾았다…');
  });

  it('shows the generic hider-win text for a non-timeout hider win (boundary: hider, non-timeout)', () => {
    const end: SeekEndPayload = { winner: 'hider', stickman: STICKMAN, reason: 'found' };
    expect(resolveResultText(end, makeRoom([]))).toBe('숨은 사람 승리');
  });

  it('shows the forfeit text regardless of which side is recorded as winner (boundary: forfeit overrides)', () => {
    const seekerForfeit: SeekEndPayload = { winner: 'seekers', stickman: null, reason: 'forfeit' };
    const hiderForfeit: SeekEndPayload = { winner: 'hider', stickman: null, reason: 'forfeit' };
    expect(resolveResultText(seekerForfeit, makeRoom([]))).toBe('상대가 나갔어요');
    expect(resolveResultText(hiderForfeit, makeRoom([]))).toBe('상대가 나갔어요');
  });
});

describe('resultPulseRadius (D8): 1.2s-period sinusoidal highlight ring', () => {
  it('is exactly the base radius at the start of the animation (normal: phase=0)', () => {
    expect(resultPulseRadius(0, 0)).toBeCloseTo(RESULT_PULSE_BASE_RADIUS);
  });

  it('is exactly the base radius again one full period later (boundary: phase wraps at period)', () => {
    expect(resultPulseRadius(1_200, 0)).toBeCloseTo(RESULT_PULSE_BASE_RADIUS);
  });

  it('peaks above the base radius a quarter-period in and troughs below it three-quarters in (normal: amplitude swing)', () => {
    expect(resultPulseRadius(300, 0)).toBeCloseTo(70);
    expect(resultPulseRadius(900, 0)).toBeCloseTo(50);
  });

  it('is independent of the absolute clock value, only the elapsed time since startedAt matters (error/defensive: large now)', () => {
    const startedAt = 1_700_000_000_000;
    expect(resultPulseRadius(startedAt + 300, startedAt)).toBeCloseTo(70);
  });
});
