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
import { renderDailyChart, renderHeatmap } from './chart.js';
import type { ChannelRow, EditDeleteRow, ReactionCountRow, ReactionPairRow, TopReactedMessageRow, UserRow } from './db.js';
import { NO_MENTIONS } from './discord.js';
import { heatmapPeaks } from './recap.js';
import { fmt, fmtHoursMinutes, leaderboardLines, monthDaySeries, monthLabel, type AwardRow, type CrowdPleaserRow, type MonthBounds } from './stats.js';
import { BLURPLE, divider, voiceRanked } from './weekly.js';

export const MONTHLY_CHART_NAME = 'monthly-chart.png';
export const MONTHLY_HEATMAP_NAME = 'monthly-heatmap.png';
export const GOLD = 0xf1c40f;
/** Same budget as the other Components V2 cards: Discord caps all TextDisplays of a message at 4000. */
export const MONTHLY_TEXT_BUDGET = 3800;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface MonthlyRecapData {
  guildId: string;
  month: MonthBounds;
  timeZone: string;
  monthTotal: number;
  monthReactions: number;
  activeMembers: number;
  voiceMs: number;
  total: number;
  topMessagers: UserRow[];
  xpByUser?: Record<string, number>;
  topChannels: ChannelRow[];
  topGiven: ReactionCountRow[];
  topReceived: ReactionCountRow[];
  topVoice: { userId: string; ms: number }[];
  perDay: { day: string; count: number }[];
  /** 7 rows (Mon..Sun) x 24 hours. */
  heatmap: number[][];
  topMessage: TopReactedMessageRow | null;
  crowdPleasers: CrowdPleaserRow[];
  silentSpectators: AwardRow[];
  biggestFans: ReactionPairRow[];
  nightOwls: { userId: string; count: number }[];
  earlyBirds: { userId: string; count: number }[];
  starters: { userId: string; count: number }[];
  streaks: { userId: string; days: number }[];
  buddies: { a: string; b: string; ms: number }[];
  novelists: { userId: string; avgWords: number; messages: number }[];
  oneWorders: { userId: string; share: number; oneWord: number; messages: number }[];
  typoKings: EditDeleteRow[];
  guildIconUrl?: string | null;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function numbered(lines: string[]): string {
  return lines.length > 0 ? lines.map((l, i) => `${i + 1}. ${l}`).join('\n') : '—';
}

/** Total length of all TextDisplay text in a message. */
function textTotal(texts: string[]): number {
  return texts.reduce((n, t) => n + t.length, 0);
}

/** Largest list cap (from `steps`, widest first) for which `build(cap)` fits the budget; the smallest if none does. */
function fitBudget(steps: number[], build: (cap: number) => string[]): string[] {
  let texts: string[] = [];
  for (const cap of steps) {
    texts = build(cap);
    if (textTotal(texts) <= MONTHLY_TEXT_BUDGET) return texts;
  }
  return texts;
}

function recapHeader(data: MonthlyRecapData): string {
  return [
    '## 📅 Monthly recap',
    `-# ${monthLabel(data.month, data.timeZone)}`,
    '',
    `**${fmt(data.monthTotal)}** messages · **${fmt(data.monthReactions)}** reactions · **${fmt(data.activeMembers)}** active members · **${fmt(Math.floor(data.voiceMs / 3_600_000))}h** in voice`,
    `-# ${fmt(data.total)} messages all time`,
  ].join('\n');
}

/** "Busiest day **Saturday** · busiest hour **21:00** · peak **Sat 22:00** (123 msgs)", or a dash. */
export function peakHoursText(grid: number[][]): string {
  const p = heatmapPeaks(grid);
  if (!p) return '—';
  const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;
  return `Busiest day **${WEEKDAYS[p.busiestDay]}** · busiest hour **${hh(p.busiestHour)}** · peak **${WEEKDAYS[p.peak.day]!.slice(0, 3)} ${hh(p.peak.hour)}** (${fmt(p.peak.count)} ${plural(p.peak.count, 'msg', 'msgs')})`;
}

/** Text blocks of the recap message in order; `cap` limits every list. Index 0 is the header. */
function recapTexts(data: MonthlyRecapData, cap: number): string[] {
  const n = (base: number): number => Math.min(base, cap);
  const ranked = (rows: ReactionCountRow[]): string => numbered(rows.slice(0, n(3)).map((r) => `<@${r.userId}> — **${fmt(r.count)}**`));
  const top = data.topMessagers.slice(0, n(5));
  const channels = numbered(data.topChannels.slice(0, n(5)).map((c) => `<#${c.channelId}> — **${fmt(c.count)}**`));
  return [
    recapHeader(data),
    ['### 🏆 Top messagers', ...(top.length > 0 ? leaderboardLines(top, data.monthTotal, data.xpByUser) : ['—'])].join('\n'),
    `### 💬 Most used channels\n${channels}`,
    ['### 😄 Reactions', '**Given**', ranked(data.topGiven), '', '**Received**', ranked(data.topReceived)].join('\n'),
    `### 🎙️ Voice time\n${voiceRanked(data.topVoice.slice(0, n(5)))}`,
    '### 📈 Messages per day',
    `### ⏰ Peak hours\n${peakHoursText(data.heatmap)}`,
  ];
}

/** Pure builder: the first monthly message (stats, charts). */
export function buildMonthlyRecapMessage(data: MonthlyRecapData) {
  const texts = fitBudget([Infinity, 3, 2, 1], (cap) => recapTexts(data, cap));
  const text = (i: number): TextDisplayBuilder => new TextDisplayBuilder().setContent(texts[i]!);

  const counts = new Map(data.perDay.map((d) => [d.day, d.count]));
  const chart = renderDailyChart(monthDaySeries(data.month, data.timeZone).map((d) => ({ label: d.label, count: counts.get(d.key) ?? 0 })));
  const heatmap = renderHeatmap(data.heatmap);

  const container = new ContainerBuilder().setAccentColor(BLURPLE);
  if (data.guildIconUrl) {
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(0)).setThumbnailAccessory(new ThumbnailBuilder().setURL(data.guildIconUrl)));
  } else {
    container.addTextDisplayComponents(text(0));
  }
  container
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(1))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(2))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(3))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(4))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(5))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${MONTHLY_CHART_NAME}`)))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(6))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${MONTHLY_HEATMAP_NAME}`)));

  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    files: [new AttachmentBuilder(chart, { name: MONTHLY_CHART_NAME }), new AttachmentBuilder(heatmap, { name: MONTHLY_HEATMAP_NAME })],
    allowedMentions: NO_MENTIONS,
  };
}

