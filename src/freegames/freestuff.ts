import { createPublicKey, verify } from 'node:crypto';
import { isBetaTitle } from './sources.js';
import type { FreeGame, Kind, Platform, Store } from './types.js';

// FreeStuff (freestuffbot.xyz) API v2, webhook only. Standard Webhooks style
// Ed25519 signatures; see https://docs.freestuffbot.xyz/api-v2/webhooks

export const FREESTUFF_COMPAT_DATE = '2026-11-15';
const FREESTUFF_EPOCH_MS = 1735689600000; // 2025-01-01T00:00:00Z
const TIMESTAMP_TOLERANCE_MS = 5 * 60_000;
const REPLAY_TTL_MS = 60 * 60_000;

const FLAG_TRASH = 1 << 0;
const FLAG_FIRSTPARTY_EXCLUSIVE = 1 << 4;
const IMG_FLAG_AR_WIDE = 1 << 1;

// ---- signature ------------------------------------------------------------

/** True when `timestamp` (header, seconds) is within ±5 min of now as unix seconds OR as seconds since 2025-01-01. */
export function freeStuffTimestampValid(timestamp: string | undefined | null, now = Date.now()): boolean {
  if (!timestamp || !/^\d+$/.test(timestamp.trim())) return false;
  const n = Number(timestamp.trim());
  if (!Number.isFinite(n)) return false;
  const unixMs = n * 1000;
  const customMs = n * 1000 + FREESTUFF_EPOCH_MS;
  return Math.abs(now - unixMs) <= TIMESTAMP_TOLERANCE_MS || Math.abs(now - customMs) <= TIMESTAMP_TOLERANCE_MS;
}

/** Verify `Webhook-Signature` (space-separated `v1a,<base64>` entries) over `${id}.${timestamp}.${rawBody}`. */
export function verifyFreeStuffSignature(opts: {
  publicKey: string;
  id: string | undefined | null;
  timestamp: string | undefined | null;
  signature: string | undefined | null;
  rawBody: string;
  now?: number;
}): boolean {
  const { publicKey, id, timestamp, signature, rawBody } = opts;
  if (!id || !timestamp || !signature) return false;
  if (!freeStuffTimestampValid(timestamp, opts.now)) return false;
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return false;
  }
  const data = Buffer.from(`${id}.${timestamp}.${rawBody}`);
  for (const entry of signature.split(/\s+/)) {
    const comma = entry.indexOf(',');
    if (comma < 0 || entry.slice(0, comma) !== 'v1a') continue;
    try {
      const sig = Buffer.from(entry.slice(comma + 1), 'base64');
      if (sig.length > 0 && verify(null, data, key, sig)) return true;
    } catch {
      // garbled entry, try the next one
    }
  }
  return false;
}

/** In-memory `Webhook-Id` replay guard with ~1h expiry. `seen()` records the id and returns true if it was already seen. */
export function createReplayGuard(ttlMs = REPLAY_TTL_MS): { seen: (id: string, now?: number) => boolean } {
  const ids = new Map<string, number>();
  return {
    seen(id, now = Date.now()) {
      for (const [k, exp] of ids) if (exp <= now) ids.delete(k);
      if (ids.has(id)) return true;
      ids.set(id, now + ttlMs);
      return false;
    },
  };
}

// ---- webhook request handling (pure) -------------------------------------

export interface FreeStuffRequest {
  getHeader: (name: string) => string | undefined;
  rawBody: string;
}

export interface FreeStuffResult {
  status: 204 | 401 | 404 | 409;
  /** Games to announce after responding (only for validly signed announcement events). */
  games: FreeGame[];
}

