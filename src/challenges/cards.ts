import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from 'discord.js';
import type { Challenge, ChallengeGoal, ChallengeParticipant } from '../db.js';
import { fmt, fmtDate } from '../stats.js';
import { NO_MENTIONS } from '../discord.js';
import { BLURPLE } from '../weekly.js';
import {
  challengeButtonId,
  challengeLogId,
  challengeStatus,
  formatChallengeTarget,
  formatChallengeValue,
  goalTargetValue,
  MAX_CHALLENGE_DESCRIPTION,
  rankProgress,
} from './form.js';
import { isManualMetric, metricLabel } from './types.js';

// Components V2 allows 4000 chars of text across all TextDisplays; keep headroom.
const TEXT_BUDGET = 3800;
const MAX_GOAL_ROWS = 5;

export interface ChallengeCardData {
  challenge: Challenge;
  participants: ChallengeParticipant[];
  goals: ChallengeGoal[];
  /** Progress per user and goal in storage units (ms for time metrics); manual goals use logged entries. */
  totalsByGoal: Record<number, Record<string, number>>;
  timeZone: string;
  now?: number;
}

const MEDALS = ['🥇', '🥈', '🥉'];

function medal(rank: number): string {
  return MEDALS[rank - 1] ?? `${rank}.`;
}

function goalLabel(goal: Pick<ChallengeGoal, 'metric' | 'activityName'>): string {
  return metricLabel(goal.metric) + (goal.metric === 'activity' && goal.activityName ? ` · ${goal.activityName}` : '');
}

/** Pure builder: the joinable challenge card posted in the configured channel. */
export function buildChallengeCard(data: ChallengeCardData) {
  const { challenge, participants, goals, totalsByGoal } = data;
  const now = data.now ?? Date.now();
  const status = challengeStatus(challenge, now);
  const ranked = goals.map((goal) => ({ goal, rows: rankProgress(participants, totalsByGoal[goal.id] ?? {}) }));
  const limits = goals.map(() => MAX_GOAL_ROWS);
  const when =
    status === 'ended'
      ? `Ended ${fmtDate(challenge.endedAt ?? challenge.endsAt, data.timeZone)} · ${fmt(participants.length)} joined`
      : status === 'upcoming'
        ? `Starts ${fmtDate(challenge.startsAt, data.timeZone)} · ${fmt(participants.length)} joined`
        : `Until ${fmtDate(challenge.endsAt, data.timeZone)} · ${fmt(participants.length)} joined`;

  const render = (description: string): string => {
    const sections = ranked.map(({ goal, rows }, i) => {
      const top = rows.slice(0, limits[i] ?? 0);
      return [
        `### ${goalLabel(goal)} · target **${formatChallengeTarget(goal.metric, goal.target)}**`,
        top.length > 0
          ? top.map((r) => `${medal(r.rank)} <@${r.userId}> — **${formatChallengeValue(goal.metric, r.value)} / ${formatChallengeTarget(goal.metric, goal.target)}**`).join('\n')
          : participants.length === 0
            ? 'No one has joined yet — be the first!'
            : 'No progress yet.',
      ].join('\n');
    });
    return [`## 🏆 ${challenge.name}`, ...(description ? [description] : []), '', `-# ${when}`, '', ...sections.flatMap((s) => [s, ''])].join('\n').trimEnd();
  };

  let description = challenge.description.slice(0, MAX_CHALLENGE_DESCRIPTION);
  let text = render(description);
  while (text.length > TEXT_BUDGET && limits.some((n) => n > 0)) {
    let i = limits.length - 1;
    while (i >= 0 && (limits[i] ?? 0) <= 0) i--;
    if (i < 0) break;
    limits[i] = (limits[i] ?? 1) - 1;
    text = render(description);
  }
  if (text.length > TEXT_BUDGET && description) {
    description = '';
    text = render(description);
  }
  if (text.length > TEXT_BUDGET) text = text.slice(0, TEXT_BUDGET - 1) + '…';

  const container = new ContainerBuilder().setAccentColor(BLURPLE).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (status !== 'ended') {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(challengeButtonId('join', challenge.id)).setStyle(ButtonStyle.Primary).setLabel('Join'),
        new ButtonBuilder().setCustomId(challengeButtonId('leave', challenge.id)).setStyle(ButtonStyle.Secondary).setLabel('Leave'),
        new ButtonBuilder().setCustomId(challengeButtonId('my', challenge.id)).setStyle(ButtonStyle.Secondary).setLabel('My progress'),
      ),
    );
    const manual = goals.filter((g) => isManualMetric(g.metric));
    for (let i = 0; i < manual.length; i += 5) {
      const buttons = manual.slice(i, i + 5).map((g, j) =>
        new ButtonBuilder()
          .setCustomId(challengeLogId(challenge.id, g.id))
          .setStyle(ButtonStyle.Success)
          .setLabel(manual.length === 1 ? 'Log set' : `Log set ${i + j + 1}`),
      );
      container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
    }
  }

  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    allowedMentions: NO_MENTIONS,
  };
}

/** Progress summary line of one goal (used by the ephemeral progress replies). */
export function goalProgressText(goal: Pick<ChallengeGoal, 'metric' | 'target'>, value: number, remaining: number): string {
  return `**${metricLabel(goal.metric)}**: ${formatChallengeValue(goal.metric, value)} / ${formatChallengeTarget(goal.metric, goal.target)} · ${formatChallengeValue(goal.metric, remaining)} remaining`;
}

/** Compact per-goal progress for the My progress button. */
export function goalProgressLines(challenge: Challenge, goals: ChallengeGoal[], totalsByGoal: Record<number, Record<string, number>>, userId: string): string {
  if (goals.length === 0) return `**${challenge.name}** has no goals yet.`;
  return goals
    .map((goal) => {
      const value = totalsByGoal[goal.id]?.[userId] ?? 0;
      const remaining = Math.max(0, goalTargetValue(goal) - value);
      return goalProgressText(goal, value, remaining);
    })
    .join('\n');
}
