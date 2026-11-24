import { PermissionFlagsBits, type Client, type Message } from 'discord.js';
import { config } from '../config.js';
import type { BotDatabase } from '../db.js';
import { isAdminLike, stripBotMention, threadNameFor } from './parse.js';
import type { BuilderRunner } from './runner.js';

function isAdminMessage(message: Message): boolean {
  const member = message.member;
  if (!member) return false;
  return isAdminLike(member.permissions.has(PermissionFlagsBits.Administrator), [...member.roles.cache.keys()], config.adminRoleId);
}

let warnedUnavailable = false;

/**
 * Entry point for every guild message (non-bot). Handles @mention requests and replies inside
 * build threads. Returns true when the message was consumed by the builder.
 */
export async function handleBuilderMessage(message: Message, client: Client, db: BotDatabase, runner: BuilderRunner): Promise<boolean> {
  if (message.guildId !== config.guildId || !client.user) return false;

  // Replies inside a build thread.
  if (message.channel.isThread()) {
    const job = db.getBuildJobByThread(message.channelId);
    if (!job) return false;
    if (job.status !== 'planning' && job.status !== 'awaiting_input') return true;
    if (message.author.id !== job.requesterId && !isAdminMessage(message)) return true;
    const text = stripBotMention(message.content, client.user.id);
    if (text.length === 0) return true;
    runner.handleReply(job, message.member?.displayName ?? message.author.username, text);
    return true;
  }

  // New request: a direct @mention of the bot (not @everyone / role mentions).
  if (!message.mentions.users.has(client.user.id) || message.mentions.everyone) return false;
  if (!runner.configured || !db.getBuilderSettings().enabled) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.log('[builder] mention ignored: self-building is disabled or OPENCODE_PASSWORD is not set');
    }
    return false;
  }
  if (!isAdminMessage(message)) {
    await message.reply({ content: 'Only admins can ask me to build features.', allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined);
    return true;
  }
  const request = stripBotMention(message.content, client.user.id);
  if (request.length === 0) {
    await message
      .reply({ content: 'Tell me what to build, e.g. `@me add a /ping command`. I\'ll open a thread to plan it with you.', allowedMentions: { parse: [], repliedUser: false } })
      .catch(() => undefined);
    return true;
  }

  const slot = runner.reserve();
  if (!slot.ok) {
    const where = slot.active ? ` Follow it here: <#${slot.active.threadId}>` : '';
    await message
      .reply({ content: `I'm already working on another request.${where}`, allowedMentions: { parse: [], repliedUser: false } })
      .catch(() => undefined);
    return true;
  }
  try {
    const thread = await message.startThread({ name: threadNameFor(request) });
    runner.startJob({
      threadId: thread.id,
      channelId: message.channelId,
      requesterId: message.author.id,
      requesterName: message.member?.displayName ?? message.author.username,
      request,
    });
  } catch (err) {
    runner.release();
    console.error(`[builder] guild=${config.guildId} could not start a request thread:`, err);
    await message.reply({ content: 'I could not open a thread for that (need Create Public Threads permission).', allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined);
  }
  return true;
}
