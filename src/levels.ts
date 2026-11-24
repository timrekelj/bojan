import { ContainerBuilder, MessageFlags, TextDisplayBuilder } from 'discord.js';
import type { BotDatabase } from './db.js';
import { fmt } from './stats.js';
import { BLURPLE } from './weekly.js';

/** XP awarded per eligible message: a random 5–10. */
export const XP_MIN = 5;
export const XP_MAX = 10;
/** Per-user cooldown between XP awards. */
export const XP_COOLDOWN_MS = 30_000;

const NO_MENTIONS = { parse: [] as never[] };

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

export interface XpAwardResult {
  /** XP gained from this message (5–10). */
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