/** One award: bold title, `·` subtitle, then up to `cap` numbered lines (a dash when empty). */
function award(title: string, subtitle: string, lines: string[], cap: number, plain = false): string {
  const body = plain ? (lines[0] ?? '—') : numbered(lines.slice(0, cap));
  return `**${title}** · ${subtitle}\n${body}`;
}

/** Text blocks of the awards message; `cap` limits every list. Index 0 is the header, the rest are the groups. */
function awardsTexts(data: MonthlyRecapData, cap: number): string[] {
  const m = data.topMessage;
  const message = m
    ? [`<@${m.authorId}> in <#${m.channelId}> — **${fmt(m.count)}** ${plural(m.count, 'reaction', 'reactions')} · [Jump](https://discord.com/channels/${data.guildId}/${m.channelId}/${m.messageId})`]
    : [];
  const count = (c: number, one: string, many: string): string => `**${fmt(c)}** ${plural(c, one, many)}`;
  const pct = (share: number): string => `**${Math.round(share * 100)}%** one-word`;
  const pair = (a: string, b: string, tail: string): string => `<@${a}> & <@${b}> — ${tail}`;

  return [
    `## 🏅 Awards · ${monthLabel(data.month, data.timeZone)}`,
    [
      award('⭐ Message of the month', 'most reactions on one message', message, 1, true),
      '',
      award('🎭 Crowd pleaser', 'most reactions per message', data.crowdPleasers.map((r) => `<@${r.userId}> — **${r.ratio.toFixed(1)}** per msg`), cap),
      '',
      award('👀 Silent spectator', 'reacts a lot, barely talks', data.silentSpectators.map((r) => `<@${r.userId}> — ${count(r.given, 'reaction', 'reactions')}`), cap),
      '',
      award('💞 Biggest fan', 'reacted most to one person', data.biggestFans.map((r) => `<@${r.reactorId}> → <@${r.authorId}> — **${fmt(r.count)}**`), cap),
    ].join('\n'),
    [
      award('🦉 Night owl', 'midnight–5am', data.nightOwls.map((r) => `<@${r.userId}> — ${count(r.count, 'msg', 'msgs')}`), cap),
      '',
      award('🐓 Early bird', '5–8am', data.earlyBirds.map((r) => `<@${r.userId}> — ${count(r.count, 'msg', 'msgs')}`), cap),
      '',
      award('🗣️ Conversation starter', 'first message after 1h+ of silence', data.starters.map((r) => `<@${r.userId}> — ${count(r.count, 'start', 'starts')}`), cap),
      '',
      award('🔥 Streak', 'most days in a row', data.streaks.map((r) => `<@${r.userId}> — ${count(r.days, 'day', 'days')}`), cap),
    ].join('\n'),
    award('🤝 Voice buddies', 'most time in a call together', data.buddies.map((r) => pair(r.a, r.b, `**${fmtHoursMinutes(r.ms)}**`)), cap),
    [
      award('✍️ Novelist', 'longest messages', data.novelists.map((r) => `<@${r.userId}> — **${r.avgWords.toFixed(1)}** words/msg`), cap),
      '',
      award('🤏 One-word replier', 'shortest replies', data.oneWorders.map((r) => `<@${r.userId}> — ${pct(r.share)}`), cap),
      '',
      award('✏️ Typo king', 'edits & deletes', data.typoKings.map((r) => `<@${r.userId}> — ${count(r.edits, 'edit', 'edits')} · ${count(r.deletes, 'delete', 'deletes')}`), cap),
    ].join('\n'),
  ];
}

/** Pure builder: the second monthly message (awards). */
export function buildMonthlyAwardsMessage(data: MonthlyRecapData) {
  const texts = fitBudget([3, 2, 1], (cap) => awardsTexts(data, cap));
  const container = new ContainerBuilder().setAccentColor(GOLD);
  texts.forEach((t, i) => {
    if (i > 0) container.addSeparatorComponents(divider());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(t));
  });
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    allowedMentions: NO_MENTIONS,
  };
}
