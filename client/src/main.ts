import './style.css';
import { createAppContext } from './net';
import { createPhaseRouter } from './phases';
import './lobby';
import './hide';
import { initSeek } from './seek';

const ctx = createAppContext();
const root = document.getElementById('root');
if (!root) {
  throw new Error('missing #root element');
}

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
