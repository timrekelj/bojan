import { fmt, fmtDuration } from '../stats.js';
import { isChallengeMetric, isManualMetric, isTimeMetric, type ChallengeMetric } from './types.js';

export const MAX_CHALLENGE_NAME = 100;
export const MAX_CHALLENGE_DESCRIPTION = 500;
export const MIN_CHALLENGE_TARGET = 1;
export const MAX_CHALLENGE_TARGET = 1_000_000;
/** Longest custom goal label (the goal name, which is also its unit). */
export const MAX_CUSTOM_LABEL = 50;
export const MAX_CHALLENGE_GOALS = 5;
/** Largest single manually logged set. */
export const MAX_SET_VALUE = 5000;
/** A single manual set above this is flagged for admin review (still recorded). */
export const PUSHUP_FLAG_THRESHOLD = 99;
export const DAY_MS = 86_400_000;

export type ChallengeWizardStep = 1 | 2 | 3;

/** Values collected by the 3-step dashboard wizard. Strings are kept as typed for redisplay. */
export interface ChallengeDraft {
  name: string;
  description: string;
  metric: ChallengeMetric;
  /** Only used by the `activity` metric. */
  activityName: string;
  /** Custom goal name; only meaningful for the `custom` metric. */
  label: string;
  /** Count for messages/reactions, minutes for voice/activity; 0 = no target. */
  target: number;
  /** YYYY-MM-DD, empty = starts now. */
  startDate: string;
  /** YYYY-MM-DD, the whole day counts (ends at the following UTC midnight). */
  endDate: string;
  rewardRoleId: string;
}

export interface ChallengeWindow {
  startsAt: number;
  endsAt: number;
}

/** UTC calendar key (YYYY-MM-DD). Challenge days are UTC days, like the wizard's date inputs. */
export function dateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Default end date: seven days from now (UTC). */
export function defaultEndDate(now = Date.now()): string {
  return dateKey(now + 7 * DAY_MS);
}

