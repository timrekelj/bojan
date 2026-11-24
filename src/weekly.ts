import {
  AttachmentBuilder,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import { renderDailyChart } from './chart.js';
import type { ChannelRow, ReactionCountRow, UserRow } from './db.js';
import { daySeries, fmt, leaderboardLines, weekRangeLabel, type WeekBounds } from './stats.js';
import { NO_MENTIONS } from './discord.js';

export const WEEKLY_CHART_NAME = 'weekly-chart.png';
export const BLURPLE = 0x5865f2;

export interface WeeklyStatsData {
  week: WeekBounds;
  timeZone: string;
  weekTotal: number;
  weekReactions: number;
  activeMembers: number;
  total: number;
  topMessagers: UserRow[];
  /** Total XP per member, for level tags on the top-messager lines. */
  xpByUser?: Record<string, number>;
  topChannels: ChannelRow[];
  topGiven: ReactionCountRow[];
  topReceived: ReactionCountRow[];
  perDay: { day: string; count: number }[];
  guildIconUrl?: string | null;
}

function ranked(rows: ReactionCountRow[]): string {
  return rows.length > 0 ? rows.map((r, i) => `${i + 1}. <@${r.userId}> — **${fmt(r.count)}**`).join('\n') : '—';
}

export function divider(): SeparatorBuilder {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

/** Pure builder: turns already-queried weekly data into a Components V2 message payload. */
export function buildWeeklyStatsMessage(data: WeeklyStatsData) {
  const counts = new Map(data.perDay.map((d) => [d.day, d.count]));
  const chart = renderDailyChart(daySeries(data.week, data.timeZone).map((d) => ({ label: d.label, count: counts.get(d.key) ?? 0 })));

  const header = new TextDisplayBuilder().setContent(
    [
      '## 📊 Weekly stats',
      `-# ${weekRangeLabel(data.week, data.timeZone)}`,
      '',
      `**${fmt(data.weekTotal)}** messages · **${fmt(data.weekReactions)}** reactions · **${fmt(data.activeMembers)}** active members`,
      `-# ${fmt(data.total)} messages all time`,
    ].join('\n'),
  );

  const container = new ContainerBuilder().setAccentColor(BLURPLE);
  if (data.guildIconUrl) {
    container.addSectionComponents(
      new SectionBuilder().addTextDisplayComponents(header).setThumbnailAccessory(new ThumbnailBuilder().setURL(data.guildIconUrl)),
    );
  } else {
    container.addTextDisplayComponents(header);
  }

  const channels =
    data.topChannels.length > 0
      ? data.topChannels.map((c, i) => `${i + 1}. <#${c.channelId}> — **${fmt(c.count)}**`).join('\n')
      : '—';

  container
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(['### 🏆 Top messagers', ...leaderboardLines(data.topMessagers, data.weekTotal, data.xpByUser).slice(0, 5)].join('\n')),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### 💬 Most used channels\n${channels}`))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        ['### 😄 Reactions', '**Given**', ranked(data.topGiven), '', '**Received**', ranked(data.topReceived)].join('\n'),
      ),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('### 📈 Messages per day'))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${WEEKLY_CHART_NAME}`)));

  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    files: [new AttachmentBuilder(chart, { name: WEEKLY_CHART_NAME })],
    allowedMentions: NO_MENTIONS,
  };
}
