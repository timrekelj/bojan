import type { Client, SendableChannels } from 'discord.js';
import type { BotDatabase } from '../db.js';
import { buildFreeGameMessage } from './cards.js';
import { filterGames, getFreeGames, type FreeData } from './sources.js';
import type { FreeGame } from './types.js';

export const seedStateKey = (guildId: string): string => `freeseed:${guildId}`;

/** Games to consider for announcing. Epic copies from GamerPower are held back while the Epic endpoint is down (avoids double posts). */
export function announceable(data: FreeData): FreeGame[] {
  return data.current.filter((g) => data.epicOk || !(g.source === 'gamerpower' && g.store === 'epic' && g.kind === 'game' && g.platform === 'pc'));
}

/**
 * Mark every currently-free game matching the guild's filters as already
 * posted, WITHOUT announcing it. Call when the channel is first set/changed so
 * enabling the feature doesn't spam the backlog. The "seeded" flag is only set
 * when both sources answered; otherwise the poller seeds again silently later.
 */
export async function seedFreeGames(db: BotDatabase, guildId: string): Promise<{ marked: number; complete: boolean }> {
  const data = await getFreeGames({ force: true });
  const matching = filterGames(announceable(data), db.getFreeSettings(guildId));
  const marked = db.markFreePosted(guildId, matching.map((g) => g.key));
  const complete = data.epicOk && data.gamerpowerOk;
  if (complete) db.setState(seedStateKey(guildId), String(Date.now()));
  console.log(`[freegames] seeded guild ${guildId}: ${marked} marked as posted${complete ? '' : ' (partial: a source failed)'}`);
  return { marked, complete };
}

export type TestResult = { ok: true; title: string; channelId: string } | { ok: false; error: string };

/** Post a card for one currently-free matching game to the configured channel, without recording it. */
export async function sendTestAnnouncement(client: Client, db: BotDatabase, guildId: string): Promise<TestResult> {
  const settings = db.getFreeSettings(guildId);
  if (!settings.channelId) return { ok: false, error: 'No free-games channel is configured.' };
  const data = await getFreeGames();
  const game = filterGames(data.current, settings)[0];
  if (!game) return { ok: false, error: 'No currently-free game matches the filters, so there is nothing to post.' };
  try {
    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(settings.channelId);
    if (!channel || !channel.isSendable()) return { ok: false, error: 'The configured channel is missing or not a text channel.' };
    await (channel as SendableChannels).send(buildFreeGameMessage(game, { pingRoleId: settings.pingRoleId }));
    return { ok: true, title: game.title, channelId: settings.channelId };
  } catch (err) {
    console.error(`[freegames] test announcement failed for guild ${guildId}:`, err);
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to send the test message.' };
  }
}
