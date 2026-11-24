// OpenCode Go list prices (USD per 1M tokens) and a cost estimate from token usage.
// OpenCode itself reports cost 0 for Go models, so we price usage ourselves.

export const GO_PROVIDER = 'opencode-go';
export const GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models';
const REFRESH_MS = 6 * 3600 * 1000;

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** null when the model has no separate cache-write price (billed as input). */
  cacheWrite: number | null;
}

/** Token counts and cost of one session (the one usage shape shared by db, cards and the agent wrapper). */
export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export type TokenCounts = Omit<TokenUsage, 'costUsd'>;

/** Field-wise sum of two usages (planner session + build session). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd + b.costUsd,
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Parse the Go `/v1/models` response. Entries without an id or input/output price are skipped. */
export function parseGoPrices(json: unknown): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  const data = obj(json)?.data;
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    const e = obj(entry);
    if (!e || typeof e.id !== 'string' || e.id === '') continue;
    const text = obj(obj(e.cost)?.text);
    const inp = obj(text?.input);
    const input = num(inp?.price);
    const output = num(obj(text?.output)?.price);
    if (input === null || output === null) continue;
    const cache = obj(inp?.cache);
    out.set(e.id, { input, output, cacheRead: num(cache?.read) ?? input, cacheWrite: num(cache?.write) });
  }
  return out;
}

/** List-price estimate in USD. Reasoning tokens are billed as output; cache writes fall back to the input price. */
export function estimateCostUsd(t: TokenCounts, p: ModelPrice): number {
  return (t.input * p.input + (t.output + t.reasoning) * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * (p.cacheWrite ?? p.input)) / 1e6;
}

/** Price for "opencode-go/<id>" from a parsed table; null for other providers or unknown models. */
export function goPriceFor(modelRef: string | null | undefined, prices: ReadonlyMap<string, ModelPrice>): ModelPrice | null {
  if (!modelRef) return null;
  const slash = modelRef.indexOf('/');
  if (slash < 0 || modelRef.slice(0, slash) !== GO_PROVIDER) return null;
  return prices.get(modelRef.slice(slash + 1)) ?? null;
}

let cache: { at: number; prices: Map<string, ModelPrice> } | null = null;

/** Fetch (at most every 6h) the Go price table. A failed refresh keeps the last value (empty on first failure). */
export async function getGoPrices(now = Date.now()): Promise<Map<string, ModelPrice>> {
  if (cache && now - cache.at < REFRESH_MS) return cache.prices;
  try {
    const res = await fetch(GO_MODELS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const prices = parseGoPrices(await res.json());
    if (prices.size === 0) throw new Error('no prices in response');
    cache = { at: now, prices };
    console.log(`[builder] loaded ${prices.size} OpenCode Go prices`);
  } catch (err) {
    console.warn('[builder] could not refresh OpenCode Go prices:', err instanceof Error ? err.message : err);
    // Back off for a minute-ish instead of hammering on every call.
    cache = { at: now - REFRESH_MS + 60_000, prices: cache?.prices ?? new Map() };
  }
  return cache.prices;
}

/** Session usage from the agent; OpenCode reports no cost for Go models, so a list-price estimate fills it in. */
export async function sessionUsageWithEstimate(agent: { usage(sessionId: string): Promise<TokenUsage> }, sessionId: string, modelRef: string | null | undefined): Promise<TokenUsage> {
  const usage = await agent.usage(sessionId);
  if (usage.costUsd === 0) {
    const price = goPriceFor(modelRef, await getGoPrices());
    if (price) usage.costUsd = estimateCostUsd(usage, price);
  }
  return usage;
}
