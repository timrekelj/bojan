import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from 'discord.js';
import type { Challenge, ChallengeParticipant } from '../db.js';
import { fmt, fmtDate } from '../stats.js';
import { NO_MENTIONS } from '../discord.js';
import { BLURPLE } from '../weekly.js';
import { challengeButtonId, challengeStatus, formatChallengeTarget, formatChallengeValue, MAX_CHALLENGE_DESCRIPTION, rankProgress, type ProgressRow } from './form.js';
import { metricLabel } from './types.js';

// Components V2 allows 4000 chars of text across all TextDisplays; keep headroom.
const TEXT_BUDGET = 3800;
const MAX_LEADERBOARD_ROWS = 10;

export interface ChallengeCardData {
  challenge: Challenge;
  participants: ChallengeParticipant[];
  /** Progress per user in storage units (ms for time metrics). */
  totals: Record<string, number>;
  timeZone: string;
  now?: number;
}

const MEDALS = ['🥇', '🥈', '🥉'];

function medal(rank: number): string {
  return MEDALS[rank - 1] ?? `${rank}.`;
}

/** Pure builder: the joinable challenge card posted in the configured channel. */
export function buildChallengeCard(data: ChallengeCardData) {
  const { challenge, participants, totals } = data;
  const now = data.now ?? Date.now();
  const status = challengeStatus(challenge, now);
  const rows = rankProgress(participants, totals).slice(0, MAX_LEADERBOARD_ROWS);
  const target = formatChallengeTarget(challenge.metric, challenge.target);
  const metric = metricLabel(challenge.metric) + (challenge.metric === 'activity' && challenge.activityName ? ` · ${challenge.activityName}` : '');
  const when =
    status === 'ended'
      ? `Ended ${fmtDate(challenge.endedAt ?? challenge.endsAt, data.timeZone)} · ${fmt(participants.length)} joined`
      : status === 'upcoming'
        ? `Starts ${fmtDate(challenge.startsAt, data.timeZone)} · ${fmt(participants.length)} joined`
        : `Until ${fmtDate(challenge.endsAt, data.timeZone)} · ${fmt(participants.length)} joined`;

  const render = (top: ProgressRow[], description: string): string =>
    [
      `## 🏆 ${challenge.name}`,
      ...(description ? [description] : []),
      '',
      `**${metric}** · target **${target}**`,
      `-# ${when}`,
      '',
      '### Leaderboard',
      top.length > 0
        ? top.map((r) => `${medal(r.rank)} <@${r.userId}> — **${formatChallengeValue(challenge.metric, r.value)} / ${target}**`).join('\n')
        : 'No one has joined yet — be the first!',
    ].join('\n');

  let description = challenge.description.slice(0, MAX_CHALLENGE_DESCRIPTION);
  let text = render(rows, description);
  while (text.length > TEXT_BUDGET && rows.length > 1) {
    rows.pop();
    text = render(rows, description);
  }
  if (text.length > TEXT_BUDGET && description) {
    description = '';
    text = render(rows, description);
  }
  if (text.length > TEXT_BUDGET) text = text.slice(0, TEXT_BUDGET - 1) + '…';

  const container = new ContainerBuilder().setAccentColor(BLURPLE).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (status !== 'ended') {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(challengeButtonId('join', challenge.id)).setStyle(ButtonStyle.Primary).setLabel('Join'),
        new ButtonBuilder().setCustomId(challengeButtonId('leave', challenge.id)).setStyle(ButtonStyle.Secondary).setLabel('Leave'),
      ),
    );
  }

  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    allowedMentions: NO_MENTIONS,
  };
}
