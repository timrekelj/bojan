import type { FreeGame, FreeSettings, Kind, Platform, Store } from './types.js';

const EPIC_URL = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=SI&allowCountries=SI';
const GAMERPOWER_URL = 'https://www.gamerpower.com/api/giveaways';
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 10 * 60_000;

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

// ---- Epic -----------------------------------------------------------------

function epicSlug(el: Json): string | null {
  const ok = (s: string | null): s is string => !!s && !/[\[\]{}]/.test(s) && s !== 'null';
  const fromMapping = (list: unknown): string | null => {
    for (const m of arr(list)) {
      const slug = str(obj(m)?.pageSlug);
      if (ok(slug)) return slug;
    }
    return null;
  };
  const candidates = [
    fromMapping(el.offerMappings),
    fromMapping(obj(el.catalogNs)?.mappings),
    str(el.productSlug),
    str(el.urlSlug),
  ];
  return candidates.find(ok) ?? null;
}

function epicImage(el: Json): string | null {
  const images = arr(el.keyImages).map(obj).filter((i): i is Json => i !== null);
  for (const type of ['OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail']) {
    const hit = images.find((i) => i.type === type && str(i.url));
    if (hit) return str(hit.url);
  }
  return null;
}

/** Offers (start/end) with a 100% discount from a promotions block list. */
function epicFreeWindows(blocks: unknown): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const block of arr(blocks)) {
    for (const offer of arr(obj(block)?.promotionalOffers)) {
      const o = obj(offer);
      if (!o || obj(o.discountSetting)?.discountPercentage !== 0) continue;
      const start = Date.parse(String(o.startDate));
      const end = Date.parse(String(o.endDate));
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      out.push({ start, end });
    }
  }
  return out;
}

function epicWorth(el: Json): string | null {
  const fmtPrice = obj(obj(obj(el.price)?.totalPrice)?.fmtPrice);
  const original = str(fmtPrice?.originalPrice);
  if (!original || !/[1-9]/.test(original)) return null;
  return original;
}

export interface EpicResult {
  current: FreeGame[];
  upcoming: FreeGame[];
}

export function normalizeEpic(json: unknown, now = Date.now()): EpicResult {
  const elements = arr(obj(obj(obj(obj(json)?.data)?.Catalog)?.searchStore)?.elements);
  const current: FreeGame[] = [];
  const upcoming: FreeGame[] = [];
  for (const raw of elements) {
    const el = obj(raw);
    if (!el) continue;
    const id = str(el.id);
    const title = str(el.title);
    if (!id || !title) continue;
    const promotions = obj(el.promotions);
    if (!promotions) continue;

    const slug = epicSlug(el);
    const game = (w: { start: number; end: number }): FreeGame => ({
      key: `epic:${id}`,
      title,
      description: str(el.description) ?? '',
      store: 'epic',
      kind: 'game',
      platform: 'pc',
      url: slug ? `https://store.epicgames.com/p/${slug}` : 'https://store.epicgames.com/free-games',
      imageUrl: epicImage(el),
      worth: epicWorth(el),
      endsAt: w.end,
      startsAt: w.start,
      source: 'epic',
    });

    const now0 = epicFreeWindows(promotions.promotionalOffers).find((w) => w.start <= now && now <= w.end);
    if (now0) {
      current.push(game(now0));
      continue;
    }
    const next = epicFreeWindows(promotions.upcomingPromotionalOffers)
      .filter((w) => w.start > now)
      .sort((a, b) => a.start - b.start)[0];
    if (next) upcoming.push(game(next));
  }
  upcoming.sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));
  return { current, upcoming };
}

// ---- GamerPower -----------------------------------------------------------

export function cleanGiveawayTitle(title: string): string {
  const noGiveaway = title.replace(/\s*(?:\([^)]*\)\s*)?giveaway\s*$/i, '').trim() || title.trim();
  // Trailing " Key", " Steam Key", " (Steam) Key".
  return noGiveaway.replace(/\s+(?:\((?:steam|gog|epic games|epic|ubisoft|ea)\)\s+|steam\s+)?key\s*$/i, '').trim() || noGiveaway;
}

const BETA_TITLE_RE = /\b(?:play\s?test|open beta|closed beta|beta|alpha|demo|test key)\b/i;

/** Beta / playtest / demo keys are labelled "Game" by GamerPower; spot them by title. */
export function isBetaTitle(title: string): boolean {
  return BETA_TITLE_RE.test(title);
}

export function classifyPlatform(platforms: string): Platform {
  const tokens = platforms.toLowerCase().split(',').map((t) => t.trim());
  if (tokens.includes('pc')) return 'pc';
  if (tokens.some((t) => /android|ios|mobile/.test(t))) return 'mobile';
  if (tokens.some((t) => /xbox|ps\d|playstation|nintendo|switch|console/.test(t))) return 'console';
  return 'pc';
}

export function classifyStore(platforms: string): Store {
  const p = platforms.toLowerCase();
  if (/steam/.test(p)) return 'steam';
  if (/epic/.test(p)) return 'epic';
  if (/\bgog\b/.test(p)) return 'gog';
  if (/itch/.test(p)) return 'itch';
  if (/ubisoft|uplay/.test(p)) return 'ubisoft';
  if (/\bea\b|origin/.test(p)) return 'ea';
  return 'other';
}

