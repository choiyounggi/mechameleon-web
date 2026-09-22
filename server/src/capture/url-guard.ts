import dns from 'node:dns/promises';
import net from 'node:net';

// Capture targets are fetched by a headless browser running on the host, so a
// URL that resolves to this machine or its LAN would screenshot services that
// were never meant to be public. Reject loopback, private, link-local (incl.
// cloud metadata 169.254.169.254), unspecified and IPv6 unique-local/link-local
// ranges, both as literal hosts and as DNS answers.

export type Lookup = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: Lookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 || // 0.0.0.0/8 (unspecified / "this host")
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 carrier-grade NAT
    a >= 224 // multicast + reserved + broadcast
  );
}

export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind !== 6) return true; // not an IP literal at all: never "public"

  const lower = ip.toLowerCase();
  const mapped = /^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]);

  const expanded = expandV6(lower);
  if (expanded === null) return true;
  // IPv4 embedded without the ffff marker: "IPv4-compatible" ::a.b.c.d (::/96,
  // serialised by URL as ::7f00:1) and NAT64 64:ff9b::a.b.c.d. Judge the v4.
  const embedded = /^(?:0{24}|0064ff9b0{16})([0-9a-f]{8})$/.exec(expanded);
  if (embedded && !/^0{8}$/.test(embedded[1]) && expanded !== `${'0'.repeat(31)}1`) {
    return isPrivateV4(hexToV4(embedded[1]));
  }
  return (
    /^0{32}$/.test(expanded) || // :: unspecified
    /^0{31}1$/.test(expanded) || // ::1 loopback
    /^f[cd]/.test(expanded) || // fc00::/7 unique local
    /^fe[89ab]/.test(expanded) || // fe80::/10 link-local
    /^ff/.test(expanded) // multicast
  );
}

function hexToV4(hex8: string): string {
  return [0, 2, 4, 6].map((i) => parseInt(hex8.slice(i, i + 2), 16)).join('.');
}

// Returns the 32 hex digits of an IPv6 address, or null if it cannot be parsed.
function expandV6(ip: string): string | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, '0')).join('');
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || !hostname.includes('.');
}

// True only when every address the hostname resolves to is public. A failed
// or empty lookup counts as not public: the capture could not succeed anyway.
export async function isPublicUrl(url: URL, lookup: Lookup = defaultLookup): Promise<boolean> {
  // URL keeps IPv6 literals bracketed ("[::1]"); strip them for net.isIP.
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (hostname === '') return false;
  if (net.isIP(hostname) !== 0) return !isPrivateAddress(hostname);
  if (isLocalHostname(hostname)) return false;

  let answers: { address: string }[];
  try {
    answers = await lookup(hostname);
  } catch {
    return false;
  }
  if (answers.length === 0) return false;
  return answers.every((a) => !isPrivateAddress(a.address));
}
