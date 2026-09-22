import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from 'shared/protocol';
import captureRouter from './capture/index';
import { createShutdown, healthzHandler, installFatalHandlers, runClosers, wireShutdownSignals } from './lifecycle';
import { registerSocketHandlers } from './sockets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use('/api', captureRouter);
app.get('/healthz', healthzHandler);
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

// D14: SIGTERM/SIGINT -> stop accepting new socket/HTTP work, await
// registered closers, clear in-flight room timers, then exit. A force-exit
// timer bounds shutdown if any step hangs. uncaughtException/
// unhandledRejection are fatal: log with a stack and exit non-zero, never
// resume (process state after an uncaught exception is undefined).
const shutdown = createShutdown({
  io,
  httpServer,
  engine,
  runClosers,
  exit: (code) => process.exit(code),
});
wireShutdownSignals(process, shutdown);
installFatalHandlers(process, (message, err) => {
  console.error(message, err instanceof Error ? err.stack : err);
});
