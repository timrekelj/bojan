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
 * Steam's level-badge colours: the same 10-colour cycle repeats in every
 * 100-level band (x0…x90). Colours sampled from Steam's badge sheet.
 */
export const STEAM_LEVEL_BANDS: readonly { from: string; to: string }[] = [
  { from: '#9aa0a8', to: '#565c66' }, // 0  grey
  { from: '#a3474a', to: '#6d2a2d' }, // 10 dark red
  { from: '#c45555', to: '#8c3030' }, // 20 red
  { from: '#c9a227', to: '#8a6a12' }, // 30 amber
  { from: '#6f9b45', to: '#456427' }, // 40 green
  { from: '#4f86c6', to: '#2f5a93' }, // 50 blue
  { from: '#7d5fb8', to: '#4f3a86' }, // 60 purple
  { from: '#b3529a', to: '#7a2f66' }, // 70 magenta
  { from: '#8a4650', to: '#57303a' }, // 80 maroon
  { from: '#a89536', to: '#6f6120' }, // 90 olive-gold
];

/** Badge gradient for a level: the 10-colour cycle repeats every 100 levels. */
export function steamLevelColors(level: number): { from: string; to: string } {
  const safe = Number.isFinite(level) ? Math.floor(level) : 0;
  const band = Math.floor((Math.max(0, safe) % 100) / 10);
  return STEAM_LEVEL_BANDS[band] ?? STEAM_LEVEL_BANDS[0]!;
}

/**
 * Badge shapes in 100-level steps, mirroring Steam's badge sheet
 * (CSS approximations, not pixel copies). 900+ keeps the last shape.
 */
export const STEAM_LEVEL_SHAPES: readonly string[] = [
  'circle', 'hex', 'squircle', 'shield', 'diamond', 'octagon', 'hexflat', 'pentagon', 'bevel',
];

/** Badge shape for a level: changes every 100 levels and caps at the last one. */
export function steamLevelShape(level: number): string {
  const safe = Number.isFinite(level) ? Math.floor(level) : 0;
  const index = Math.min(STEAM_LEVEL_SHAPES.length - 1, Math.floor(Math.max(0, safe) / 100));
  return STEAM_LEVEL_SHAPES[index] ?? 'circle';
}

export interface BadgeOutline {
  tag: 'circle' | 'rect' | 'polygon';
  attrs: string;
}

/**
 * Outline geometry for the hollow dashboard badge, in a 52×52 viewBox inset
 * ~2.5px so a 3px stroke is not clipped. Keyed by the `STEAM_LEVEL_SHAPES` names.
 */
export const STEAM_LEVEL_OUTLINES: Record<string, BadgeOutline> = {
  circle: { tag: 'circle', attrs: 'cx="26" cy="26" r="22.5"' },
  squircle: { tag: 'rect', attrs: 'x="3" y="3" width="46" height="46" rx="13"' },
  hex: { tag: 'polygon', attrs: 'points="26,2.5 47.5,14.5 47.5,37.5 26,49.5 4.5,37.5 4.5,14.5"' },
  shield: { tag: 'polygon', attrs: 'points="2.5,2.5 49.5,2.5 49.5,32 26,49.5 2.5,32"' },
  diamond: { tag: 'polygon', attrs: 'points="26,2.5 49.5,26 26,49.5 2.5,26"' },
  octagon: { tag: 'polygon', attrs: 'points="15,2.5 37,2.5 49.5,15 49.5,37 37,49.5 15,49.5 2.5,37 2.5,15"' },
  hexflat: { tag: 'polygon', attrs: 'points="13,2.5 39,2.5 49.5,26 39,49.5 13,49.5 2.5,26"' },
  pentagon: { tag: 'polygon', attrs: 'points="26,2.5 49.5,20 41,49.5 11,49.5 2.5,20"' },
  bevel: { tag: 'polygon', attrs: 'points="8,2.5 44,2.5 49.5,8 49.5,44 44,49.5 8,49.5 2.5,44 2.5,8"' },
};

/** Hollow badge outline for a level: the shape follows `steamLevelShape`. */
export function steamLevelOutline(level: number): BadgeOutline {
  return STEAM_LEVEL_OUTLINES[steamLevelShape(level)] ?? STEAM_LEVEL_OUTLINES['circle']!;
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
