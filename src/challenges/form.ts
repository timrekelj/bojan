import { fmt, fmtDuration } from '../stats.js';
import { isChallengeMetric, isTimeMetric, type ChallengeMetric } from './types.js';

export const MAX_CHALLENGE_NAME = 100;
export const MAX_CHALLENGE_DESCRIPTION = 500;
export const MIN_CHALLENGE_TARGET = 1;
export const MAX_CHALLENGE_TARGET = 1_000_000;
export const DAY_MS = 86_400_000;

export type ChallengeWizardStep = 1 | 2 | 3;

/** Values collected by the 3-step dashboard wizard. Strings are kept as typed for redisplay. */
export interface ChallengeDraft {
  name: string;
  description: string;
  metric: ChallengeMetric;
  /** Only used by the `activity` metric. */
  activityName: string;
  /** Count for messages/reactions, minutes for voice/activity. */
  target: number;
  /** YYYY-MM-DD, empty = starts now. */
  startDate: string;
  /** YYYY-MM-DD, the whole day counts (ends at the following UTC midnight). */
  endDate: string;
  channelId: string;
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
  return { name: '', description: '', metric: 'messages', activityName: '', target: 1, startDate: '', endDate: defaultEndDate(now), channelId: '', rewardRoleId: '' };
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
export function challengeStatus(c: { status: 'active' | 'ended'; startsAt: number; endsAt: number }, now = Date.now()): ChallengeStatus {
  if (c.status === 'ended' || now >= c.endsAt) return 'ended';
  if (now < c.startsAt) return 'upcoming';
  return 'active';
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

/** The wizard's target (minutes for time metrics) for display. */
export function formatChallengeTarget(metric: ChallengeMetric, target: number): string {
  return isTimeMetric(metric) ? fmtDuration(target * 60_000) : fmt(target);
}

export type ChallengeButtonAction = 'join' | 'leave';

export function challengeButtonId(action: ChallengeButtonAction, challengeId: number): string {
  return `challenge:${action}:${challengeId}`;
}

/** `challenge:join:<id>` / `challenge:leave:<id>` -> action + id, null for anything else. */
export function parseChallengeButtonId(customId: string): { action: ChallengeButtonAction; challengeId: number } | null {
  const m = /^challenge:(join|leave):(\d+)$/.exec(customId);
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { action: m[1] as ChallengeButtonAction, challengeId: id };
}

export interface ChallengeWizardContext {
  channels: ReadonlySet<string>;
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
    target: targetRaw !== '' && Number.isFinite(targetNum) ? Math.trunc(targetNum) : MIN_CHALLENGE_TARGET,
    startDate: text('startDate'),
    endDate: endDate || (step === 1 ? defaultEndDate(now) : ''),
    channelId: text('channelId'),
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

  if (step >= 2) {
    if (!targetRaw) errors.push('The target is required.');
    else if (!Number.isInteger(targetNum) || targetNum < MIN_CHALLENGE_TARGET || targetNum > MAX_CHALLENGE_TARGET) {
      errors.push(`The target must be a whole number between ${MIN_CHALLENGE_TARGET} and ${MAX_CHALLENGE_TARGET}.`);
    }
    if (draft.startDate && dayStartMs(draft.startDate) === null) errors.push('The start date is not a valid date.');
    if (!draft.endDate) errors.push('The end date is required.');
    else if (dayEndMs(draft.endDate) === null) errors.push('The end date is not a valid date.');
    else if (dayEndMs(draft.endDate)! <= now) errors.push('The end date must be in the future.');
    if (draft.startDate && dayStartMs(draft.startDate) !== null && dayEndMs(draft.endDate) !== null && dayStartMs(draft.startDate)! >= dayEndMs(draft.endDate)!) {
      errors.push('The start date must be before the end date.');
    }
    if (!draft.channelId) errors.push('Choose a channel.');
    else if (!ctx.channels.has(draft.channelId)) errors.push('The selected channel no longer exists.');
    if (draft.rewardRoleId && !ctx.roles.has(draft.rewardRoleId)) errors.push('The selected reward role no longer exists.');
  }

  return { draft, errors };
}