export function emptyDraft(now = Date.now()): ChallengeDraft {
  return { name: '', description: '', metric: 'messages', activityName: '', label: '', target: 0, startDate: '', endDate: defaultEndDate(now), rewardRoleId: '' };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC midnight of a YYYY-MM-DD key; null when the key is not a real calendar date. */
export function dayStartMs(key: string): number | null {
  const m = DATE_RE.exec(key.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

/** The instant a challenge ends: the UTC midnight after `endDate`, so the whole day is included. */
export function dayEndMs(key: string): number | null {
  const start = dayStartMs(key);
  return start === null ? null : start + DAY_MS;
}

/**
 * Resolve the challenge interval: no start date = start now, otherwise the
 * start date's UTC midnight (or now when that is already past); the end is
 * the UTC midnight after the end date. The end must be in the future.
 */
export function challengeWindow(startDate: string, endDate: string, now = Date.now()): { ok: true; window: ChallengeWindow } | { ok: false; reason: string } {
  const dayStart = dayStartMs(endDate);
  if (dayStart === null) return { ok: false, reason: 'End date is not a valid date.' };
  const endsAt = dayStart + DAY_MS;
  const start = startDate.trim() ? dayStartMs(startDate) : now;
  if (start === null) return { ok: false, reason: 'Start date is not a valid date.' };
  if (start >= endsAt) return { ok: false, reason: 'The start date must be before the end date.' };
  if (endsAt <= now) return { ok: false, reason: 'The end date must be in the future.' };
  return { ok: true, window: { startsAt: Math.max(start, now), endsAt } };
}

export type ChallengeStatus = 'upcoming' | 'active' | 'ended';

/** `ended` also when the deadline passed but the row was not finalized yet. */
export function challengeStatus(c: { status: ChallengeStatus; startsAt: number; endsAt: number }, now = Date.now()): ChallengeStatus {
  if (c.status === 'ended' || now >= c.endsAt) return 'ended';
  if (now < c.startsAt) return 'upcoming';
  return 'active';
}

/** Short label of a challenge event kind, for the dashboard activity table. */
export const CHALLENGE_EVENT_LABELS: Record<string, string> = {
  created: 'Created',
  started: 'Started',
  joined: 'Joined',
  left: 'Left',
  ended: 'Ended',
  reward: 'Reward',
  goal_added: 'Goal added',
  entry: 'Entry',
  entry_flagged: 'Flagged',
  entry_edited: 'Entry edited',
  entry_deleted: 'Entry deleted',
};

/** One-line description of a challenge event; actor and detail may be missing. Pure. */
export function challengeEventText(kind: string, actorName: string | null, detail: string | null): string {
  const actor = actorName?.trim() || 'A member';
  const rest = detail?.trim() ? ` · ${detail.trim()}` : '';
  switch (kind) {
    case 'created':
      return actorName?.trim() ? `Created by ${actor}` : 'Created';
    case 'started':
      return 'Started';
    case 'joined':
      return `${actor} joined`;
    case 'left':
      return `${actor} left`;
    case 'ended':
      return `Ended${actorName?.trim() ? ` by ${actor}` : ''}${rest}`;
    case 'reward':
      return `Reward given to ${actor}${detail?.trim() ? ` (${detail.trim()})` : ''}`;
    case 'goal_added':
      return `Goal added by ${actor}${rest}`;
    case 'entry':
      return `${actor} logged ${detail?.trim() || 'a set'}`;
    case 'entry_flagged':
      return `${actor} logged ${detail?.trim() || 'a set'}`;
    case 'entry_edited':
      return `Entry edited by ${actor}${rest}`;
    case 'entry_deleted':
      return `Entry deleted by ${actor}${rest}`;
    default:
      return kind;
  }
}

export interface ProgressRow {
  userId: string;
  value: number;
  rank: number;
}

/** Participants ranked by progress (desc); ties keep the earlier joiner first. */
export function rankProgress(participants: readonly { userId: string; joinedAt: number }[], totals: Record<string, number>): ProgressRow[] {
  return participants
    .map((p) => ({ userId: p.userId, value: totals[p.userId] ?? 0, joinedAt: p.joinedAt }))
    .sort((a, b) => b.value - a.value || a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId))
    .map((p, i) => ({ userId: p.userId, value: p.value, rank: i + 1 }));
}

/** Progress of a stored value (ms for time metrics) for display. */
export function formatChallengeValue(metric: ChallengeMetric, value: number): string {
  return isTimeMetric(metric) ? fmtDuration(value) : fmt(value);
}

/** The wizard's target (minutes for time metrics) for display; 0 means the goal has no target. */
export function formatChallengeTarget(metric: ChallengeMetric, target: number): string {
  if (target <= 0) return 'no target';
  return isTimeMetric(metric) ? fmtDuration(target * 60_000) : fmt(target);
}

export type ChallengeButtonAction = 'join' | 'leave' | 'my';

export function challengeButtonId(action: ChallengeButtonAction, challengeId: number): string {
  return `challenge:${action}:${challengeId}`;
}

/** `challenge:join|leave|my:<id>` -> action + id, null for anything else. */
export function parseChallengeButtonId(customId: string): { action: ChallengeButtonAction; challengeId: number } | null {
  const m = /^challenge:(join|leave|my):(\d+)$/.exec(customId);
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { action: m[1] as ChallengeButtonAction, challengeId: id };
}

/** Button and modal id for logging a manual set to one goal. */
export function challengeLogId(challengeId: number, goalId: number): string {
  return `challenge:log:${challengeId}:${goalId}`;
}

/** `challenge:log:<challengeId>:<goalId>` -> ids, null for anything else. */
export function parseChallengeLogId(customId: string): { challengeId: number; goalId: number } | null {
  const m = /^challenge:log:(\d+):(\d+)$/.exec(customId);
  if (!m) return null;
  const challengeId = Number(m[1]);
  const goalId = Number(m[2]);
  if (!Number.isSafeInteger(challengeId) || challengeId <= 0 || !Number.isSafeInteger(goalId) || goalId <= 0) return null;
  return { challengeId, goalId };
}

/** A logged set: a whole number in 1..MAX_SET_VALUE, null for anything else. */
export function parseEntryValue(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_SET_VALUE ? value : null;
}

/** Single manual sets above the threshold need an admin review; every manual metric (push-ups, custom) is checked. */
export function shouldFlagEntry(metric: ChallengeMetric, value: number): boolean {
  return isManualMetric(metric) && value > PUSHUP_FLAG_THRESHOLD;
}

interface GoalLike {
  metric: ChallengeMetric;
  target: number;
}

/** Target in storage units (ms for time metrics, counts otherwise); 0 = no target. */
export function goalTargetValue(goal: GoalLike): number {
  return isTimeMetric(goal.metric) ? goal.target * 60_000 : goal.target;
}

/**
 * Capped 0..1 progress share of one goal; the mean of the shares ranks the
 * overall challenge. A targetless goal is measured against `maxValue` (the
 * leader of that goal), so it still contributes a meaningful share.
 */
export function goalShare(goal: GoalLike, value: number, maxValue = 0): number {
  const target = goalTargetValue(goal);
  if (target > 0) return Math.max(0, Math.min(1, value / target));
  return maxValue > 0 ? Math.max(0, Math.min(1, value / maxValue)) : 0;
}

/** How much is still missing for one goal, in storage units (0 when reached or the goal has no target). */
export function goalRemaining(goal: GoalLike, value: number): number {
  return Math.max(0, goalTargetValue(goal) - Math.max(0, value));
}

export interface OverallProgressRow {
  userId: string;
  /** Mean of the per-goal shares, 0..1. */
  share: number;
  rank: number;
}

/** Rank participants by the mean share of every goal; ties keep the earlier joiner first. */
export function overallRankProgress(
  participants: readonly { userId: string; joinedAt: number }[],
  goals: readonly (GoalLike & { id: number })[],
  totalsByGoal: Readonly<Record<number, Record<string, number> | undefined>>,
): OverallProgressRow[] {
  // Targetless goals are relative: the best value in the goal counts as full progress.
  const maxByGoal: Record<number, number> = {};
  for (const g of goals) {
    const totals = totalsByGoal[g.id];
    if (goalTargetValue(g) > 0 || !totals) continue;
    maxByGoal[g.id] = participants.reduce((max, p) => Math.max(max, totals[p.userId] ?? 0), 0);
  }
  return participants
    .map((p) => ({
      userId: p.userId,
      joinedAt: p.joinedAt,
      share: goals.length > 0 ? goals.reduce((sum, g) => sum + goalShare(g, totalsByGoal[g.id]?.[p.userId] ?? 0, maxByGoal[g.id] ?? 0), 0) / goals.length : 0,
    }))
    .sort((a, b) => b.share - a.share || a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId))
    .map((p, i) => ({ userId: p.userId, share: p.share, rank: i + 1 }));
}

export interface ParsedGoal {
  metric: ChallengeMetric;
  activityName: string;
  label: string;
  /** 0 = no target. */
  target: number;
}

/** Validate the dashboard add-goal form. Pure. */
export function parseGoal(raw: Record<string, string | undefined>): { ok: true; goal: ParsedGoal } | { ok: false; reason: string } {
  const metricRaw = (raw.metric ?? '').trim();
  if (!isChallengeMetric(metricRaw)) return { ok: false, reason: 'Choose a goal type.' };
  const activityName = (raw.activityName ?? '').trim().slice(0, 100);
  if (metricRaw === 'activity' && !activityName) return { ok: false, reason: 'Enter the activity name for the activity goal.' };
  if ((raw.activityName ?? '').length > 100) return { ok: false, reason: 'The activity name may be at most 100 characters.' };
  const label = (raw.label ?? '').trim();
  if (label.length > MAX_CUSTOM_LABEL) return { ok: false, reason: `The goal name may be at most ${MAX_CUSTOM_LABEL} characters.` };
  if (metricRaw === 'custom' && !label) return { ok: false, reason: 'Enter a name for the custom goal (e.g. Squats).' };
  const targetRaw = (raw.target ?? '').trim();
  const target = targetRaw === '' ? 0 : Number(targetRaw);
  if ((targetRaw !== '' && !/^\d+$/.test(targetRaw)) || !Number.isInteger(target) || target < 0 || target > MAX_CHALLENGE_TARGET) {
    return { ok: false, reason: `The target is optional; when set it must be a whole number from 0 to ${MAX_CHALLENGE_TARGET} (0 = no target).` };
  }
  return { ok: true, goal: { metric: metricRaw, activityName: metricRaw === 'activity' ? activityName : '', label: label || '', target } };
}

export interface ChallengeWizardContext {
  roles: ReadonlySet<string>;
  now?: number;
}

export interface ParsedWizard {
  draft: ChallengeDraft;
  errors: string[];
}

/**
 * Validate the wizard fields for `step` and return the best-effort draft.
 * Step 1 checks the details, step 2 the schedule and step 3 everything (so a
 * tampered hidden field is caught again before the challenge is created).
 */
export function parseWizardStep(raw: Record<string, string | undefined>, step: ChallengeWizardStep, ctx: ChallengeWizardContext): ParsedWizard {
  const now = ctx.now ?? Date.now();
  const text = (key: string): string => (raw[key] ?? '').trim().slice(0, 2000);
  const metricRaw = text('metric');
  const metric: ChallengeMetric = isChallengeMetric(metricRaw) ? metricRaw : 'messages';
  const targetRaw = text('target');
  const targetNum = Number(targetRaw);
  const endDate = text('endDate');
  const draft: ChallengeDraft = {
    name: text('name'),
    description: text('description'),
    metric,
    activityName: text('activityName'),
    label: text('label'),
    target: targetRaw !== '' && Number.isFinite(targetNum) ? Math.trunc(targetNum) : 0,
    startDate: text('startDate'),
    endDate: endDate || (step === 1 ? defaultEndDate(now) : ''),
    rewardRoleId: text('rewardRoleId'),
  };

  const errors: string[] = [];
  // Details are on step 1 and travel as hidden inputs through steps 2 and 3.
  if (!isChallengeMetric(metricRaw)) errors.push('Choose a metric.');
  if (!draft.name) errors.push('The challenge name is required.');
  else if (draft.name.length > MAX_CHALLENGE_NAME) errors.push(`The challenge name may be at most ${MAX_CHALLENGE_NAME} characters.`);
  if (draft.description.length > MAX_CHALLENGE_DESCRIPTION) errors.push(`The description may be at most ${MAX_CHALLENGE_DESCRIPTION} characters.`);
  if (draft.metric === 'activity' && !draft.activityName) errors.push('Enter the activity name for the activity metric.');
  if (draft.activityName.length > 100) errors.push('The activity name may be at most 100 characters.');
  if (draft.label.length > MAX_CUSTOM_LABEL) errors.push(`The goal name may be at most ${MAX_CUSTOM_LABEL} characters.`);
  if (draft.metric === 'custom' && !draft.label) errors.push('Enter a name for the custom goal (e.g. Squats).');

  if (step >= 2) {
    if (targetRaw !== '' && (!Number.isInteger(targetNum) || targetNum < 0 || targetNum > MAX_CHALLENGE_TARGET)) {
      errors.push(`The target is optional; when set it must be a whole number from 0 to ${MAX_CHALLENGE_TARGET} (0 = no target).`);
    }
    if (draft.startDate && dayStartMs(draft.startDate) === null) errors.push('The start date is not a valid date.');
    if (!draft.endDate) errors.push('The end date is required.');
    else if (dayEndMs(draft.endDate) === null) errors.push('The end date is not a valid date.');
    else if (dayEndMs(draft.endDate)! <= now) errors.push('The end date must be in the future.');
    if (draft.startDate && dayStartMs(draft.startDate) !== null && dayEndMs(draft.endDate) !== null && dayStartMs(draft.startDate)! >= dayEndMs(draft.endDate)!) {
      errors.push('The start date must be before the end date.');
    }
    if (draft.rewardRoleId && !ctx.roles.has(draft.rewardRoleId)) errors.push('The selected reward role no longer exists.');
  }

  return { draft, errors };
}
