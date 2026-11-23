import type { Client, SendableChannels } from 'discord.js';
import type { BotDatabase } from '../db.js';
import { buildFreeGameMessage } from './cards.js';
import { filterGames } from './filters.js';
import type { FreeGame, FreeSettings } from './types.js';

/** Identity by platform, store and title: the same game delivered twice (new id) shares this key. */
export function titleDedupeKey(g: FreeGame): string {
  return `t:${g.platform}:${g.store}:${g.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}`;
}

/** Both identities under which a game is recorded as posted. */
export const postedKeys = (g: FreeGame): string[] => [g.key, titleDedupeKey(g)];

export function isGamePosted(db: BotDatabase, guildId: string, g: FreeGame): boolean {
  return postedKeys(g).some((k) => db.isFreePosted(guildId, k));
}

/** Silently record games as posted (by source key and title key); returns how many games were newly recorded. */
export function markGamesPosted(db: BotDatabase, guildId: string, games: FreeGame[]): number {
  let n = 0;
  for (const g of games) if (db.markFreePosted(guildId, postedKeys(g)) > 0) n++;
  return n;
}

/**
 * Announce games in one guild: apply its filters, skip already-posted ones
 * (by key or title), send, then mark. Throws nothing; failures are logged per
 * item. Returns the number announced.
 */
export async function announceInGuild(client: Client, db: BotDatabase, guildId: string, settings: FreeSettings, games: FreeGame[]): Promise<number> {
  if (!settings.channelId) return 0;
  const fresh: FreeGame[] = [];
  for (const g of filterGames(games, settings)) {
    // also dedupe within the batch (copies are only marked after sending)
    if (isGamePosted(db, guildId, g)) continue;
    if (fresh.some((f) => titleDedupeKey(f) === titleDedupeKey(g))) continue;
    fresh.push(g);
  }
  if (fresh.length === 0) return 0;
  try {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
    const channel = await guild.channels.fetch(settings.channelId).catch(() => null);
    if (!channel || !channel.isSendable()) {
      console.error(`[freegames] channel ${settings.channelId} unavailable in guild ${guildId}`);
      return 0;
    }
    let sent = 0;
    for (const game of fresh) {
      try {
        await (channel as SendableChannels).send(buildFreeGameMessage(game, { pingRoleId: settings.pingRoleId }));
        db.markFreePosted(guildId, postedKeys(game));
        sent++;
        console.log(`[freegames] announced "${game.title}" (${game.key}) in guild ${guildId}`);
      } catch (err) {
        console.error(`[freegames] failed to announce ${game.key} in guild ${guildId}:`, err);
      }
    }
    return sent;
  } catch (err) {
    console.error(`[freegames] guild ${guildId} failed:`, err);
    return 0;
  }
}

/** Announce games (e.g. from the FreeStuff webhook) in every guild that has a free-games channel set. */
export async function announceEverywhere(client: Client, db: BotDatabase, games: FreeGame[]): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      const settings = db.getFreeSettings(guild.id);
      if (!settings.channelId) continue;
      await announceInGuild(client, db, guild.id, settings, games);
    } catch (err) {
      console.error(`[freegames] guild ${guild.id} failed:`, err);
    }
  }
}
