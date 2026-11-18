import { ChannelType, Webhook, type Message, type TextChannel } from 'discord.js';
import type { BotDatabase } from '../db.js';
import { extractUrl, detectProvider, transformUrl } from './providers.js';

const WEBHOOK_NAME = 'embed-converter';
const webhookCache = new Map<string, Webhook>();

async function getWebhook(channel: TextChannel, bypassCache = false): Promise<Webhook | null> {
  if (!bypassCache) {
    const cached = webhookCache.get(channel.id);
    if (cached) return cached;
  }
  try {
    const hooks = await channel.fetchWebhooks();
    let hook = hooks.find((h) => h.name === WEBHOOK_NAME);
    if (!hook) hook = await channel.createWebhook({ name: WEBHOOK_NAME });
    // Only webhooks with a token can be used to send messages.
    if (!hook.token) return null;
    webhookCache.set(channel.id, hook);
    return hook;
  } catch {
    return null;
  }
}

/**
 * embeddo-style conversion: if the message is in a configured channel and
 * contains a supported social link, repost it via webhook with the link
 * rewritten to an embed-friendly mirror (fxtwitter/kkinstagram/kktiktok/
 * vxreddit) — Discord then generates a rich embed (including playable video)
 * from the mirror — and remove the original so nothing doubles up.
 */
export async function maybeConvert(message: Message, db: BotDatabase, embedChannels: string[]): Promise<void> {
  try {
    if (!message.guildId || message.webhookId || message.author.bot) return;
    if (!embedChannels.includes(message.channelId)) return;
    const url = extractUrl(message.content);
    if (!url) return;
    const provider = detectProvider(url);
    if (!provider) return; // not a mirrorable platform; Discord's native embed is fine
    const mirror = transformUrl(url);
    if (!mirror) return;

    const channel = message.channel;
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return;

    const webhook = await getWebhook(channel as TextChannel);
    if (!webhook) {
      console.warn(`[embeds] could not get/create a webhook in #${(channel as TextChannel).name} — the bot needs the Manage Webhooks permission there`);
      return;
    }

    const displayName = message.member?.displayName ?? message.author.username;
    const payload = {
      content: message.content.split(url).join(mirror).slice(0, 2000),
      username: displayName.slice(0, 80),
      avatarURL: message.author.displayAvatarURL({ size: 256 }),
    };

    let sent;
    try {
      sent = await webhook.send(payload);
    } catch (err) {
      // Cached webhook may be stale/deleted — refetch once and retry.
      const fresh = await getWebhook(channel as TextChannel, true);
      if (!fresh || !fresh.token) {
        console.warn(`[embeds] webhook send failed in #${(channel as TextChannel).name}:`, err);
        return;
      }
      sent = await fresh.send(payload);
    }

    // Remove the original so its native embed doesn't double up with ours.
    const deleted = await message.delete().then(() => true).catch(() => false);
    if (!deleted) {
      const suppressed = await message.suppressEmbeds(true).then(() => true).catch(() => false);
      if (!suppressed) {
        // Can't remove the original at all — undo the repost to avoid duplicates.
        await sent.delete().catch(() => undefined);
        console.warn(`[embeds] cannot delete or suppress the original message in #${(channel as TextChannel).name} (needs Manage Messages) — skipped ${url}`);
        return;
      }
    }

    db.logEmbed({
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      url: mirror,
      provider: provider.name,
      ts: Date.now(),
    });
    console.log(`[embeds] converted ${provider.name} link in #${(channel as TextChannel).name}: ${url} -> ${mirror}`);
  } catch {
    // Conversion is best-effort; never let it break message handling.
  }
}
