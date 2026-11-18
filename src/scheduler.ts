import type { Client, TextChannel } from 'discord.js';
import type { BotDatabase } from './db.js';
import { currentWeekBounds, fmt, lastWeekBounds, leaderboardLines, localParts, weekRangeLabel } from './stats.js';

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
        const rows = db.topUsers(guild.id, 10, week.start, week.end);

        const channel = await guild.channels.fetch(settings.statsChannelId).catch(() => null);
        if (!channel || !(channel.isTextBased() && 'send' in channel)) continue;

        const lines = leaderboardLines(rows, weekTotal);
        const header = [
          `## 📊 Weekly stats — ${weekRangeLabel(week, settings.timezone)}`,
          `${fmt(weekTotal)} messages from ${fmt(db.distinctActiveUsers(guild.id))} members this week (${fmt(total)} all time).`,
          '',
          ...lines,
        ].join('\n');
        await (channel as TextChannel).send(header);
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
