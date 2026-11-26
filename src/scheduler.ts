import { PermissionFlagsBits, type Client, type Guild, type PermissionsBitField, type TextChannel } from 'discord.js';
import type { BotDatabase, Settings } from './db.js';
import { crowdPleasers, currentMonthBounds, currentWeekBounds, isMonthlyDue, lastMonthBounds, lastWeekBounds, silentSpectators, zonedToUtcMs, type MonthBounds } from './stats.js';
import { buildWeeklyStatsMessage } from './weekly.js';
import { buildMonthlyAwardsMessage, buildMonthlyRecapMessage, type MonthlyRecapData } from './monthly.js';
import { activityHeatmap, CONVO_GAP_MS, conversationStarters, earlyBirds, longestStreaks, nightOwls, novelists, oneWorders, typoKings, voiceBuddies, voiceTotalMs, voiceTotals } from './recap.js';
import { announceLevelUp, awardVoiceXp } from './levels.js';
import { beginChallenge, finalizeChallenge, refreshChallengeCard } from './challenges/actions.js';

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

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The configured stats channel if it exists, is text based and the bot may post in it. */
async function resolveStatsChannel(guild: Guild, settings: Settings): Promise<{ ok: true; channel: TextChannel } | { ok: false; reason: string }> {
  const channelId = settings.statsChannelId;
  if (!channelId) return { ok: false, reason: NO_CHANNEL_REASON };

  let channel;
  try {
    channel = await guild.channels.fetch(channelId);
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${errText(err)}` };
  }
  if (!channel || !channel.isTextBased() || !('send' in channel)) return { ok: false, reason: 'not a text channel' };

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const missing = missingChannelPermissions(me ? channel.permissionsFor(me) : null, channel.isThread());
  if (missing.length > 0) return { ok: false, reason: `missing permissions: ${missing.join(', ')}` };
  return { ok: true, channel: channel as TextChannel };
}

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
  try {
    const resolved = await resolveStatsChannel(guild, settings);
    if (!resolved.ok) return resolved;

    const week = lastWeekBounds(settings.timezone, now);
    const awardRows = db.reactionMessageStats(guild.id, week.start, week.end);
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
      crowdPleasers: crowdPleasers(awardRows, 3),
      silentSpectators: silentSpectators(awardRows, 3),
      topVoice: voiceTotals(db.voiceSessionsInRange(guild.id, week.start, week.end, Date.now()), week.start, week.end, 5, guild.afkChannelId),
      guildIconUrl: guild.iconURL({ size: 128 }),
    });
    try {
      await resolved.channel.send(payload);
    } catch (err) {
      return { ok: false, reason: `send failed: ${errText(err)}` };
    }
    return { ok: true, channelId: resolved.channel.id };
  } catch (err) {
    return { ok: false, reason: `failed: ${errText(err)}` };
  }
}

/** The previous month's data for the recap; pure reads from the DB, reusable by anything that wants the numbers. */
export function gatherMonthlyData(
  guild: Pick<Guild, 'id' | 'afkChannelId' | 'iconURL'>,
  db: BotDatabase,
  settings: Settings,
  month: MonthBounds,
  now: Date,
): MonthlyRecapData {
  const g = guild.id;
  const tz = settings.timezone;
  const afk = guild.afkChannelId;
  // Fetched from one gap early so conversation starters near the 1st see the previous message.
  const all = db.messageActivity(g, month.start - CONVO_GAP_MS, month.end);
  const rows = all.filter((r) => r.ts >= month.start);
  const sessions = db.voiceSessionsInRange(g, month.start, month.end, now.getTime());
  const awardRows = db.reactionMessageStats(g, month.start, month.end);
  const heatmap = activityHeatmap(rows, tz);
  return {
    guildId: g,
    month,
    timeZone: tz,
    monthTotal: db.countMessages(g, month.start, month.end),
    monthReactions: db.countReactions(g, month.start, month.end),
    activeMembers: db.countActiveMembers(g, month.start, month.end),
    voiceMs: voiceTotalMs(sessions, month.start, month.end, afk),
    total: db.countMessages(g),
    topMessagers: db.topUsers(g, 5, month.start, month.end),
    xpByUser: db.getUserXpTotals(g),
    topChannels: db.topChannels(g, month.start, month.end, 5),
    topGiven: db.topReactionsGiven(g, 3, month.start, month.end),
    topReceived: db.topReactionsReceived(g, 3, month.start, month.end),
    topVoice: voiceTotals(sessions, month.start, month.end, 5, afk),
    perDay: db.messageCountsPerDay(g, month.start, month.end, tz),
    heatmap,
    topMessage: db.topReactedMessages(g, month.start, month.end, 1)[0] ?? null,
    crowdPleasers: crowdPleasers(awardRows, 3),
    silentSpectators: silentSpectators(awardRows, 3),
    biggestFans: db.topReactionPairs(g, month.start, month.end, 3),
    nightOwls: nightOwls(rows, tz, 3),
    earlyBirds: earlyBirds(rows, tz, 3),
    starters: conversationStarters(all, month.start, month.end, 3, CONVO_GAP_MS),
    streaks: longestStreaks(rows, tz, 3),
    buddies: voiceBuddies(sessions, month.start, month.end, 3, afk),
    novelists: novelists(rows, 3),
    oneWorders: oneWorders(rows, 3),
    typoKings: typoKings(db.editDeleteCounts(g, month.start, month.end), 3),
    guildIconUrl: guild.iconURL({ size: 128 }),
  };
}

export type PostMonthlyResult = PostWeeklyResult | { ok: false; reason: string; recapSent: true };

/**
 * Posts the previous month's recap (stats message, then awards message) to the
 * configured stats channel. Never throws; does not touch the state key. When only the
 * awards message fails, `recapSent` is true so the scheduler doesn't post the recap twice.
 */
export async function postMonthlyRecap(
  guild: Guild,
  db: BotDatabase,
  settings: Settings,
  now: Date = new Date(),
): Promise<PostMonthlyResult> {
  try {
    const resolved = await resolveStatsChannel(guild, settings);
    if (!resolved.ok) return resolved;

    const data = gatherMonthlyData(guild, db, settings, lastMonthBounds(settings.timezone, now), now);
    const recap = buildMonthlyRecapMessage(data);
    const awards = buildMonthlyAwardsMessage(data);
    try {
      await resolved.channel.send(recap);
    } catch (err) {
      return { ok: false, reason: `send failed: ${errText(err)}` };
    }
    try {
      await resolved.channel.send(awards);
    } catch (err) {
      return { ok: false, reason: `awards message send failed: ${errText(err)}`, recapSent: true };
    }
    return { ok: true, channelId: resolved.channel.id };
  } catch (err) {
    return { ok: false, reason: `failed: ${errText(err)}` };
  }
}

/**
 * What the scheduler does for the monthly recap: `seed` when nothing was ever recorded
 * (remember the current month without posting, so shipping mid-month has no backlog),
 * `post` when the 1st at `hour` has passed and this month was not sent, else `none`.
 */
export function monthlyAction(state: string | null | undefined, timeZone: string, hour: number, now: Date): 'seed' | 'post' | 'none' {
  if (state === null || state === undefined) return 'seed';
  return isMonthlyDue(timeZone, hour, now, state) ? 'post' : 'none';
}

/**
 * Every tick, for each guild: post last week's stats when the configured weekly
 * day/hour has been reached this week, and last month's recap on the 1st (each
 * independent of the other's enabled flag).
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

  const weeklyStep = async (guild: Guild, settings: Settings, now: Date): Promise<void> => {
    let weekKeyForLog = '';
    try {
      const currentWeek = currentWeekBounds(settings.timezone, now);
      weekKeyForLog = currentWeek.key;
      const prefix = `${guild.id}:${currentWeek.key}`;
      const stateKey = `weekly:${guild.id}`;

      if (!isWeeklyDue(settings.timezone, settings.weeklyDay, settings.weeklyHour, now, db.getState(stateKey))) return;

      logOnce(`${prefix}:due`, 'log', `[scheduler] guild ${guild.id}: weekly stats due (week ${currentWeek.key}), posting to channel ${settings.statsChannelId ?? '(none)'}`);

      const result = await postWeeklyStats(guild, db, settings, now);
      if (!result.ok) {
        const level = result.reason === NO_CHANNEL_REASON ? 'warn' : 'error';
        logOnce(`${prefix}:post-failed:${result.reason}`, level, `[scheduler] guild ${guild.id}: weekly stats not posted: ${result.reason}; will retry each tick (week ${currentWeek.key})`);
        return;
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
  };

  const monthlyStep = async (guild: Guild, settings: Settings, now: Date): Promise<void> => {
    let monthKeyForLog = '';
    try {
      const currentMonth = currentMonthBounds(settings.timezone, now);
      monthKeyForLog = currentMonth.key;
      const prefix = `${guild.id}:monthly:${currentMonth.key}`;
      const stateKey = `monthly:${guild.id}`;

      const action = monthlyAction(db.getState(stateKey), settings.timezone, settings.weeklyHour, now);
      if (action === 'none') return;
      if (action === 'seed') {
        db.setState(stateKey, currentMonth.key);
        logOnce(`${prefix}:seed`, 'log', `[scheduler] guild ${guild.id}: monthly recap seeded at ${currentMonth.key} (no backlog posted)`);
        return;
      }

      logOnce(`${prefix}:due`, 'log', `[scheduler] guild ${guild.id}: monthly recap due (month ${currentMonth.key}), posting to channel ${settings.statsChannelId ?? '(none)'}`);

      const result = await postMonthlyRecap(guild, db, settings, now);
      if (!result.ok) {
        if ('recapSent' in result) {
          // The recap is out; retrying would post it twice. Mark the month done and report the missing awards.
          db.setState(stateKey, currentMonth.key);
          console.error(`[scheduler] guild ${guild.id}: monthly recap posted but ${result.reason} (month ${currentMonth.key})`);
          return;
        }
        const level = result.reason === NO_CHANNEL_REASON ? 'warn' : 'error';
        logOnce(`${prefix}:post-failed:${result.reason}`, level, `[scheduler] guild ${guild.id}: monthly recap not posted: ${result.reason}; will retry each tick (month ${currentMonth.key})`);
        return;
      }
      db.setState(stateKey, currentMonth.key);
      const month = lastMonthBounds(settings.timezone, now);
      console.log(`[scheduler] posted monthly recap for guild ${guild.id} (month ${month.key})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const key = `${guild.id}:${monthKeyForLog}:monthly-error:${msg}`;
      if (!logged.has(key)) {
        logged.add(key);
        console.error(`[scheduler] guild ${guild.id} monthly recap failed (will retry each tick):`, err);
      }
    }
  };

  const runTick = async (): Promise<void> => {
    for (const guild of client.guilds.cache.values()) {
      let settings: Settings;
      try {
        settings = db.getSettings(guild.id);
      } catch (err) {
        console.error(`[scheduler] guild ${guild.id}: could not read settings:`, err);
        continue;
      }
      const now = new Date();
      if (settings.weeklyEnabled) await weeklyStep(guild, settings, now);
      if (settings.monthlyEnabled) await monthlyStep(guild, settings, now);
    }
  };

  void tick(); // run once at startup; isWeeklyDue catches up a missed hour within the same week
  return setInterval(() => void tick(), TICK_MS);
}

