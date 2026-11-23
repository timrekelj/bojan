import type { Client, SendableChannels } from 'discord.js';
import type { BotDatabase } from '../db.js';
import { announceable, seedFreeGames, seedStateKey } from './actions.js';
import { buildFreeGameMessage } from './cards.js';
import { filterGames, getFreeGames } from './sources.js';

const POLL_MS = 15 * 60_000;
const FIRST_POLL_DELAY_MS = 20_000;

let running = false;

export async function pollFreeGames(client: Client, db: BotDatabase): Promise<void> {
  if (running) return;
  running = true;
  try {
    const guilds = [...client.guilds.cache.values()].filter((g) => db.getFreeSettings(g.id).channelId);
    if (guilds.length === 0) return;
    const data = await getFreeGames({ force: true });
    if (!data.epicOk && !data.gamerpowerOk) {
      console.error('[freegames] both sources failed, skipping poll');
      return;
    }
    const games = announceable(data);

    for (const guild of guilds) {
      try {
        const settings = db.getFreeSettings(guild.id);
        if (!settings.channelId) continue;

        if (!db.getState(seedStateKey(guild.id))) {
          // First poll for this guild: record the backlog silently.
          const matching = filterGames(games, settings);
          db.markFreePosted(guild.id, matching.map((g) => g.key));
          if (data.epicOk && data.gamerpowerOk) db.setState(seedStateKey(guild.id), String(Date.now()));
          console.log(`[freegames] first poll for guild ${guild.id}: seeded ${matching.length} without announcing`);
          continue;
        }

        const fresh = filterGames(games, settings).filter((g) => !db.isFreePosted(guild.id, g.key));
        if (fresh.length === 0) continue;
        const channel = await guild.channels.fetch(settings.channelId).catch(() => null);
        if (!channel || !channel.isSendable()) {
          console.error(`[freegames] channel ${settings.channelId} unavailable in guild ${guild.id}`);
          continue;
        }
        for (const game of fresh) {
          try {
            await (channel as SendableChannels).send(buildFreeGameMessage(game, { pingRoleId: settings.pingRoleId }));
            db.markFreePosted(guild.id, [game.key]);
            console.log(`[freegames] announced "${game.title}" (${game.key}) in guild ${guild.id}`);
          } catch (err) {
            console.error(`[freegames] failed to announce ${game.key} in guild ${guild.id}:`, err);
          }
        }
      } catch (err) {
        console.error(`[freegames] guild ${guild.id} failed:`, err);
      }
    }
  } catch (err) {
    console.error('[freegames] poll failed:', err);
  } finally {
    running = false;
  }
}

/** Poll every 15 minutes, plus once shortly after the client is ready. */
export function startFreeGamesPoller(client: Client, db: BotDatabase): NodeJS.Timeout {
  const first = (): void => {
    setTimeout(() => void pollFreeGames(client, db), FIRST_POLL_DELAY_MS);
  };
  if (client.isReady()) first();
  else client.once('ready', first);
  return setInterval(() => void pollFreeGames(client, db), POLL_MS);
}
