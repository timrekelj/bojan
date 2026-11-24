// Pure helpers for the self-building feature: agent reply parsing, naming and formatting.

export interface ParsedReply {
  /** Text before the final json block, trimmed. */
  visible: string;
  /** The parsed json object, or null when absent / invalid. */
  result: Record<string, unknown> | null;
}

/**
 * Split an agent reply into the human text and the trailing ```json block.
 * Tolerant of trailing whitespace, a missing block and invalid JSON (result = null).
 */
export function parseAgentReply(text: string): ParsedReply {
  const src = text ?? '';
  const re = /```json[^\S\r\n]*\r?\n([\s\S]*?)```/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(src); m; m = re.exec(src)) last = m;
  if (!last) return { visible: src.trim(), result: null };
  const visible = src.slice(0, last.index).trim();
  try {
    const parsed: unknown = JSON.parse(last[1]!.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { visible, result: parsed as Record<string, unknown> };
  } catch {
    // invalid JSON: fall through
  }
  return { visible, result: null };
}

export type PlanStatus = 'needs_input' | 'approved' | 'cancelled';

export interface PlanResult {
  status: PlanStatus;
  title: string;
  plan: string;
  questions: string[];
}

const PLAN_STATUSES: readonly string[] = ['needs_input', 'approved', 'cancelled'];

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Validate and normalize a feature-plan result; null when it has no valid status. */
export function normalizePlanResult(raw: Record<string, unknown> | null): PlanResult | null {
  if (!raw) return null;
  const status = str(raw.status);
  if (!PLAN_STATUSES.includes(status)) return null;
  const questions = Array.isArray(raw.questions) ? raw.questions.map(str).filter((q) => q.length > 0) : [];
  return { status: status as PlanStatus, title: str(raw.title), plan: str(raw.plan), questions };
}

export type BuildResult = { status: 'pr_opened'; prUrl: string; summary: string } | { status: 'failed'; reason: string };

/** Validate and normalize a feature-build result; null when it matches neither shape. */
export function normalizeBuildResult(raw: Record<string, unknown> | null): BuildResult | null {
  if (!raw) return null;
  const status = str(raw.status);
  if (status === 'pr_opened') {
    const prUrl = str(raw.pr_url);
    if (!parsePrUrl(prUrl)) return null;
    return { status: 'pr_opened', prUrl, summary: str(raw.summary) };
  }
  if (status === 'failed') return { status: 'failed', reason: str(raw.reason) || 'No reason given.' };
  return null;
}

export function branchName(jobId: number): string {
  return `bot/${jobId}`;
}

export function worktreeDirFor(jobId: number): string {
  return `/workspace/jobs/${jobId}`;
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export function parsePrUrl(url: string): PrRef | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec((url ?? '').trim());
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

/** Discord thread names are limited to 100 characters. */
export function threadNameFor(request: string): string {
  const flat = request.replace(/\s+/g, ' ').trim();
  const base = flat.length > 0 ? flat : 'feature request';
  const name = `Feature: ${base}`;
  return name.length <= 100 ? name : `${name.slice(0, 99).trimEnd()}…`;
}

export interface ModelRef {
  providerID: string;
  id: string;
}

/** "opencode-go/glm-5.3" → { providerID: "opencode-go", id: "glm-5.3" }. The model id may itself contain slashes. */
export function parseModelRef(ref: string): ModelRef | null {
  const s = (ref ?? '').trim();
  const i = s.indexOf('/');
  if (i <= 0 || i === s.length - 1) return null;
  return { providerID: s.slice(0, i), id: s.slice(i + 1) };
}

/** Strip the bot mention(s) from a message and tidy whitespace. */
export function stripBotMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export interface UsageLike {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export function formatUsage(u: UsageLike): string {
  const cache = u.cacheRead + u.cacheWrite;
  const parts = [`${formatTokens(u.input)} in`, `${formatTokens(u.output)} out`];
  if (u.reasoning > 0) parts.push(`${formatTokens(u.reasoning)} reasoning`);
  if (cache > 0) parts.push(`${formatTokens(cache)} cached`);
  return `${parts.join(' · ')} · ${formatCost(u.costUsd)}`;
}

export type PrState = 'open' | 'merged' | 'closed' | 'rate-limited';

export interface PrJson {
  state?: unknown;
  merged?: unknown;
  merged_at?: unknown;
  mergeable?: unknown;
  mergeable_state?: unknown;
}

/** Interpret GitHub's pull request JSON. */
export function prStateFromJson(json: PrJson): PrState {
  if (json.merged === true || (typeof json.merged_at === 'string' && json.merged_at.length > 0)) return 'merged';
  return json.state === 'closed' ? 'closed' : 'open';
}

/** `conflict`: merge conflict with main; `unknown`: GitHub has not computed it yet (check again); `ok`: anything else. */
export type PrMergeability = 'conflict' | 'unknown' | 'ok';

export interface PrInfo {
  state: PrState;
  mergeability: PrMergeability;
}

/** State plus mergeability. Only open PRs can be conflicted; GitHub computes `mergeable` lazily (null = unknown). */
export function prInfoFromJson(json: PrJson): PrInfo {
  const state = prStateFromJson(json);
  if (state !== 'open') return { state, mergeability: 'ok' };
  if (json.mergeable_state === 'dirty') return { state, mergeability: 'conflict' };
  if (json.mergeable === null || json.mergeable === undefined || json.mergeable_state === 'unknown') return { state, mergeability: 'unknown' };
  return { state, mergeability: 'ok' };
}

/** Admin = Administrator permission, or holding ADMIN_ROLE_ID (same rule as the dashboard). */
export function isAdminLike(hasAdministrator: boolean, roleIds: readonly string[], adminRoleId: string | null): boolean {
  return hasAdministrator || (adminRoleId !== null && roleIds.includes(adminRoleId));
}