const VOICE_XP_TICK_MS = 60_000;

/**
 * Award voice XP once a minute: every still-open voice session gets 10 XP per
 * newly completed 10-minute block. Sessions in the AFK channel, of bots, or
 * that no longer match the live voice state are skipped, and nothing accrues
 * while leveling is disabled. Late blocks are paid on the next tick, so a
 * restart or a slow tick never loses XP.
 */
export function startVoiceXpTicker(client: Client, db: BotDatabase): NodeJS.Timeout {
  let running = false; // in-flight guard: skip a tick while the previous one is still running
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const guild of client.guilds.cache.values()) {
        try {
          // Heartbeat (independent of leveling): lets startup close voice sessions
          // of members who left while the bot was offline.
          db.setState(`voice:heartbeat:${guild.id}`, String(now));
          const settings = db.getSettings(guild.id);
          if (!settings.levelingEnabled) continue;
          for (const row of db.openVoiceSessions(guild.id)) {
            const live = guild.voiceStates.cache.get(row.userId);
            if (!live || live.channelId !== row.channelId) continue;
            if (guild.afkChannelId && row.channelId === guild.afkChannelId) continue;
            const member = guild.members.cache.get(row.userId);
            if (member?.user.bot) continue;
            const award = awardVoiceXp(db, guild.id, row.userId, row, now);
            if (!award) continue;
            console.log(`[scheduler] guild ${guild.id}: voice xp +${award.xpGained} for ${row.userId} in ${row.channelId} (total ${award.xp})`);
            if (award.leveledUp && settings.levelupChannelId) {
              await announceLevelUp(client, guild.id, settings.levelupChannelId, {
                userId: row.userId,
                username: member?.displayName ?? row.userId,
                level: award.newLevel,
                xp: award.xp,
              });
            }
          }
        } catch (err) {
          console.error(`[scheduler] voice xp failed in guild ${guild.id}:`, err);
        }
      }
    } finally {
      running = false;
    }
  };
  return setInterval(() => void tick(), VOICE_XP_TICK_MS);
}

