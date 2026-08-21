import type { AppContext } from './net';
import { leaveRoom } from './net';
import { createPhaseRouter } from './phases';
import './lobby';
import './hide';
import { initSeek } from './seek';

const ABORT_REASON_TEXT: Record<string, string> = {
  hider_left: '숨는 사람이 나가서 게임이 종료됐어요',
  seeker_left: '찾는 사람이 나가서 게임이 종료됐어요',
  not_enough_players: '인원이 부족해서 게임이 종료됐어요',
};

// Wires socket events to the phase router and mounts the initial screen.
// The server only sends room:state to sockets that are already in a room, so
// the first screen must be mounted here, not in a room:state handler.
export function bootstrap(root: HTMLElement, ctx: AppContext): void {
  const router = createPhaseRouter(root, ctx);
  initSeek(ctx);

  // The server never sends room:state to a socket that just left (t1
  // contract), so the transition back to the home screen is entirely this
  // function's responsibility -- including the same-phase ('lobby') case,
  // which needs the force remount to actually repaint.
  async function leaveToHome(): Promise<void> {
    await leaveRoom(ctx);
    ctx.state.playerId = null;
    ctx.state.role = null;
    ctx.state.room = null;
    ctx.state.hidePayload = null;
    ctx.state.abortNotice = null;
    router.onPhase('lobby', { force: true });
  }
  ctx.leaveToHome = leaveToHome;

  ctx.socket.on('room:state', (state) => {
    ctx.state.room = state;
    if (state.phase !== 'hide') {
      ctx.state.hidePayload = null;
    }
    if (state.phase === 'lobby') {
      // Back in the waiting room (restart or abort): the previous game's role
      // must not leak into the next round's hide-screen mount.
      ctx.state.role = null;
    } else {
      ctx.state.abortNotice = null;
    }
    router.onPhase(state.phase);
  });

  ctx.socket.on('game:aborted', ({ reason }) => {
    ctx.state.abortNotice = ABORT_REASON_TEXT[reason] ?? ABORT_REASON_TEXT.not_enough_players;
  });

  ctx.socket.on('game:role', ({ role }) => {
    ctx.state.role = role;
  });

  ctx.socket.on('phase:hide', (payload) => {
    ctx.state.hidePayload = payload;
  });

  router.onPhase('lobby');
}
