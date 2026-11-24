import { PermissionFlagsBits, type Client, type Guild, type PermissionsBitField, type TextChannel } from 'discord.js';
import type { BotDatabase, Settings } from './db.js';
import { currentWeekBounds, lastWeekBounds, zonedToUtcMs } from './stats.js';
import { buildWeeklyStatsMessage } from './weekly.js';

const TICK_MS = 30_000;

/**
 * True when this week's post is due: the current Monday-based week has not
 * been sent yet and `now` is at or after the scheduled local day+hour within
 * that week (so a missed hour is caught up later in the same week).
 * `weeklyDay` is 0 = Sunday .. 6 = Saturday.
 */
export function isWeeklyDue(
  timeZone: string,
  weeklyDay: number,
  weeklyHour: number,
  now: Date,
  lastSentWeekKey: string | null | undefined,
): boolean {
  const week = currentWeekBounds(timeZone, now);
  if (lastSentWeekKey === week.key) return false;
  const [y, mo, d] = week.key.split('-').map(Number) as [number, number, number];
  const dayOffset = (weeklyDay + 6) % 7; // Monday = 0 ... Sunday = 6
  const scheduled = zonedToUtcMs(timeZone, y, mo, d + dayOffset, weeklyHour);
  return now.getTime() >= scheduled;
}

/** Names of required permissions missing for the bot in a channel. */
export function missingChannelPermissions(
  perms: Readonly<PermissionsBitField> | null,
  isThread: boolean,
): string[] {
  if (!perms) return ['(could not resolve permissions)'];
  const required: Array<[string, bigint]> = [
    ['ViewChannel', PermissionFlagsBits.ViewChannel],
    [isThread ? 'SendMessagesInThreads' : 'SendMessages', isThread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages],
    ['AttachFiles', PermissionFlagsBits.AttachFiles],
    ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
  ];
  return required.filter(([, bit]) => !perms.has(bit)).map(([name]) => name);
}

export type PostWeeklyResult = { ok: true; channelId: string } | { ok: false; reason: string };

export const NO_CHANNEL_REASON = 'no stats channel configured';

/**
 * Builds last week's stats message and posts it to the configured stats
 * channel. Never throws; does not touch the "already sent" state key.
 */
export async function postWeeklyStats(
  guild: Guild,
  db: BotDatabase,
  settings: Settings,
  now: Date = new Date(),
): Promise<PostWeeklyResult> {
  const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  try {
    const channelId = settings.statsChannelId;
    if (!channelId) return { ok: false, reason: NO_CHANNEL_REASON };

    let channel;
    try {
      channel = await guild.channels.fetch(channelId);
    } catch (err) {
      return { ok: false, reason: `fetch failed: ${errMsg(err)}` };
    }
    if (!channel || !channel.isTextBased() || !('send' in channel)) return { ok: false, reason: 'not a text channel' };

    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const missing = missingChannelPermissions(me ? channel.permissionsFor(me) : null, channel.isThread());
    if (missing.length > 0) return { ok: false, reason: `missing permissions: ${missing.join(', ')}` };

    const week = lastWeekBounds(settings.timezone, now);
    const payload = buildWeeklyStatsMessage({
      week,
      timeZone: settings.timezone,
      weekTotal: db.countMessages(guild.id, week.start, week.end),
      weekReactions: db.countReactions(guild.id, week.start, week.end),
      activeMembers: db.distinctActiveUsers(guild.id),
      total: db.countMessages(guild.id),
      topMessagers: db.topUsers(guild.id, 5, week.start, week.end),
      xpByUser: db.getUserXpTotals(guild.id),
      topChannels: db.topChannels(guild.id, week.start, week.end, 5),
      topGiven: db.topReactionsGiven(guild.id, 3, week.start, week.end),
      topReceived: db.topReactionsReceived(guild.id, 3, week.start, week.end),
      perDay: db.messageCountsPerDay(guild.id, week.start, week.end, settings.timezone),
      guildIconUrl: guild.iconURL({ size: 128 }),
    });
    try {
      await (channel as TextChannel).send(payload);
    } catch (err) {
      return { ok: false, reason: `send failed: ${errMsg(err)}` };
    }
    return { ok: true, channelId };
  } catch (err) {
    return { ok: false, reason: `failed: ${errMsg(err)}` };
  }
}

/**
 * Every tick, for each guild: if the configured weekly day/hour has been
 * reached this week and we haven't sent yet, post last week's stats.
 */
export function startWeeklyScheduler(client: Client, db: BotDatabase): NodeJS.Timeout {
  const logged = new Set<string>();
  const logOnce = (key: string, level: 'log' | 'warn' | 'error', message: string): void => {
    if (logged.has(key)) return;
    logged.add(key);
    console[level](message);
  };

  let running = false; // in-flight guard: skip a tick while the previous one is still running
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runTick();
    } finally {
      running = false;
    }
  };

  const runTick = async (): Promise<void> => {
    for (const guild of client.guilds.cache.values()) {
      let weekKeyForLog = '';
      try {
        const settings = db.getSettings(guild.id);
        if (!settings.weeklyEnabled) continue;

        const now = new Date();
        const currentWeek = currentWeekBounds(settings.timezone, now);
        weekKeyForLog = currentWeek.key;
        const prefix = `${guild.id}:${currentWeek.key}`;
        const stateKey = `weekly:${guild.id}`;

        if (!isWeeklyDue(settings.timezone, settings.weeklyDay, settings.weeklyHour, now, db.getState(stateKey))) continue;

        logOnce(`${prefix}:due`, 'log', `[scheduler] guild ${guild.id}: weekly stats due (week ${currentWeek.key}), posting to channel ${settings.statsChannelId ?? '(none)'}`);

        const result = await postWeeklyStats(guild, db, settings, now);
        if (!result.ok) {
          const level = result.reason === NO_CHANNEL_REASON ? 'warn' : 'error';
          logOnce(`${prefix}:post-failed:${result.reason}`, level, `[scheduler] guild ${guild.id}: weekly stats not posted: ${result.reason}; will retry each tick (week ${currentWeek.key})`);
          continue;
        }
        db.setState(stateKey, currentWeek.key);
        const week = lastWeekBounds(settings.timezone, now);
        console.log(`[scheduler] posted weekly stats for guild ${guild.id} (week ${week.key})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const key = `${guild.id}:${weekKeyForLog}:error:${msg}`;
        if (!logged.has(key)) {
          logged.add(key);
          console.error(`[scheduler] guild ${guild.id} failed (will retry each tick):`, err);
        }
      }
    }
  };

  void tick(); // run once at startup; isWeeklyDue catches up a missed hour within the same week
  return setInterval(() => void tick(), TICK_MS);
}