const CHALLENGE_TICK_MS = 60_000;
const CHALLENGE_REFRESH_MS = 5 * 60_000;

/**
 * Once a minute: finalize every pending challenge whose deadline passed
 * (status, reward role, card without buttons), start upcoming ones whose start
 * arrived, otherwise refresh the card's leaderboard at most every 5 minutes.
 * One failure never stops the loop.
 */
export function startChallengeTicker(client: Client, db: BotDatabase): NodeJS.Timeout {
  let running = false; // in-flight guard: skip a tick while the previous one is still running
  const lastRefresh = new Map<number, number>();
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const pending = db.pendingChallenges();
      const liveIds = new Set(pending.map((c) => c.id));
      for (const id of lastRefresh.keys()) if (!liveIds.has(id)) lastRefresh.delete(id);
      if (pending.length === 0) return;
      for (const guild of client.guilds.cache.values()) {
        for (const challenge of pending) {
          if (challenge.guildId !== guild.id) continue;
          try {
            if (challenge.endsAt <= now) {
              await finalizeChallenge(client, db, challenge, now);
              lastRefresh.delete(challenge.id);
              continue;
            }
            if (challenge.status === 'upcoming' && challenge.startsAt <= now) {
              await beginChallenge(client, db, challenge, now);
              lastRefresh.set(challenge.id, now);
              continue;
            }
            if (now - (lastRefresh.get(challenge.id) ?? 0) < CHALLENGE_REFRESH_MS) continue;
            lastRefresh.set(challenge.id, now);
            await refreshChallengeCard(client, db, challenge, now);
          } catch (err) {
            console.error(`[challenges] guild ${guild.id}: tick failed for challenge #${challenge.id}:`, err);
          }
        }
      }
    } finally {
      running = false;
    }
  };
  void tick(); // finalize overdue challenges right after a restart
  return setInterval(() => void tick(), CHALLENGE_TICK_MS);
}
