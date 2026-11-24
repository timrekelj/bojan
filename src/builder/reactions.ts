// Emoji reactions used as status markers on Discord messages. All helpers swallow errors (cosmetic).
import type { Client, GuildEmoji } from 'discord.js';
import { config } from '../config.js';

export const PLANNING = '📝';
export const BUILDING = '🔨';
export const DONE = '✅';
export const FAILED = '❌';

const THINKING_NAME = 'hmmmm';
const THINKING_FALLBACK = '🤔';

let thinkingCache: string | null = null;

/** The guild's custom `hmmmm` emoji (cached after the first lookup), else 🤔. */
export async function thinkingEmoji(client: Client): Promise<string> {
  if (thinkingCache) return thinkingCache;
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (guild) {
      let found: GuildEmoji | undefined = guild.emojis.cache.find((e) => e.name === THINKING_NAME);
      if (!found) {
        const all = await guild.emojis.fetch();
        found = all.find((e) => e.name === THINKING_NAME);
      }
      thinkingCache = found ? found.toString() : THINKING_FALLBACK;
      return thinkingCache;
    }
  } catch (err) {
    console.warn('[reactions] could not look up the thinking emoji:', err instanceof Error ? err.message : err);
  }
  return THINKING_FALLBACK;
}

async function messageFor(client: Client, channelId: string, messageId: string, force = false) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) return null;
  return channel.messages.fetch({ message: messageId, force });
}

/** Add a reaction; errors are logged and swallowed. */
export async function addReaction(client: Client, channelId: string, messageId: string, emoji: string, tag = 'reactions'): Promise<void> {
  try {
    const message = await messageFor(client, channelId, messageId);
    await message?.react(emoji);
  } catch (err) {
    console.warn(`[${tag}] could not add reaction ${emoji} to ${messageId}:`, err instanceof Error ? err.message : err);
  }
}

/** Remove the bot's own reaction; errors are logged and swallowed. */
export async function removeOwnReaction(client: Client, channelId: string, messageId: string, emoji: string, tag = 'reactions'): Promise<void> {
  try {
    const botId = client.user?.id;
    if (!botId) return;
    const message = await messageFor(client, channelId, messageId, true);
    const reaction = message?.reactions.cache.find((r) => r.emoji.toString() === emoji);
    await reaction?.users.remove(botId);
  } catch (err) {
    console.warn(`[${tag}] could not remove reaction ${emoji} from ${messageId}:`, err instanceof Error ? err.message : err);
  }
}
