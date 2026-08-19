import { io } from 'socket.io-client';
const url = 'http://localhost:3000';
const host = io(url); const m1 = io(url);
const events = [];
for (const ev of ['room:state','game:role','phase:hide','phase:hideWait','phase:seek']) {
  host.on(ev, (p) => events.push(['host', ev, p?.phase ?? p?.role ?? '']));
  m1.on(ev, (p) => events.push(['m1', ev, p?.phase ?? p?.role ?? '']));
}
const create = await new Promise(r => host.emit('room:create', { nickname: 'h', roomName: '진단', isPrivate: false }, r));
await new Promise(r => m1.emit('room:join', { code: create.code, nickname: 'g' }, r));
const bg = await new Promise(r => host.emit('room:setBackground', { background: { imageUrl: '/api/screenshots/a.png', width: 1440, height: 900 } }, r));
console.log('bg-ack:', JSON.stringify(bg));
const start = await new Promise(r => host.emit('game:start', r));
console.log('start-ack:', JSON.stringify(start));
await new Promise(r => setTimeout(r, 400));
console.log('events:', JSON.stringify(events.filter(e => e[1] !== 'room:state')));
console.log('last-room-state-phase:', JSON.stringify(events.filter(e => e[1]==='room:state').at(-1)));
host.close(); m1.close();
