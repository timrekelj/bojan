// OpenCode Go quota gate: refuse model calls while any plan limit is nearly used up.
// Pure helpers plus a tiny cached gate; no config/db imports so smoke tests can drive it.
import { fmtDate, fmtDuration } from '../stats.js';

export type LimitKind = 'rolling' | 'weekly' | 'monthly';

/** One meter as returned by OpenCode (`experimental.usage.limits().go`); `percent` is 0-100. */
export interface LimitMeter {
  percent: number;
  limited: boolean;
  resetsAt: number;
}

export type GoLimits = Record<LimitKind, LimitMeter>;

/** The lowest meter that blocks, and the time all of them have reset. */
export interface BlockingLimit {
  kind: LimitKind;
  percent: number;
  resetsAt: number;
}

export const LIMIT_KINDS: readonly LimitKind[] = ['rolling', 'weekly', 'monthly'];

export const LIMIT_LABELS: Record<LimitKind, string> = {
  rolling: '5h',
  weekly: 'weekly',
  monthly: 'monthly',
};

/** The meter that blocks requests, or null when every meter is below `threshold` and not limited. */
export function blockingLimit(limits: Partial<GoLimits> | null | undefined, threshold: number): BlockingLimit | null {
  if (!limits) return null;
  let blocked: BlockingLimit | null = null;
  for (const kind of LIMIT_KINDS) {
    const meter = limits[kind];
    if (!meter || (!meter.limited && meter.percent < threshold)) continue;
    const candidate: BlockingLimit = { kind, percent: meter.percent, resetsAt: meter.resetsAt };
    // Several meters can block at once: report the one that resets last, since nothing runs before that.
    if (!blocked || candidate.resetsAt > blocked.resetsAt || (candidate.resetsAt === blocked.resetsAt && candidate.percent > blocked.percent)) {
      blocked = candidate;
    }
  }
  return blocked;
}

/** Human text explaining why a request was refused and when it can be retried. */
export function formatLimitDenial(block: BlockingLimit, timeZone: string, now = Date.now()): string {
  const percent = `${Math.round(block.percent)}%`;
  const reset =
    block.resetsAt > 0
      ? ` Next reset: ${fmtDate(block.resetsAt, timeZone)}${block.resetsAt > now ? ` (in ${fmtDuration(block.resetsAt - now)})` : ''}.`
      : '';
  return `I can't take that right now: the OpenCode Go ${LIMIT_LABELS[block.kind]} limit is at ${percent}.${reset} Please try again after the reset.`;
}

/** The part of the agent the gate needs (lets smoke tests plug in a fake). */
export interface LimitReader {
  limitMeters(): Promise<Partial<GoLimits> | null>;
}

/**
 * Caches the limit check briefly so bursts of messages make one call. Never throws and never blocks
 * on a failure: when the limits can't be read, requests are allowed.
 */
export class LimitGate {
  private checkedAt: number | null = null;
  private blocked: BlockingLimit | null = null;
  private lastLogged = '';
  private warned = false;

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Refusal text when a model call must not start now, else null. */
  async check(agent: LimitReader, threshold: number, timeZone: string): Promise<string | null> {
    const now = this.now();
    if (this.checkedAt !== null && now - this.checkedAt < this.ttlMs) {
      return this.blocked ? formatLimitDenial(this.blocked, timeZone, now) : null;
    }
    let limits: Partial<GoLimits> | null = null;
    try {
      limits = await agent.limitMeters();
      this.warned = false;
    } catch (err) {
      if (!this.warned) {
        console.warn('[builder] could not read OpenCode Go limits, allowing requests:', err instanceof Error ? err.message : err);
        this.warned = true;
      }
    }
    this.checkedAt = this.now();
    this.blocked = blockingLimit(limits, threshold);
    // One line per blocked limit, not one per check.
    const key = this.blocked ? `${this.blocked.kind}:${this.blocked.resetsAt}` : '';
    if (this.blocked && key !== this.lastLogged) {
      console.warn(
        `[builder] OpenCode Go ${LIMIT_LABELS[this.blocked.kind]} limit at ${Math.round(this.blocked.percent)}% (threshold ${threshold}%), refusing model calls until ${new Date(this.blocked.resetsAt).toISOString()}`,
      );
    }
    this.lastLogged = key;
    return this.blocked ? formatLimitDenial(this.blocked, timeZone, this.now()) : null;
  }
}
