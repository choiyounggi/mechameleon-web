import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from 'shared/protocol';
import captureRouter from './capture/index';
import { registerSocketHandlers } from './sockets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use('/api', captureRouter);
// Reserved for the client build (owned by the client-hide/client-seek tasks);
// harmless if client/dist doesn't exist yet -- express.static just 404s.
app.use(express.static(path.join(__dirname, '../../client/dist')));

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer);
const engine = registerSocketHandlers(io);

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, () => {
  console.log(`stickmeleon server listening on :${PORT}`);
});

// D14: SIGTERM -> stop accepting new socket/HTTP work, clear in-flight room
// timers, then exit. A force-exit timer bounds shutdown if close() hangs.
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  const forceExit = setTimeout(() => process.exit(1), 5_000);
  forceExit.unref();

  io.close(() => {
    httpServer.close(() => {
      engine.shutdown();
      clearTimeout(forceExit);
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
