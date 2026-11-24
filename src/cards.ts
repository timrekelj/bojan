import {
  AttachmentBuilder,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import { renderDailyChart } from './chart.js';
import type { ActivityBreakdownRow, ActivitySessionRow, ActivitySummaryRow, DayCount, ReactionCountRow, UserRow } from './db.js';
import { fmt, fmtDate, fmtDuration, leaderboardLines, daySeries } from './stats.js';
import { levelTag } from './levels.js';
import { BLURPLE, divider } from './weekly.js';
import { NO_MENTIONS } from './discord.js';

export const ACTIVITY_CHART_NAME = 'activity-chart.png';

// Components V2 allows 4000 chars of text across all TextDisplays; keep headroom.
const TEXT_BUDGET = 3800;

interface Section {
  heading: string;
  note?: string; // small subtext under the heading (never trimmed)
  lines: string[];
}

function sectionText(s: Section): string {
  return [`### ${s.heading}`, ...(s.note ? [`-# ${s.note}`] : []), ...(s.lines.length > 0 ? s.lines : ['—'])].join('\n');
}

/** Drop trailing lines from the longest sections until all text fits the budget. */
function trimSections(header: string, sections: Section[], extra = 0): void {
  const total = (): number => header.length + extra + sections.reduce((n, s) => n + sectionText(s).length + 1, 0);
  while (total() > TEXT_BUDGET) {
    let longest: Section | undefined;
    for (const s of sections) if (s.lines.length > 1 && (!longest || s.lines.length > longest.lines.length)) longest = s;
    if (!longest) break;
    longest.lines.pop();
  }
}

function baseContainer(header: string, thumbnailUrl?: string | null): ContainerBuilder {
  const text = new TextDisplayBuilder().setContent(header);
  const container = new ContainerBuilder().setAccentColor(BLURPLE);
  if (thumbnailUrl) {
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl)));
  } else {
    container.addTextDisplayComponents(text);
  }
  return container;
}

function addSection(container: ContainerBuilder, s: Section): void {
  container.addSeparatorComponents(divider()).addTextDisplayComponents(new TextDisplayBuilder().setContent(sectionText(s)));
}


export interface LeaderboardData {
  limit?: number;
  totalMessages: number;
  totalReactions: number;
  topUsers: UserRow[];
  topGiven: ReactionCountRow[];
  topReceived: ReactionCountRow[];
  /** Total XP per member, for level tags next to each user. */
  xpByUser?: Record<string, number>;
  guildIconUrl?: string | null;
}

export function buildLeaderboardMessage(data: LeaderboardData) {
  const medal = (i: number): string => ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;
  const share = (count: number): string => (data.totalReactions > 0 ? ` (${((count / data.totalReactions) * 100).toFixed(1)}%)` : '');
  const reactionLines = (rows: ReactionCountRow[]): string[] =>
    rows.map((r, i) => {
      const tag = levelTag(data.xpByUser?.[r.userId] ?? null);
      return `${medal(i)} <@${r.userId}> — **${fmt(r.count)}**${share(r.count)}${tag ? ` · ${tag}` : ''}`;
    });

  const header = ['## 🏆 Leaderboard', '-# All time'].join('\n');
  const sections: Section[] = [
    { heading: '💬 Messages', note: `${fmt(data.totalMessages)} total`, lines: leaderboardLines(data.topUsers, data.totalMessages, data.xpByUser) },
    { heading: '😄 Reactions given', note: `${fmt(data.totalReactions)} total`, lines: reactionLines(data.topGiven) },
    { heading: '😍 Reactions received', lines: reactionLines(data.topReceived) },
  ];
  trimSections(header, sections);

  const container = baseContainer(header, data.guildIconUrl);
  for (const s of sections) addSection(container, s);

  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    allowedMentions: NO_MENTIONS,
  };
}

export interface ActivityData {
  name: string;
  username: string;
  avatarUrl?: string | null;
  timeZone: string;
  /** Total XP of the member, for a level tag in the header. */
  xp?: number | null;
  summary: ActivitySummaryRow;
  breakdown: ActivityBreakdownRow[];
  recent: ActivitySessionRow[];
  /** Minutes per local day (DayCount.day = YYYY-MM-DD) for the 7 days starting at dayStart. */
  minutes: DayCount[];
  dayStart: number;
  now: number;
}

export function buildActivityMessage(data: ActivityData) {
  const { summary, timeZone: tz } = data;
  const lvl = levelTag(data.xp ?? null);
  const header = [
    `## 📊 ${data.name}`,
    `-# ${data.username}${lvl ? ` · ${lvl}` : ''}`,
    '',
    `**Total** ${fmtDuration(summary.totalMs)} · **Sessions** ${fmt(summary.sessions)} · **Avg** ${fmtDuration(summary.avgMs)}`,
    `-# First seen ${fmtDate(summary.firstAt, tz)} · Last seen ${fmtDate(summary.lastAt, tz)}`,
  ].join('\n');

  const counts = new Map(data.minutes.map((d) => [d.day, d.count]));
  const days = daySeries({ start: data.dayStart, end: data.now, key: '' }, tz).map((d) => ({ label: d.label, count: counts.get(d.key) ?? 0 }));
  const chart = renderDailyChart(days, { title: 'Minutes per day', formatValue: (n) => n.toLocaleString('en-US') });

  const sections: Section[] = [];
  if (data.breakdown.length > 0) {
    sections.push({ heading: '🎯 Breakdown', note: 'details / status', lines: data.breakdown.map((b) => `**${b.label}** — ${fmtDuration(b.totalMs)} (${fmt(b.sessions)}×)`) });
  }
  if (data.recent.length > 0) {
    sections.push({
      heading: '🕒 Recent sessions',
      lines: data.recent.map(
        (s) => `${fmtDate(s.startedAt, tz)} — **${fmtDuration(s.durationMs)}**${s.open ? ' (ongoing)' : ''}${s.details ? ` — ${s.details}` : ''}${!s.details && s.state ? ` — ${s.state}` : ''}`,
      ),
    });
  }
  const chartHeading = '### 📈 Last 7 days';
  trimSections(header, sections, chartHeading.length + 1);

  const container = baseContainer(header, data.avatarUrl);
  container
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(chartHeading))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${ACTIVITY_CHART_NAME}`)));
  for (const s of sections) addSection(container, s);

  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    files: [new AttachmentBuilder(chart, { name: ACTIVITY_CHART_NAME })],
    allowedMentions: NO_MENTIONS,
  };
}
