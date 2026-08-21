import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Server } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClientToServerEvents, ServerToClientEvents } from 'shared/protocol';
import captureRouter from '../src/capture/index';
import { registerSocketHandlers } from '../src/sockets';

describe('server smoke test (in-process HTTP + socket.io)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server<ClientToServerEvents, ServerToClientEvents>;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', captureRouter);

    httpServer = createServer(app);
    io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer);
    registerSocketHandlers(io);

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function connect(): ClientSocket {
    return ioClient(baseUrl, { transports: ['websocket'] });
  }

  function waitConnected(socket: ClientSocket): Promise<void> {
    return new Promise((resolve) => socket.on('connect', () => resolve()));
  }

  it('creates a room, joins, starts, and both clients receive their role', async () => {
    const host = connect();
    const joiner = connect();
    try {
      await Promise.all([waitConnected(host), waitConnected(joiner)]);

      const createAck: any = await new Promise((resolve) =>
        host.emit('room:create', { nickname: 'host', roomName: '몰컴방', isPrivate: false }, resolve),
      );
      expect(createAck.ok).toBe(true);
      const code: string = createAck.code;

      const joinAck: any = await new Promise((resolve) =>
        joiner.emit('room:join', { code, nickname: 'joiner' }, resolve),
      );
      expect(joinAck.ok).toBe(true);

      const setBgAck: any = await new Promise((resolve) =>
        host.emit(
          'room:setBackground',
          { background: { imageUrl: 'https://example.com/a.png', width: 1440, height: 2000 } },
          resolve,
        ),
      );
      expect(setBgAck.ok).toBe(true);

      const roles: Record<string, string> = {};
      const gotHostRole = new Promise<void>((resolve) =>
        host.on('game:role', (p) => {
          roles.host = p.role;
          resolve();
        }),
      );
      const gotJoinerRole = new Promise<void>((resolve) =>
        joiner.on('game:role', (p) => {
          roles.joiner = p.role;
          resolve();
        }),
      );

      const startAck: any = await new Promise((resolve) => host.emit('game:start', resolve));
      expect(startAck.ok).toBe(true);

      await Promise.all([gotHostRole, gotJoinerRole]);
      expect(new Set([roles.host, roles.joiner])).toEqual(new Set(['hider', 'seeker']));
    } finally {
      host.close();
      joiner.close();
    }
  });

  it('sends the creator an initial room:state right after room:create (review r1 F2)', async () => {
    const host = connect();
    try {
      await waitConnected(host);

      const gotState = new Promise<any>((resolve) => host.on('room:state', resolve));
      const createAck: any = await new Promise((resolve) =>
        host.emit('room:create', { nickname: 'solo-host', roomName: '솔로방', isPrivate: false }, resolve),
      );
      expect(createAck.ok).toBe(true);

      const state = await gotState;
      expect(state.code).toBe(createAck.code);
      expect(state.players).toHaveLength(1);
      expect(state.players[0].isHost).toBe(true);
    } finally {
      host.close();
    }
  });

  it('acks BAD_PAYLOAD for an invalid room:create payload', async () => {
    const client = connect();
    try {
      await waitConnected(client);
      const ack = await new Promise((resolve) => client.emit('room:create', { nickname: '', roomName: 'x', isPrivate: false }, resolve));
      expect(ack).toEqual({ ok: false, code: 'BAD_PAYLOAD' });
    } finally {
      client.close();
    }
  });

  it('sends the joiner a room:state right after room:join succeeds', async () => {
    const host = connect();
    const joiner = connect();
    try {
      const createAck: any = await new Promise((resolve) =>
        host.emit('room:create', { nickname: 'host', roomName: '입장검증', isPrivate: false }, resolve),
      );
      expect(createAck.ok).toBe(true);

      const joinerState = new Promise((resolve) => joiner.once('room:state', resolve));
      const joinAck: any = await new Promise((resolve) =>
        joiner.emit('room:join', { code: createAck.code, nickname: 'joiner' }, resolve),
      );
      expect(joinAck.ok).toBe(true);
      const state: any = await joinerState;
      expect(state.code).toBe(createAck.code);
      expect(state.players).toHaveLength(2);
      expect(state.name).toBe('입장검증');
    } finally {
      host.disconnect();
      joiner.disconnect();
    }
  });

  it('accepts a relative /api/screenshots imageUrl in room:setBackground (regression: capture URLs are relative)', async () => {
    const host = connect();
    const guest = connect();
    try {
      const createAck: any = await new Promise((resolve) =>
        host.emit('room:create', { nickname: 'host', roomName: '배경검증', isPrivate: false }, resolve),
      );
      await new Promise((resolve) => guest.emit('room:join', { code: createAck.code, nickname: 'g' }, resolve));

      const bgAck: any = await new Promise((resolve) =>
        host.emit(
          'room:setBackground',
          { background: { imageUrl: '/api/screenshots/abc.png', width: 1440, height: 900 } },
          resolve,
        ),
      );
      expect(bgAck).toEqual({ ok: true });

      const rejected: any = await new Promise((resolve) =>
        host.emit(
          'room:setBackground',
          { background: { imageUrl: 'javascript:alert(1)', width: 1440, height: 900 } },
          resolve,
        ),
      );
      expect(rejected).toEqual({ ok: false, code: 'BAD_PAYLOAD' });
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('room:leave keeps the socket connected, unsubscribes it from room broadcasts, and lets the same socket re-enter via room:create', async () => {
    const host = connect();
    const guest = connect();
    try {
      await Promise.all([waitConnected(host), waitConnected(guest)]);

      const createAck: any = await new Promise((resolve) =>
        host.emit('room:create', { nickname: 'host', roomName: '나가기검증', isPrivate: false }, resolve),
      );
      const guestJoinAck: any = await new Promise((resolve) =>
        guest.emit('room:join', { code: createAck.code, nickname: 'guest' }, resolve),
      );
      expect(guestJoinAck.ok).toBe(true);

      // register BEFORE leaving so this also catches a leak of the final
      // room:state that engine.leave() broadcasts synchronously while the
      // room:leave handler is still producing its ack (review r1/F1).
      let stateCountAfterLeave = 0;
      guest.on('room:state', () => {
        stateCountAfterLeave++;
      });

      const leaveAck: any = await new Promise((resolve) => guest.emit('room:leave', resolve));
      expect(leaveAck).toEqual({ ok: true });

      // flush any in-flight event delivery before asserting silence
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stateCountAfterLeave).toBe(0);

      // the left socket must not receive further broadcasts for the old room either
      const bgAck: any = await new Promise((resolve) =>
        host.emit(
          'room:setBackground',
          { background: { imageUrl: 'https://example.com/b.png', width: 1440, height: 2000 } },
          resolve,
        ),
      );
      expect(bgAck.ok).toBe(true);
      expect(stateCountAfterLeave).toBe(0);

      // the same socket (still connected) can start a fresh room
      const secondCreateAck: any = await new Promise((resolve) =>
        guest.emit('room:create', { nickname: 'guest-again', roomName: '재입장방', isPrivate: false }, resolve),
      );
      expect(secondCreateAck.ok).toBe(true);
      expect(secondCreateAck.code).not.toBe(createAck.code);
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('room:leave on a socket that never joined a room is a harmless no-op ack (idempotent)', async () => {
    const client = connect();
    try {
      await waitConnected(client);
      const leaveAck: any = await new Promise((resolve) => client.emit('room:leave', resolve));
      expect(leaveAck).toEqual({ ok: true });
    } finally {
      client.disconnect();
    }
  });

});
