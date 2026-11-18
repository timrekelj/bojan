import type { Client, TextChannel } from 'discord.js';
import type { BotDatabase, ReactionCountRow } from './db.js';
import { barChartLines, currentWeekBounds, fmt, lastWeekBounds, leaderboardLines, localParts, weekRangeLabel } from './stats.js';

const TICK_MS = 30_000;

/**
 * Every tick, for each guild: if the configured weekly day/hour has been
 * reached this week and we haven't sent yet, post last week's stats.
 */
export function startWeeklyScheduler(client: Client, db: BotDatabase): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const settings = db.getSettings(guild.id);
        if (!settings.weeklyEnabled || !settings.statsChannelId) continue;

        const now = new Date();
        const local = localParts(settings.timezone, now);
        const hour = Number(
          new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone, hour: 'numeric', hour12: false }).format(now),
        ) % 24;
        if (local.weekday !== settings.weeklyDay || hour !== settings.weeklyHour) continue;

        const currentWeek = currentWeekBounds(settings.timezone, now);
        const stateKey = `weekly:${guild.id}`;
        if (db.getState(stateKey) === currentWeek.key) continue; // already sent this week

        const week = lastWeekBounds(settings.timezone, now);
        const total = db.countMessages(guild.id);
        const weekTotal = db.countMessages(guild.id, week.start, week.end);
        const weekReactions = db.countReactions(guild.id, week.start, week.end);
        const topMessagers = db.topUsers(guild.id, 5, week.start, week.end);
        const topChannels = db.topChannels(guild.id, week.start, week.end, 5);
        const topGiven = db.topReactionsGiven(guild.id, 3, week.start, week.end);
        const topReceived = db.topReactionsReceived(guild.id, 3, week.start, week.end);
        const perDay = db.messageCountsPerDay(guild.id, week.start, week.end, settings.timezone);

        const channel = await guild.channels.fetch(settings.statsChannelId).catch(() => null);
        if (!channel || !(channel.isTextBased() && 'send' in channel)) continue;

        const fmtRanks = (rows: ReactionCountRow[]): string =>
          rows.length > 0 ? rows.map((r, i) => `${i + 1}. <@${r.userId}> (**${r.count}**)`).join(' · ') : '—';

        const content = [
          `## 📊 Weekly stats — ${weekRangeLabel(week, settings.timezone)}`,
          `**${fmt(weekTotal)}** messages · **${fmt(weekReactions)}** reactions · ${fmt(db.distinctActiveUsers(guild.id))} active members (${fmt(total)} messages all time)`,
          '',
          '### 🏆 Top messagers',
          ...leaderboardLines(topMessagers, weekTotal).slice(0, 5),
          '',
          '### 💬 Most used channels',
          topChannels.length > 0 ? topChannels.map((c, i) => `${i + 1}. <#${c.channelId}> — **${fmt(c.count)}**`).join('\n') : '—',
          '',
          '### 😄 Reactions',
          `Given:    ${fmtRanks(topGiven)}`,
          `Received: ${fmtRanks(topReceived)}`,
          '',
          '### 📈 Messages per day',
          ...barChartLines(perDay, week, settings.timezone),
        ].join('\n');
        await (channel as TextChannel).send(content);
        db.setState(stateKey, currentWeek.key);
        console.log(`[scheduler] posted weekly stats for guild ${guild.id} (week ${week.key})`);
      } catch (err) {
        console.error(`[scheduler] guild ${guild.id} failed:`, err);
      }
    }
  };

  void tick(); // run once at startup so a missed week is sent after a restart
  return setInterval(() => void tick(), TICK_MS);
}