function parseGpDate(v: unknown): number | null {
  const s = str(v);
  if (!s || s === 'N/A') return null;
  const ms = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export function normalizeGamerPower(json: unknown, now = Date.now()): FreeGame[] {
  const out: FreeGame[] = [];
  for (const raw of arr(json)) {
    const g = obj(raw);
    if (!g) continue;
    const id = g.id;
    const title = str(g.title);
    const url = str(g.open_giveaway_url);
    if ((typeof id !== 'number' && typeof id !== 'string') || !title || !url) continue;
    const status = str(g.status);
    if (status && status.toLowerCase() !== 'active') continue;
    const endsAt = parseGpDate(g.end_date);
    if (endsAt !== null && endsAt < now) continue;
    const platforms = str(g.platforms) ?? '';
    const type = (str(g.type) ?? 'Game').toLowerCase();
    // GamerPower files playtest/beta keys under "Game" or "Early Access"; "Other" and "DLC" count as dlc.
    let kind: Kind = type === 'game' || type === 'early access' ? 'game' : 'dlc';
    if (kind === 'game' && isBetaTitle(title)) kind = 'beta';
    const worth = str(g.worth);
    out.push({
      key: `gp:${id}`,
      title: cleanGiveawayTitle(title),
      description: str(g.description) ?? '',
      store: classifyStore(platforms),
      kind,
      platform: classifyPlatform(platforms),
      url,
      imageUrl: str(g.image),
      worth: worth && worth !== 'N/A' ? worth : null,
      endsAt,
      startsAt: parseGpDate(g.published_date),
      source: 'gamerpower',
    });
  }
  return out;
}

// ---- merge + filter ---------------------------------------------------------

/**
 * Combine both sources. When the Epic endpoint succeeded it is authoritative
 * for Epic PC games, so GamerPower copies of those are dropped. Remaining
 * duplicates are collapsed by lowercased title + store (first one wins).
 */
export function mergeFreeGames(epic: FreeGame[] | null, gp: FreeGame[] | null): FreeGame[] {
  const epicOk = epic !== null;
  const seen = new Set<string>();
  const out: FreeGame[] = [];
  const candidates = [...(epic ?? []), ...(gp ?? []).filter((g) => !(epicOk && g.store === 'epic' && g.kind === 'game' && g.platform === 'pc'))];
  for (const g of candidates) {
    const k = `${g.title.toLowerCase()}|${g.store}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
}

/** Store toggles apply to PC games; mobile/console items are gated by their own switch. */
export function matchesFilters(g: FreeGame, s: Pick<FreeSettings, 'stores' | 'includeDlc' | 'includeBeta' | 'includeMobile' | 'includeConsole'>): boolean {
  if (g.kind === 'dlc' && !s.includeDlc) return false;
  if (g.kind === 'beta' && !s.includeBeta) return false;
  if (g.platform === 'mobile') return s.includeMobile;
  if (g.platform === 'console') return s.includeConsole;
  return s.stores.includes(g.store);
}

export function filterGames(games: FreeGame[], s: FreeSettings): FreeGame[] {
  return games.filter((g) => matchesFilters(g, s));
}

// ---- fetching + cache -------------------------------------------------------

export interface FreeData {
  current: FreeGame[];
  upcoming: FreeGame[];
  epicOk: boolean;
  gamerpowerOk: boolean;
  fetchedAt: number;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'bojan-discord-bot' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 201) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let cache: FreeData | null = null;
let inflight: Promise<FreeData> | null = null;

export async function fetchFreeGames(): Promise<FreeData> {
  const [epicRes, gpRes] = await Promise.allSettled([getJson(EPIC_URL), getJson(GAMERPOWER_URL)]);
  const now = Date.now();
  let epic: EpicResult | null = null;
  let gp: FreeGame[] | null = null;
  if (epicRes.status === 'fulfilled') {
    try {
      epic = normalizeEpic(epicRes.value, now);
    } catch (err) {
      console.error('[freegames] epic parse failed:', err);
    }
  } else {
    console.error('[freegames] epic fetch failed:', epicRes.reason);
  }
  if (gpRes.status === 'fulfilled') {
    try {
      gp = normalizeGamerPower(gpRes.value, now); // non-array (empty 201 object) → []
    } catch (err) {
      console.error('[freegames] gamerpower parse failed:', err);
    }
  } else {
    console.error('[freegames] gamerpower fetch failed:', gpRes.reason);
  }
  return {
    current: mergeFreeGames(epic?.current ?? null, gp),
    upcoming: epic?.upcoming ?? [],
    epicOk: epic !== null,
    gamerpowerOk: gp !== null,
    fetchedAt: now,
  };
}

/** Cached fetch: reuses the last result if younger than 10 minutes (only when both sources succeeded). */
export async function getFreeGames(opts: { force?: boolean } = {}): Promise<FreeData> {
  if (!opts.force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
  if (!inflight) {
    inflight = fetchFreeGames()
      .then((data) => {
        if (data.epicOk && data.gamerpowerOk) cache = data;
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
