import type { AppContext } from './net';
import { createPhaseRouter } from './phases';
import './lobby';
import './hide';
import { initSeek } from './seek';

// Wires socket events to the phase router and mounts the initial screen.
// The server only sends room:state to sockets that are already in a room, so
// the first screen must be mounted here, not in a room:state handler.
export function bootstrap(root: HTMLElement, ctx: AppContext): void {
  const router = createPhaseRouter(root, ctx);
  initSeek(ctx);

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
    ctx.state.abortNotice =
      reason === 'hider_left'
        ? '숨는 사람이 나가서 게임이 종료됐어요'
        : '인원이 부족해서 게임이 종료됐어요';
  });

  ctx.socket.on('game:role', ({ role }) => {
    ctx.state.role = role;
  });

  ctx.socket.on('phase:hide', (payload) => {
    ctx.state.hidePayload = payload;
  });

  router.onPhase('lobby');
}
