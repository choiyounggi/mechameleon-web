import { LOCKOUT_MS, type RoomStatePublic, type SeekClickAck, type StickmanState, type Winner } from 'shared/protocol';

// Shape of the 'game:end' server payload (shared/protocol.ts ServerToClientEvents),
// named locally since the protocol only inlines it on the event map (D8).
export interface SeekEndPayload {
  winner: Winner;
  foundBy?: string;
  stickman: StickmanState | null;
  reason: 'found' | 'timeout';
}

// D3: mirrors the server's `Date.now() < lockedUntil` reject gate exactly, so
// the client only ever sends a click the server would also accept.
export function canClick(now: number, lockedUntil: number | null): boolean {
  return lockedUntil === null || now >= lockedUntil;
}

// D5: "3…2…1" style countdown text for the lockout badge, null when there is
// no active lock to show.
export function lockoutBadgeText(now: number, lockedUntil: number | null): string | null {
  if (lockedUntil === null) return null;
  const remainingMs = lockedUntil - now;
  if (remainingMs <= 0) return null;
  return `${Math.ceil(remainingMs / 1000)}…`;
}

// D3: turns a seekClick ack into the next lockedUntil value. 'hit'/'rejected'
// and a failed (ok:false) ack leave the lock untouched -- a 'hit' transition is
// handled by the game:end broadcast, not by locking the clicker out. A 'locked'
// ack only ever means the local gate raced the server's clock, so it extends
// (never shortens) the badge display rather than resetting a real 3s lock.
export function applySeekClickAck(ack: SeekClickAck, now: number, lockedUntil: number | null): number | null {
  if (!ack.ok) return lockedUntil;
  if (ack.result === 'miss') return now + LOCKOUT_MS;
  if (ack.result === 'locked') return Math.max(lockedUntil ?? 0, now + 1_000);
  return lockedUntil;
}

// D8: winner/reason -> displayed result text.
export function resolveResultText(end: SeekEndPayload | null, room: RoomStatePublic | null): string {
  if (end === null) return '게임 종료';
  if (end.winner === 'hider') {
    return end.reason === 'timeout' ? '끝까지 못 찾았다…' : '숨은 사람 승리';
  }
  const finder = room?.players.find((p) => p.id === end.foundBy);
  return finder ? `${finder.nickname}님이 찾았다!` : '찾았다!';
}

// D8: result-screen highlight ring radius, a 1.2s-period sinusoidal pulse
// around a 60px base radius (rgba(200,80,80,0.5) stroke, lineWidth 3, applied
// by the caller). Pure so the pulse curve is testable without a canvas.
export const RESULT_PULSE_PERIOD_MS = 1_200;
export const RESULT_PULSE_BASE_RADIUS = 60;
const RESULT_PULSE_AMPLITUDE = 10;

export function resultPulseRadius(now: number, startedAt: number): number {
  const phase = ((now - startedAt) % RESULT_PULSE_PERIOD_MS) / RESULT_PULSE_PERIOD_MS;
  return RESULT_PULSE_BASE_RADIUS + RESULT_PULSE_AMPLITUDE * Math.sin(2 * Math.PI * phase);
}
