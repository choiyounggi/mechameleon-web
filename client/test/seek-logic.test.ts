import { describe, expect, it } from 'vitest';
import {
  applySeekClickAck,
  canClick,
  hiderOutlineAlpha,
  lockoutBadgeText,
  RESULT_PULSE_BASE_RADIUS,
  resolveResultText,
  resultPulseRadius,
  seekBodyStyle,
} from '../src/seek/logic';
import type { SeekEndPayload } from '../src/seek/logic';
import type { StickmanState } from 'shared/protocol';

const STICKMAN: StickmanState = { x: 100, y: 100, scale: 1, strokes: [] };

function makeStickman(playerId: string, found: boolean) {
  return { playerId, nickname: `p-${playerId}`, stickman: STICKMAN, found };
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

describe('resolveResultText (D5/D8): winner -> displayed text', () => {
  it('reads as a clean sweep when the seekers win, regardless of who found whom (normal)', () => {
    const end: SeekEndPayload = {
      winner: 'seekers',
      stickmen: [makeStickman('h1', true), makeStickman('h2', true)],
      reason: 'all_found',
    };
    expect(resolveResultText(end)).toBe('다 찾았다!');
  });

  it('falls back to "게임 종료" when the end payload has not arrived yet (error/defensive)', () => {
    expect(resolveResultText(null)).toBe('게임 종료');
  });

  it('counts only the unfound hiders when the hider side wins a timeout (normal: found/unfound mixed)', () => {
    const end: SeekEndPayload = {
      winner: 'hider',
      stickmen: [makeStickman('h1', true), makeStickman('h2', false), makeStickman('h3', false)],
      reason: 'timeout',
    };
    expect(resolveResultText(end)).toBe('2명이 끝까지 숨었다!');
  });

  it('counts zero survivors for an empty stickmen list (boundary: empty array defense)', () => {
    const end: SeekEndPayload = { winner: 'hider', stickmen: [], reason: 'timeout' };
    expect(resolveResultText(end)).toBe('0명이 끝까지 숨었다!');
  });
});

describe('seekBodyStyle (D3): per-hider render mode in the seek overlay', () => {
  it('stays camouflaged (\'seek\') for a hider not yet in the found set (normal)', () => {
    expect(seekBodyStyle('h1', new Set())).toBe('seek');
  });

  it('switches to the default outlined style (undefined) once found (normal)', () => {
    expect(seekBodyStyle('h1', new Set(['h1']))).toBeUndefined();
  });

  it('only reveals the matching id, leaving other hiders camouflaged (boundary: mixed found set)', () => {
    const foundIds = new Set(['h2']);
    expect(seekBodyStyle('h1', foundIds)).toBe('seek');
    expect(seekBodyStyle('h2', foundIds)).toBeUndefined();
  });
});

describe('hiderOutlineAlpha (D3): per-hider outline reveal alpha in the seek overlay', () => {
  it('is always fully outlined once found, regardless of color count or remaining time (normal: found)', () => {
    expect(hiderOutlineAlpha('h1', new Set(['h1']), 4, 90_000)).toBe(1);
  });

  it('stays fully hidden for an unfound 4-color hider throughout the seek phase (normal: 4+ colors)', () => {
    expect(hiderOutlineAlpha('h1', new Set(), 4, 90_000)).toBe(0);
  });

  it('is halfway revealed for an unfound 2-color hider at half of its 60s reveal window (normal: mid-fade)', () => {
    expect(hiderOutlineAlpha('h1', new Set(), 2, 30_000)).toBeCloseTo(0.5);
  });

  it('is fully outlined for an unfound 0-color hider, same as the <=1 full-outline bucket (boundary: colorCount below 1)', () => {
    expect(hiderOutlineAlpha('h1', new Set(), 0, 90_000)).toBe(1);
  });

  it('clamps to full outline for a 2-color hider with a negative (overrun) remaining time (error: extreme remainingMs)', () => {
    expect(hiderOutlineAlpha('h1', new Set(), 2, -1_000)).toBe(1);
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
