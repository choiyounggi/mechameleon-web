import { describe, expect, it } from 'vitest';
import { isPrivateAddress, isPublicUrl, type Lookup } from '../src/capture/url-guard';

const resolvesTo =
  (...addresses: string[]): Lookup =>
  () =>
    Promise.resolve(addresses.map((address) => ({ address })));

const neverCalled: Lookup = () => Promise.reject(new Error('lookup must not run for this input'));

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    '::7f00:1', // how URL serialises [::127.0.0.1]
    '::127.0.0.1',
    '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
    '64:ff9b::a00:1', // NAT64 of 10.0.0.1
  ])('treats %s as private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '93.184.216.34',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
    '::808:808', // [::8.8.8.8]
    '64:ff9b::808:808', // NAT64 of 8.8.8.8
  ])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it('treats a string that is not an IP literal as private (boundary: empty)', () => {
    expect(isPrivateAddress('')).toBe(true);
    expect(isPrivateAddress('example.com')).toBe(true);
  });
});

describe('isPublicUrl', () => {
  it('accepts a hostname whose every answer is public', async () => {
    await expect(isPublicUrl(new URL('https://example.com/page'), resolvesTo('93.184.216.34', '2606:2800::1'))).resolves.toBe(true);
  });

  it('rejects a hostname when any answer is private (DNS rebinding / split-horizon)', async () => {
    await expect(isPublicUrl(new URL('https://evil.example/'), resolvesTo('93.184.216.34', '127.0.0.1'))).resolves.toBe(false);
  });

  it.each([
    'http://127.0.0.1:8642/',
    'http://[::1]:3000/',
    'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::127.0.0.1]/',
    // obfuscated IPv4 spellings: URL.hostname canonicalises them first
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://user@127.0.0.1/',
  ])(
    'rejects the literal private host %s without a lookup',
    async (url) => {
      await expect(isPublicUrl(new URL(url), neverCalled)).resolves.toBe(false);
    },
  );

  it.each(['http://localhost:3000/', 'http://app.localhost/', 'http://intranet/'])(
    'rejects the local hostname %s without a lookup',
    async (url) => {
      await expect(isPublicUrl(new URL(url), neverCalled)).resolves.toBe(false);
    },
  );

  it('accepts a literal public IP without a lookup', async () => {
    await expect(isPublicUrl(new URL('http://8.8.8.8/'), neverCalled)).resolves.toBe(true);
  });

  it('rejects when the lookup throws (error path)', async () => {
    await expect(isPublicUrl(new URL('https://nx.example/'), () => Promise.reject(new Error('ENOTFOUND')))).resolves.toBe(false);
  });

  it('rejects when the lookup returns no addresses (boundary: empty answer)', async () => {
    await expect(isPublicUrl(new URL('https://empty.example/'), resolvesTo())).resolves.toBe(false);
  });
});
