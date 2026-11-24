import type { Client, Message } from 'discord.js';
import { config } from '../config.js';
import type { BotDatabase } from '../db.js';
import { isAdminMessage, isDirectedAtBot } from './chat.js';
import { downloadImages } from './images.js';
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
      const chat = db.getChatThread(message.channelId);
      // Only a mention or a reply to the bot gets an answer or drives the planner; everything else is context.
      const directed = isDirectedAtBot(message, client.user.id);
      const chatOn = !!chat && runner.chat.available;
      // awaiting_input: only the planner. planning: chat assistant plus planner context. queued/building: chat only.
      if (chatOn && job.status !== 'awaiting_input') runner.chat.handleThreadMessage(message, chat);
      if (job.status === 'planning' || job.status === 'awaiting_input') {
        // Without chat (dashboard switch off) only directed messages reach the planner; everything else is ignored.
        const allowed = chatOn ? !directed || message.author.id === job.requesterId || isAdminMessage(message)
          : directed && (message.author.id === job.requesterId || isAdminMessage(message));
        if (allowed) {
          const text = stripBotMention(message.content, client.user.id);
          // Only directed (triggering) replies carry images; context-only messages stay text.
          const images = directed && message.attachments.size > 0 ? await downloadImages([message], 'builder') : [];
          if (text.length > 0 || images.length > 0) {
            runner.handleReply(job, message.member?.displayName ?? message.author.username, text, { sentAt: message.createdTimestamp, messageId: message.id, trigger: directed, images });
          }
        }
      }
      return true;
    }
    // Otherwise the thread is back in (or already in) chat mode.
    const chat = db.getChatThread(message.channelId);
    if (chat) {
      if (runner.chat.available) runner.chat.handleThreadMessage(message, chat);
      return true;
    }
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
