// contract: t1-foundation owns the implementation
const MAX_ALIAS_DEPTH = 8;
const VAR_REF_RE = /^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/;

function resolveDoc(doc: Document | null | undefined): Document | null {
  if (doc === undefined) {
    return typeof document === 'undefined' ? null : document;
  }
  return doc;
}

function resolveValue(name: string, doc: Document): string | undefined {
  const seen = new Set<string>();
  let current = name;
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const raw = getComputedStyle(doc.documentElement).getPropertyValue(current).trim();
    if (raw.length === 0) return undefined;
    const match = raw.match(VAR_REF_RE);
    if (!match) {
      return raw.includes('var(') ? undefined : raw;
    }
    current = match[1];
  }
  return undefined;
}

export function canvasToken(name: string, fallback: string, doc?: Document | null): string {
  const d = resolveDoc(doc);
  if (!d) return fallback;
  const resolved = resolveValue(name, d);
  return resolved !== undefined ? resolved : fallback;
}

export function canvasTokenOpen(name: string, fallback: string, doc?: Document | null): string {
  const value = canvasToken(name, fallback, doc);
  return value.endsWith(')') ? value.slice(0, -1) : value;
}

export function closeAlpha(open: string, alpha: number): string {
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  const base = open.endsWith(')') ? open.slice(0, -1) : open;
  return `${base} / ${a})`;
}
