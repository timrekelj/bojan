// Dokploy deployment status for the dashboard pill. Deliberately free of config/db imports so
// smoke tests can import the pure parts; the web server passes the connection settings in.

export type DeployState = 'running' | 'done' | 'error' | 'unknown';

export interface DeploySummary {
  state: DeployState;
  title: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export type DeployResult = ({ ok: true } & DeploySummary) | { ok: false; error: string };

/** What the views get: null = feature off (pill hidden). */
export type DeployStatus = DeployResult | null;

export interface DokployConfig {
  url: string | null;
  apiKey: string | null;
  composeId: string | null;
}

const UNKNOWN: DeploySummary = { state: 'unknown', title: null, startedAt: null, finishedAt: null };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function toMs(v: unknown): number | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Dokploy's enum is running | done | error | cancelled; `queued` is accepted as "in progress"
// in case a newer version adds it. `idle` and anything unknown stay `unknown`.
function toState(status: unknown): DeployState | 'cancelled' {
  switch (typeof status === 'string' ? status.trim().toLowerCase() : '') {
    case 'running':
    case 'queued':
      return 'running';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

// The endpoint answers a bare array; a few wrapper shapes (tRPC-style) are tolerated.
function findList(json: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (!isObj(json) || depth > 4) return null;
  for (const key of ['deployments', 'data', 'result', 'json', 'items']) {
    const found = findList(json[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Pure: summarizes the newest deployment of a Dokploy `deployment.allByCompose` response
 * (an array of deployment rows: `status`, `title`, `createdAt`, `startedAt`, `finishedAt` as
 * ISO strings). Newest = highest `createdAt`. Cancelled deployments never went live, so they
 * are skipped in favour of the newest one that was not cancelled. Anything unusable is `unknown`.
 */
export function summarizeDeployments(json: unknown): DeploySummary {
  const list = findList(json);
  if (!list) return { ...UNKNOWN };
  const stamp = (d: Obj): number => toMs(d.createdAt) ?? toMs(d.startedAt) ?? 0;
  // Stable sort: rows without a usable date keep the API's order (newest first).
  const items = list.filter(isObj).sort((a, b) => stamp(b) - stamp(a));
  const newest = items.find((d) => toState(d.status) !== 'cancelled');
  if (!newest) return { ...UNKNOWN };
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const state = toState(newest.status);
  return {
    state: state === 'cancelled' ? 'unknown' : state,
    title: text(newest.title) ?? text(newest.description),
    startedAt: toMs(newest.startedAt) ?? toMs(newest.createdAt),
    finishedAt: toMs(newest.finishedAt),
  };
}

export function dokployEnabled(cfg: DokployConfig): boolean {
  return !!(cfg.url && cfg.apiKey && cfg.composeId);
}

const CACHE_MS = 10_000;
const TIMEOUT_MS = 5_000;
const LOG_EVERY_MS = 60_000;
let cache: { at: number; result: DeployResult } | null = null;
let inFlight: Promise<DeployResult> | null = null;
let lastLog = 0;

function fail(error: string): DeployResult {
  const now = Date.now();
  if (now - lastLog >= LOG_EVERY_MS) {
    lastLog = now;
    console.warn(`[dokploy] deployment status unavailable: ${error}`);
  }
  return { ok: false, error };
}

async function load(cfg: DokployConfig): Promise<DeployResult> {
  try {
    const url = `${(cfg.url ?? '').replace(/\/+$/, '')}/api/deployment.allByCompose?composeId=${encodeURIComponent(cfg.composeId ?? '')}`;
    const res = await fetch(url, { headers: { 'x-api-key': cfg.apiKey ?? '', accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return fail(`HTTP ${res.status}`);
    return { ok: true, ...summarizeDeployments(await res.json()) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Latest deployment of the configured compose. Never throws; cached ~10s; concurrent calls share one request. */
export async function fetchDeployments(cfg: DokployConfig): Promise<DeployResult> {
  if (!dokployEnabled(cfg)) return { ok: false, error: 'not configured' };
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  inFlight ??= load(cfg).then((result) => {
    cache = { at: Date.now(), result };
    inFlight = null;
    return result;
  });
  return inFlight;
}

/** The cached result, however old (null before the first answer). */
export function cachedDeployments(): DeployResult | null {
  return cache?.result ?? null;
}
