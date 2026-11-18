import { ChannelType, EmbedBuilder, Webhook, type Message, type TextChannel } from 'discord.js';
import type { BotDatabase } from '../db.js';
import { extractUrl, detectProvider, fetchEmbedMeta } from './providers.js';

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

function toEmbed(meta: Awaited<ReturnType<typeof fetchEmbedMeta>>): EmbedBuilder | null {
  if (!meta || (!meta.title && !meta.description && !meta.image && !meta.video)) return null;
  const embed = new EmbedBuilder().setURL(meta.url);
  if (meta.color !== undefined) embed.setColor(meta.color);
  if (meta.title) embed.setTitle(meta.title.slice(0, 256));
  if (meta.description) embed.setDescription(meta.description.slice(0, 1000));
  if (meta.author) embed.setAuthor({ name: meta.author.slice(0, 256) });
  if (meta.siteName) embed.setFooter({ text: meta.siteName.slice(0, 2048) });
  if (meta.image) embed.setImage(meta.image);
  // EmbedBuilder has no setVideo; set the raw embed field (plays direct media URLs).
  if (meta.video && /^https?:\/\//.test(meta.video)) embed.data.video = { url: meta.video };
  return embed;
}

/**
 * embeddo-style conversion: if the message is in a configured channel and
 * contains a social link, repost it via webhook with a rich embed and remove
 * the original so Discord's plain link preview doesn't double up.
 */
export async function maybeConvert(message: Message, db: BotDatabase, embedChannels: string[]): Promise<void> {
  try {
    if (!message.guildId || message.webhookId || message.author.bot) return;
    if (!embedChannels.includes(message.channelId)) return;
    if (message.embeds.length > 0) return; // Discord already made a rich embed
    const url = extractUrl(message.content);
    if (!url) return;
    const provider = detectProvider(url);
    if (!provider) return; // only known social platforms

    const meta = await fetchEmbedMeta(url);
    if (!meta) {
      console.warn(`[embeds] no metadata for ${url} (provider page unreachable/blocked)`);
      return;
    }
    const embed = toEmbed(meta);
    if (!embed) return;

    const channel = message.channel;
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return;

    const displayName = message.member?.displayName ?? message.author.username;
    const payload = {
      content: message.content,
      embeds: [embed],
      username: displayName.slice(0, 80),
      avatarURL: message.author.displayAvatarURL({ size: 256 }),
    };

    let webhook = await getWebhook(channel as TextChannel);
    if (!webhook) {
      console.warn(`[embeds] could not get/create a webhook in #${(channel as TextChannel).name} — the bot needs the Manage Webhooks permission there`);
      return;
    }
    try {
      await webhook.send(payload);
    } catch (err) {
      // Cached webhook may be stale/deleted — refetch once and retry.
      webhook = await getWebhook(channel as TextChannel, true);
      if (!webhook || !webhook.token) {
        console.warn(`[embeds] webhook resend failed in #${(channel as TextChannel).name}:`, err);
        return;
      }
      await webhook.send(payload);
    }

    await message.delete().catch((err) => {
      console.warn(`[embeds] could not delete original message ${message.id} — needs Manage Messages in that channel:`, err);
    });
    db.logEmbed({
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      url,
      provider: provider.name,
      ts: Date.now(),
    });
    console.log(`[embeds] converted ${provider.name} link in #${(channel as TextChannel).name}: ${url}`);
  } catch {
    // Conversion is best-effort; never let it break message handling.
  }
}
