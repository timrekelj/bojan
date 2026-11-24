// Pure scheduling helpers for the build queue, restart recovery and PR conflict fixes.
import { normalizeBuildResult, normalizePlanResult, parseAgentReply, type PlanStatus } from './parse.js';

/**
 * `approved` only counts when a plan card was already posted and the turn was triggered by a user
 * message sent after it; otherwise it is downgraded to `needs_input`. Other statuses pass through.
 */
export function guardPlanStatus(input: { status: PlanStatus; planPostedAt: number | null; latestUserMessageAt: number | null }): PlanStatus {
  if (input.status !== 'approved') return input.status;
  if (input.planPostedAt !== null && input.latestUserMessageAt !== null && input.latestUserMessageAt > input.planPostedAt) return 'approved';
  return 'needs_input';
}

function normalizePlanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** True when `next` differs from the previously posted plan (whitespace-insensitive). An empty next plan counts as unchanged when a plan exists. */
export function planChanged(prev: string | null, next: string): boolean {
  const n = normalizePlanText(next);
  if (prev === null) return true;
  if (n === '') return false;
  return normalizePlanText(prev) !== n;
}

export const MAX_RESUMES = 2;
/** After a conflict fix, GitHub may keep reporting the stale state for a while. */
export const CONFLICT_SETTLE_MS = 3 * 60_000;

export interface QueuedLike {
  id: number;
  approvedAt: number | null;
  createdAt: number;
}

/** FIFO order: approval time, then id. */
export function sortQueue<T extends QueuedLike>(jobs: readonly T[]): T[] {
  return [...jobs].sort((a, b) => (a.approvedAt ?? a.createdAt) - (b.approvedAt ?? b.createdAt) || a.id - b.id);
}

/** 1-based position in the queue; 0 when the job is not queued. */
export function queuePosition(queued: readonly QueuedLike[], jobId: number): number {
  const i = sortQueue(queued).findIndex((j) => j.id === jobId);
  return i + 1;
}

/** Number of build slots still free. */
export function freeSlots(building: number, max: number): number {
  return Math.max(0, max - building);
}

/** Channel a job's reaction target lives in: the thread's starter message (id === thread id) is in the parent channel. */
export function reactionChannelFor(messageId: string, threadId: string, parentChannelId: string): string {
  return messageId === threadId ? parentChannelId : threadId;
}

/** Bot activity text for the jobs currently building; null when nothing is building. */
export function buildingActivity(titles: readonly (string | null)[]): string | null {
  if (titles.length === 0) return null;
  if (titles.length > 1) return `Building ${titles.length} features`;
  const title = (titles[0] ?? '').trim();
  const text = `Building ${title || 'a feature'}`;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** The queued jobs (FIFO) that may start now. */
export function pickJobsToStart<T extends QueuedLike>(queued: readonly T[], building: number, max: number): T[] {
  return sortQueue(queued).slice(0, freeSlots(building, max));
}

export interface ReplyLike {
  text: string;
  finish: string | null;
  error: string | null;
}

export type RecoveryDecision = { action: 'handle' } | { action: 'resume' } | { action: 'fail'; reason: string };

/**
 * After a restart, decide what to do with a session's latest reply: handle it, re-prompt the agent
 * (it was interrupted or never finished properly), or give up once the resume budget is used.
 * `lastIsAssistant` is false when the newest message in the session is not an assistant message
 * (a prompt that was never answered), so the reply we see is stale.
 */
export function decideRecovery(opts: { kind: 'plan' | 'build'; reply: ReplyLike; lastIsAssistant: boolean; resumeCount: number; maxResumes?: number }): RecoveryDecision {
  const { kind, reply, lastIsAssistant, resumeCount, maxResumes = MAX_RESUMES } = opts;
  const { visible, result } = parseAgentReply(reply.text);
  const valid = kind === 'build' ? normalizeBuildResult(result) !== null : normalizePlanResult(result) !== null;
  const interrupted = reply.error !== null || !lastIsAssistant || reply.finish === 'tool-calls';
  // A planner that finished cleanly with plain text (no json) is handled as usual: the thread continues.
  const planText = kind === 'plan' && visible.length > 0 && !interrupted;
  if (!interrupted && (valid || planText)) return { action: 'handle' };
  if (resumeCount < maxResumes) return { action: 'resume' };
  const why = reply.error ? `last error: ${reply.error}` : valid && !lastIsAssistant ? 'it never answered the last prompt' : 'it never reported a valid result';
  return { action: 'fail', reason: `The agent was interrupted by restarts and did not finish after ${maxResumes} resume attempts (${why}).` };
}

export const BUILD_RESUME_PROMPT =
  'Your previous run was interrupted by a restart. Inspect the worktree (git status, git log, whether the branch is pushed and a PR exists via `gh pr view`) ' +
  'and continue from where you left off, then finish with the required json block.';

export const PLAN_RESUME_PROMPT = 'The bot restarted before you finished your last reply. Re-read the latest message above, continue, and finish with the required json block.';

export const FOLLOW_UP_HEADER =
  'Messages sent while you were writing your last reply (your last reply was not shown to them; they can not approve the plan). Revise your plan to account for them and reply with the full plan:';

/** True when a finished planner turn's reply is stale (follow-ups arrived meanwhile) and should not be posted. Errors and cancellations still go through. */
export function shouldHoldPlanReply(input: { pendingFollowUps: number; error: boolean; planStatus: string | null }): boolean {
  return input.pendingFollowUps > 0 && !input.error && input.planStatus !== 'cancelled';
}

/** Prompt for the planner turn that runs after directed messages arrived during the previous turn. */
export function followUpPrompt(followUps: readonly string[], context: readonly string[] = [], contextHeader = ''): string {
  return [
    ...(context.length > 0 ? [`${contextHeader}\n${context.join('\n')}`] : []),
    `${FOLLOW_UP_HEADER}\n${followUps.join('\n')}`,
  ].join('\n\n');
}

export function conflictFixPrompt(prUrl: string): string {
  return (
    `Your PR ${prUrl} has merge conflicts with main. Run \`git fetch origin && git merge origin/main\`, resolve conflicts keeping both sides' intent, ` +
    'run `npm run build` and `npm run smoke`, commit the merge and `git push` (no force push). Auto-merge stays enabled. ' +
    'Finish with the required json block (pr_opened with the same PR url, or failed).'
  );
}

export type ConflictAction = 'none' | 'fix' | 'wait' | 'notify';

/**
 * What to do about an open PR. `fix`: start the one automatic fix; `wait`: want to fix but no build
 * slot is free; `notify`: the fix was already tried and the PR is still conflicted (post once).
 */
export function conflictAction(opts: { conflict: 'conflict' | 'unknown' | 'ok'; fixAttempts: number; notified: boolean; slotFree: boolean; sinceUpdateMs: number }): ConflictAction {
  if (opts.conflict !== 'conflict') return 'none';
  if (opts.fixAttempts === 0) return opts.slotFree ? 'fix' : 'wait';
  if (opts.notified || opts.sinceUpdateMs < CONFLICT_SETTLE_MS) return 'none';
  return 'notify';
}
