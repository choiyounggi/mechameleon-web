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
    router.onPhase(state.phase);
  });

  ctx.socket.on('game:role', ({ role }) => {
    ctx.state.role = role;
  });

  ctx.socket.on('phase:hide', (payload) => {
    ctx.state.hidePayload = payload;
  });

  router.onPhase('lobby');
}