export function handleFreeStuffWebhook(
  req: FreeStuffRequest,
  opts: { publicKey: string | null; replay: { seen: (id: string, now?: number) => boolean }; now?: number },
): FreeStuffResult {
  if (!opts.publicKey) return { status: 404, games: [] };
  const id = req.getHeader('webhook-id');
  const ok = verifyFreeStuffSignature({
    publicKey: opts.publicKey,
    id,
    timestamp: req.getHeader('webhook-timestamp'),
    signature: req.getHeader('webhook-signature'),
    rawBody: req.rawBody,
    now: opts.now,
  });
  if (!ok || !id) return { status: 401, games: [] };
  if (req.getHeader('x-compatibility-date') !== FREESTUFF_COMPAT_DATE) return { status: 409, games: [] };
  if (opts.replay.seen(id, opts.now)) return { status: 204, games: [] };

  let body: unknown;
  try {
    body = JSON.parse(req.rawBody);
  } catch {
    return { status: 204, games: [] };
  }
  const type = isObj(body) ? body.type : undefined;
  if (type !== 'fsb:event:announcement_created') return { status: 204, games: [] };
  const data = isObj(body) && isObj(body.data) ? body.data : {};
  const products = Array.isArray(data.resolvedProducts) ? data.resolvedProducts : [];
  const games: FreeGame[] = [];
  for (const p of products) {
    try {
      const g = normalizeFreeStuffProduct(p);
      if (g) games.push(g);
    } catch (err) {
      console.error('[freegames] freestuff product normalize failed:', err);
    }
  }
  return { status: 204, games };
}

// ---- normalizer -----------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function objs(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isObj) : [];
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Highest `priority` first; stable for ties. */
function byPriority<T extends Record<string, unknown>>(items: T[]): T[] {
  return [...items].sort((a, b) => num(b.priority) - num(a.priority));
}

function mapStore(store: string): Store {
  switch (store) {
    case 'steam': return 'steam';
    case 'epic': return 'epic';
    case 'gog': return 'gog';
    case 'itch': return 'itch';
    case 'ubi': return 'ubisoft';
    case 'origin': return 'ea';
    default: return 'other';
  }
}

function worthOf(prices: Record<string, unknown>[]): string | null {
  const old = (cur: string): number => {
    const p = prices.find((x) => str(x.currency).toUpperCase() === cur);
    return p ? num(p.oldValue) : 0;
  };
  const usd = old('USD');
  if (usd > 0) return `$${(usd / 100).toFixed(2)}`;
  const eur = old('EUR');
  if (eur > 0) return `€${(eur / 100).toFixed(2)}`;
  return null;
}

/** Normalize a FreeStuff v2 product (compat 2026-11-15). Null = not announceable. */
export function normalizeFreeStuffProduct(p: unknown): FreeGame | null {
  if (!isObj(p)) return null;
  const id = typeof p.id === 'number' || (typeof p.id === 'string' && p.id) ? String(p.id) : '';
  const title = str(p.title).trim();
  if (!id || !title) return null;

  if ((num(p.flags) & (FLAG_TRASH | FLAG_FIRSTPARTY_EXCLUSIVE)) !== 0) return null;
  const type = str(p.type);
  if (type !== 'keep' && type !== 'other' && type !== 'mobile') return null;

  const rawKind = str(p.kind);
  let kind: Kind;
  if (rawKind === 'game' || rawKind === 'bundle') kind = isBetaTitle(title) ? 'beta' : 'game';
  else if (rawKind === 'dlc' || rawKind === 'loot' || rawKind === 'storeitem') kind = 'dlc';
  else return null;

  const urls = byPriority(objs(p.urls)).filter((u) => str(u.url));
  const url = urls[0] ? str(urls[0].url) : '';
  if (!url) return null;

  const rawStore = str(p.store);
  const urlPlatforms = urls.flatMap((u) => (Array.isArray(u.platforms) ? u.platforms.map((x) => str(x)) : []));
  let platform: Platform = 'pc';
  if (type === 'mobile' || rawStore === 'gplay' || urlPlatforms.some((x) => x === 'android' || x === 'ios')) platform = 'mobile';
  else if (rawStore === 'playstation' || urlPlatforms.some((x) => x === 'xbox' || x === 'ps4' || x === 'ps5')) platform = 'console';

  const images = byPriority(objs(p.images)).filter((i) => str(i.url));
  const wide = images.find((i) => (num(i.flags) & IMG_FLAG_AR_WIDE) !== 0);
  const imageUrl = wide ? str(wide.url) : null;

  const descs = byPriority(objs(p.description)).filter((d) => str(d.text));
  const desc = descs.find((d) => str(d.lang).toLowerCase().startsWith('en'));

  const until = num(p.until);
  return {
    key: `fs:${id}`,
    title,
    description: desc ? str(desc.text) : '',
    store: mapStore(rawStore),
    kind,
    platform,
    url,
    imageUrl,
    worth: worthOf(objs(p.prices)),
    endsAt: until > 0 ? until : null,
    startsAt: null,
    source: 'freestuff',
  };
}
