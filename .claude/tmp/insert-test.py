p='server/test/smoke.test.ts'
s=open(p).read()
test='''
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
'''
s=s.rstrip()
assert s.endswith('});')
s=s[:-3].rstrip()+'\n'+test+'\n});\n'
open(p,'w').write(s)
print('ok')
