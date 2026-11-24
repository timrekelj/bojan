import { ContainerBuilder, MessageFlags, TextDisplayBuilder, type Client, type SendableChannels } from 'discord.js';
import type { BotDatabase, VoiceXpRow } from './db.js';
import { fmt } from './stats.js';
import { BLURPLE } from './weekly.js';
import { NO_MENTIONS } from './discord.js';

/** XP awarded per eligible message: a random 5–10. */
export const XP_MIN = 5;
export const XP_MAX = 10;
/** Per-user cooldown between XP awards. */
export const XP_COOLDOWN_MS = 30_000;

/** XP granted per already-recorded message by the one-time `/backfill xp`. */
export const XP_BACKFILL_PER_MESSAGE = 10;


/** Random XP per message, 5–10 inclusive. `rand` is injectable for tests. */
export function rollXp(rand: () => number = Math.random): number {
  return XP_MIN + Math.floor(rand() * (XP_MAX - XP_MIN + 1));
}

/**
 * Total XP required to reach `level` (level 0 needs none). Every level costs
 * 100 XP more than the one before it: level 1 at 100, 2 at 300, 3 at 600, …
 */
export function totalXpForLevel(level: number): number {
  return 50 * level * (level + 1);
}

/** The level a member with a given total XP has reached. */
export function levelFromXp(xp: number): number {
  if (xp <= 0) return 0;
  // Inverse of 50*L*(L+1) <= xp:  L <= (sqrt(1 + xp/12.5) - 1) / 2
  return Math.floor((Math.sqrt(1 + xp / 12.5) - 1) / 2);
}

export interface LevelProgress {
  level: number;
  /** XP earned within the current level. */
  intoLevel: number;
  /** XP still needed to reach the next level. */
  needed: number;
  /** Total XP required for the next level. */
  nextLevelXp: number;
}

export function levelProgress(xp: number): LevelProgress {
  const level = levelFromXp(xp);
  const nextLevelXp = totalXpForLevel(level + 1);
  return { level, intoLevel: xp - totalXpForLevel(level), needed: nextLevelXp - xp, nextLevelXp };
}

/**
 * Compact level + progress tag for stat displays, e.g. "lvl 12 · 450/700":
 * XP earned within the current level (restarts at 0 on level-up) over the
 * full cost of the next level. `null` when the member has no XP row at all.
 */
export function levelTag(xp: number | null): string | null {
  if (xp === null) return null;
  const { level, intoLevel, needed } = levelProgress(xp);
  return `lvl ${level} · ${fmt(intoLevel)}/${fmt(intoLevel + needed)}`;
}

/**
 * Steam's level-badge tiers: the badge background moves in 10-level steps
 * from slate to gold. Colours sampled (and rounded) from Steam's badge tiers.
 */
export const STEAM_LEVEL_BANDS: readonly { from: string; to: string }[] = [
  { from: '#6b7c93', to: '#4a5b70' }, // 0–9   slate
  { from: '#7f9c47', to: '#5c7730' }, // 10–19 olive green
  { from: '#4f9ea8', to: '#2f7480' }, // 20–29 teal
  { from: '#4f7fc0', to: '#2f5a93' }, // 30–39 blue
  { from: '#7b5fb0', to: '#553e85' }, // 40–49 purple
  { from: '#b05597', to: '#833a6e' }, // 50–59 pink
  { from: '#c0564a', to: '#8f352c' }, // 60–69 red
  { from: '#c07b3a', to: '#8f5522' }, // 70–79 orange
  { from: '#c0a23a', to: '#8f7422' }, // 80–89 gold
  { from: '#6d6d78', to: '#3c3c45' }, // 90–99 graphite
];

/** Top band (100+) is gold and caps there. */
const STEAM_LEVEL_TOP = { from: '#d4af37', to: '#a3821f' };

/** Badge gradient for a level: Steam-style tiered colours, 10 levels per band. */
export function steamLevelColors(level: number): { from: string; to: string } {
  const band = Number.isFinite(level) ? Math.floor(level / 10) : 0;
  if (band >= STEAM_LEVEL_BANDS.length) return STEAM_LEVEL_TOP;
  return STEAM_LEVEL_BANDS[Math.max(0, band)] ?? STEAM_LEVEL_TOP;
}

export interface XpAwardResult {
  /** XP gained from this message (5–10) or winning reaction (level + 1). */
  xpGained: number;
  /** The member's new total XP. */
  xp: number;
  newLevel: number;
  leveledUp: boolean;
}

/**
 * Award a random 5–10 XP for one eligible message, unless the member earned
 * XP within the cooldown window (per user). Returns null when on cooldown;
 * XP is stored permanently in the `user_xp` table.
 */
