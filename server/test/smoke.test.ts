import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Server } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClientToServerEvents, ServerToClientEvents } from 'shared/protocol';
import captureRouter from '../src/capture/index';
import { healthzHandler } from '../src/lifecycle';
import { registerSocketHandlers } from '../src/sockets';

describe('server smoke test (in-process HTTP + socket.io)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server<ClientToServerEvents, ServerToClientEvents>;
  let baseUrl: string;
  let engine: ReturnType<typeof registerSocketHandlers>;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', captureRouter);
    app.get('/healthz', healthzHandler);

    httpServer = createServer(app);
    io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer);
    engine = registerSocketHandlers(io);

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

  it('GET /healthz responds 200 { ok: true }', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('a throwing handler acks INTERNAL, the process stays up, and a second socket still works (crash guard)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const badClient = connect();
    const goodClient = connect();
    try {
      await Promise.all([waitConnected(badClient), waitConnected(goodClient)]);
      const createSpy = vi.spyOn(engine, 'createRoom').mockImplementation(() => {
        throw new Error('injected crash');
      });

      const badAck = await new Promise((resolve) =>
        badClient.emit('room:create', { nickname: 'bad', roomName: 'x', isPrivate: false }, resolve),
      );
      expect(badAck).toEqual({ ok: false, code: 'INTERNAL' });
      createSpy.mockRestore();

      const goodAck: any = await new Promise((resolve) =>
        goodClient.emit('room:create', { nickname: 'good', roomName: 'y', isPrivate: false }, resolve),
      );
      expect(goodAck.ok).toBe(true);
    } finally {
      errorSpy.mockRestore();
      badClient.close();
      goodClient.close();
    }
  });

  it('disconnect during hide phase keeps the seat: a new socket room:rejoin within the grace gets the same playerId back, phase preserved, and the other client received NO game:aborted', async () => {
    const host = connect();
    const guest = connect();
    try {
      await Promise.all([waitConnected(host), waitConnected(guest)]);
      const createAck: any = await new Promise((resolve) =>
        host.emit('room:create', { nickname: 'host', roomName: '재접속검증', isPrivate: false }, resolve),
      );
      const code: string = createAck.code;
      const guestJoinAck: any = await new Promise((resolve) =>
        guest.emit('room:join', { code, nickname: 'guest' }, resolve),
      );
      expect(guestJoinAck.ok).toBe(true);
      const guestPlayerId: string = guestJoinAck.playerId;

      const bgAck: any = await new Promise((resolve) =>
        host.emit(
          'room:setBackground',
          { background: { imageUrl: 'https://example.com/x.png', width: 1440, height: 2000 } },
          resolve,
        ),
      );
      expect(bgAck.ok).toBe(true);

      let hostSawAbort = false;
      host.on('game:aborted', () => { hostSawAbort = true; });

      const startAck: any = await new Promise((resolve) => host.emit('game:start', resolve));
      expect(startAck.ok).toBe(true);

      guest.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const newSocket = connect();
      try {
        await waitConnected(newSocket);
        const gotState = new Promise<any>((resolve) => newSocket.on('room:state', resolve));
        const rejoinAck: any = await new Promise((resolve) =>
          newSocket.emit('room:rejoin', { playerId: guestPlayerId }, resolve),
        );
        expect(rejoinAck).toEqual({ ok: true, playerId: guestPlayerId });

        const state = await gotState;
        expect(state.phase).toBe('hide'); // phase preserved BY NAME, not merely inferred from the player list
        expect(state.players.map((p: any) => p.id)).toContain(guestPlayerId);
      } finally {
        newSocket.close();
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(hostSawAbort).toBe(false);
    } finally {
      host.disconnect();
      guest.close();
    }
  });

  it('room:rejoin with a bogus playerId acks ROOM_NOT_FOUND (error case)', async () => {
    const client = connect();
    try {
      await waitConnected(client);
      const rejoinAck: any = await new Promise((resolve) =>
        client.emit('room:rejoin', { playerId: '11111111-1111-4111-8111-111111111111' }, resolve),
      );
      expect(rejoinAck).toEqual({ ok: false, code: 'ROOM_NOT_FOUND' });
    } finally {
      client.close();
    }
  });

  it('room:rejoin acks BAD_PAYLOAD for a non-uuid playerId (error case)', async () => {
    const client = connect();
    try {
      await waitConnected(client);
      const ack = await new Promise((resolve) => client.emit('room:rejoin', { playerId: 'nope' }, resolve));
      expect(ack).toEqual({ ok: false, code: 'BAD_PAYLOAD' });
    } finally {
      client.close();
    }
  });

  it('a socket that already has an identity cannot room:rejoin as someone else (ALREADY_BOUND, boundary)', async () => {
    const client = connect();
    try {
      await waitConnected(client);
      const createAck: any = await new Promise((resolve) =>
        client.emit('room:create', { nickname: 'x', roomName: 'y', isPrivate: false }, resolve),
      );
      expect(createAck.ok).toBe(true);

      const rejoinAck: any = await new Promise((resolve) =>
        client.emit('room:rejoin', { playerId: createAck.playerId }, resolve),
      );
      expect(rejoinAck).toEqual({ ok: false, code: 'ALREADY_BOUND' });
    } finally {
      client.close();
    }
  });

  it('room:rejoin acks INTERNAL (not a stale success) when snapshotFor throws -- proves the ack is genuinely the terminal action', async () => {
    const host = connect();
    try {
      await waitConnected(host);
      const createAck: any = await new Promise((resolve) =>
        host.emit('room:create', { nickname: 'h', roomName: 'z', isPrivate: false }, resolve),
      );
      const playerId: string = createAck.playerId;
      host.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const snapshotSpy = vi.spyOn(engine, 'snapshotFor').mockImplementation(() => {
        throw new Error('injected crash');
      });
      const newSocket = connect();
      try {
        await waitConnected(newSocket);
        const ack = await new Promise((resolve) => newSocket.emit('room:rejoin', { playerId }, resolve));
        // If the implementation acked success BEFORE calling snapshotFor (the
        // rejected D10 ordering), this ack would be {ok:true,...} instead --
        // INTERNAL here proves snapshotFor ran, and threw, before the ack.
        expect(ack).toEqual({ ok: false, code: 'INTERNAL' });
      } finally {
        newSocket.close();
        snapshotSpy.mockRestore();
        errorSpy.mockRestore();
      }
    } finally {
      host.close();
    }
  });

  it("a superseded socket's delayed disconnect is a no-op: no markDisconnected call, no abort, and the new socket's room membership survives intact (re-plan round 1, G1)", async () => {
    const host = connect();
    const guestOriginal = connect();
    try {
      await Promise.all([waitConnected(host), waitConnected(guestOriginal)]);
      const createAck: any = await new Promise((resolve) =>
        host.emit('room:create', { nickname: 'host', roomName: '중복소켓검증', isPrivate: false }, resolve),
      );
      const code: string = createAck.code;
      const guestJoinAck: any = await new Promise((resolve) =>
        guestOriginal.emit('room:join', { code, nickname: 'guest' }, resolve),
      );
      expect(guestJoinAck.ok).toBe(true);
      const guestPlayerId: string = guestJoinAck.playerId;

      const bgAck: any = await new Promise((resolve) =>
        host.emit(
          'room:setBackground',
          { background: { imageUrl: 'https://example.com/y.png', width: 1440, height: 2000 } },
          resolve,
        ),
      );
      expect(bgAck.ok).toBe(true);

      const startAck: any = await new Promise((resolve) => host.emit('game:start', resolve));
      expect(startAck.ok).toBe(true);

      // guestOriginal's socket is still technically open (its own transport
      // has not yet noticed the peer died) while a NEW socket rejoins early
      // -- the early-reconnect race D17's guard exists for.
      const guestNew = connect();
      try {
        await waitConnected(guestNew);
        const rejoinAck: any = await new Promise((resolve) =>
          guestNew.emit('room:rejoin', { playerId: guestPlayerId }, resolve),
        );
        expect(rejoinAck).toEqual({ ok: true, playerId: guestPlayerId });

        const markDisconnectedSpy = vi.spyOn(engine, 'markDisconnected');
        let sawAbortBeforeHostLeaves = false;
        host.on('game:aborted', () => { sawAbortBeforeHostLeaves = true; });

        // The now-superseded original socket's disconnect arrives late.
        guestOriginal.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(markDisconnectedSpy).not.toHaveBeenCalled();
        expect(sawAbortBeforeHostLeaves).toBe(false);
        markDisconnectedSpy.mockRestore();

        // Prove guestNew's socket.io room membership (bindPlayer's
        // socket.join) survived the stale disconnect untouched: an
        // unrelated broadcast (host voluntarily leaving, which drops the
        // room below MIN_PLAYERS and aborts) must still reach guestNew.
        const guestNewGotState = new Promise<any>((resolve) => guestNew.on('room:state', resolve));
        const hostLeaveAck: any = await new Promise((resolve) => host.emit('room:leave', resolve));
        expect(hostLeaveAck).toEqual({ ok: true });
        const stateAfterHostLeaves = await guestNewGotState;
        expect(stateAfterHostLeaves.players.map((p: any) => p.id)).toContain(guestPlayerId);
      } finally {
        guestNew.close();
      }
    } finally {
      host.close();
      guestOriginal.close();
    }
  });
});
