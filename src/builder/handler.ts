import type { Client, Message } from 'discord.js';
import { config } from '../config.js';
import type { BotDatabase } from '../db.js';
import { isAdminMessage } from './chat.js';
import { stripBotMention } from './parse.js';
import type { BuilderRunner } from './runner.js';

let warnedUnavailable = false;

/**
 * Entry point for every guild message (non-bot). Routes replies in build threads to the build runner,
 * messages in chat threads to the chat assistant, and direct @mentions elsewhere to a new chat.
 * Returns true when the message was consumed.
 */
export async function handleBuilderMessage(message: Message, client: Client, db: BotDatabase, runner: BuilderRunner): Promise<boolean> {
  if (message.guildId !== config.guildId || !client.user) return false;

  if (message.channel.isThread()) {
    // A job in planning / awaiting_input / queued / building owns the thread.
    const job = db.getBuildJobByThread(message.channelId);
    if (job && (job.status === 'planning' || job.status === 'awaiting_input' || job.status === 'queued' || job.status === 'building')) {
      // Queued and building jobs are not talking to the planner: ignore thread messages.
      if (job.status === 'queued' || job.status === 'building') return true;
      if (message.author.id !== job.requesterId && !isAdminMessage(message)) return true;
      const text = stripBotMention(message.content, client.user.id);
      if (text.length === 0) return true;
      runner.handleReply(job, message.member?.displayName ?? message.author.username, text);
      return true;
    }
    // Otherwise the thread is back in (or already in) chat mode.
    const chat = db.getChatThread(message.channelId);
    if (chat) {
      if (runner.chat.available) runner.chat.handleThreadMessage(message, chat);
      return true;
    }
    if (job) return true; // an old build thread that never had a chat
  }

  // A direct @mention of the bot (not @everyone / role mentions) starts a chat.
  if (!message.mentions.users.has(client.user.id) || message.mentions.everyone) return false;
  if (!runner.chat.available) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.log('[chat] mention ignored: the AI assistant is disabled or OPENCODE_PASSWORD is not set');
    }
    return false;
  }
  await runner.chat.startFromMention(message);
  return true;
}