export function awardMessageXp(db: BotDatabase, guildId: string, userId: string, ts: number): XpAwardResult | null {
  const row = db.getUserXp(guildId, userId);
  if (row && ts - row.lastXpAt < XP_COOLDOWN_MS) return null;
  const xpGained = rollXp();
  const xp = db.addUserXp(guildId, userId, xpGained, ts);
  const newLevel = levelFromXp(xp);
  return { xpGained, xp, newLevel, leveledUp: newLevel > levelFromXp(row?.xp ?? 0) };
}

/** Chance per eligible reaction to earn reaction XP. */
export const REACT_XP_CHANCE = 0.01;

/** XP for one winning reaction: the member's current level + 1 (lvl 0 → 1, lvl 49 → 50). */
export function reactXpAmount(level: number): number {
  return level + 1;
}

/**
 * Roll the 1% reaction-XP chance for one eligible reaction. Returns null when
 * the roll misses (no database read or write); a win adds `level + 1` XP for
 * the member's current level, refreshing the same cooldown window as message
 * XP. XP is stored permanently in the `user_xp` table. `rand` is injectable
 * for tests.
 */
export function awardReactionXp(db: BotDatabase, guildId: string, userId: string, ts: number, rand: () => number = Math.random): XpAwardResult | null {
  if (rand() >= REACT_XP_CHANCE) return null;
  const row = db.getUserXp(guildId, userId);
  const xpGained = reactXpAmount(levelFromXp(row?.xp ?? 0));
  const xp = db.addUserXp(guildId, userId, xpGained, ts);
  const newLevel = levelFromXp(xp);
  return { xpGained, xp, newLevel, leveledUp: newLevel > levelFromXp(row?.xp ?? 0) };
}

/** Length of one voice XP block. */
export const VOICE_XP_BLOCK_MS = 600_000;
/** XP granted per completed voice block. */
export const VOICE_XP_PER_BLOCK = 10;

/** Whole voice blocks in an elapsed time; partial blocks are dropped. */
export function voiceXpBlocks(elapsedMs: number): number {
  return Math.max(0, Math.floor(elapsedMs / VOICE_XP_BLOCK_MS));
}

/**
 * Award 10 XP for every newly completed voice block of one open session.
 * Returns null when no block has completed since the last award, so the
 * ticker can call it freely; XP is stored permanently in `user_xp`.
 */
export function awardVoiceXp(
  db: BotDatabase,
  guildId: string,
  userId: string,
  row: VoiceXpRow,
  now: number,
): XpAwardResult | null {
  const blocks = voiceXpBlocks(now - row.startedAt);
  const delta = blocks - row.awardedBlocks;
  if (delta <= 0) return null;
  const xpGained = delta * VOICE_XP_PER_BLOCK;
  const xp = db.awardVoiceXp(guildId, userId, row.id, blocks, xpGained, now);
  const newLevel = levelFromXp(xp);
  const leveledUp = newLevel > levelFromXp(xp - xpGained);
  return { xpGained, xp, newLevel, leveledUp };
}

export interface LevelUpData {
  userId: string;
  username: string;
  level: number;
  xp: number;
  nextLevelXp: number;
}

/** Text of the level-up card (exported so smoke tests can budget-check it). */
export function levelUpText(data: LevelUpData): string {
  return [
    '## 🎉 Level up!',
    `<@${data.userId}> just reached **level ${data.level}**!`,
    `-# ${data.username} · ${fmt(data.xp)} XP total · level ${data.level + 1} at ${fmt(data.nextLevelXp)} XP`,
  ].join('\n');
}

/** Level-up announcement: a small Components V2 card that never pings. */
export function buildLevelUpMessage(data: LevelUpData) {
  const container = new ContainerBuilder().setAccentColor(BLURPLE);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(levelUpText(data)));
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    allowedMentions: NO_MENTIONS,
  };
}

/**
 * Post the level-up announcement in the configured channel. Best-effort: a
 * failed announcement never breaks XP tracking.
 */
export async function announceLevelUp(
  client: Client,
  guildId: string,
  levelupChannelId: string,
  data: { userId: string; username: string; level: number; xp: number },
): Promise<void> {
  try {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
    const channel = await guild.channels.fetch(levelupChannelId).catch(() => null);
    if (!channel || !channel.isSendable()) {
      console.error(`[levels] level-up channel ${levelupChannelId} unavailable in guild ${guildId}`);
      return;
    }
    await (channel as SendableChannels).send(
      buildLevelUpMessage({ ...data, nextLevelXp: levelProgress(data.xp).nextLevelXp }),
    );
    console.log(`[levels] ${data.userId} reached level ${data.level} in guild ${guildId}`);
  } catch (err) {
    console.error(`[levels] level-up announcement failed in guild ${guildId}:`, err);
  }
}
