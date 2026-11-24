import type { Client, Message } from 'discord.js';
import { config } from '../config.js';
import type { BotDatabase } from '../db.js';
import { isAdminMessage, isDirectedAtBot } from './chat.js';
import { stripBotMention } from './parse.js';
import { queuePosition } from './queue.js';
import type { BuilderRunner } from './runner.js';

let warnedUnavailable = false;
/** `<job id>:<status>` pairs that already got a queued/building note. */
const notedPhases = new Set<string>();

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
      if (chat && runner.chat.available) {
        // awaiting_input: only the planner. planning: chat assistant plus planner context. queued/building: chat only.
        if (job.status !== 'awaiting_input') runner.chat.handleThreadMessage(message, chat);
        if (job.status === 'planning' || job.status === 'awaiting_input') {
          const allowed = !directed || message.author.id === job.requesterId || isAdminMessage(message);
          if (allowed) {
            const text = stripBotMention(message.content, client.user.id);
            if (text.length > 0) {
              runner.handleReply(job, message.member?.displayName ?? message.author.username, text, { sentAt: message.createdTimestamp, messageId: message.id, trigger: directed });
            }
          }
        }
        return true;
      }
      // Fallback (no chat thread or chat unavailable). Queued and building jobs are not talking to the planner: answer once per phase, no model call.
      if (job.status === 'queued' || job.status === 'building') {
        if (!directed) return true;
        const key = `${job.id}:${job.status}`;
        if (!notedPhases.has(key)) {
          notedPhases.add(key);
          const text = job.status === 'queued'
            ? `This request is queued (#${queuePosition(db.listBuildJobsByStatus(['queued']), job.id)} in line). It will start automatically.`
            : "I'm building this right now; I'll post here when the PR is ready.";
          await message.channel.send({ content: text, allowedMentions: { parse: [] } }).catch((err) => console.error('[builder] phase note failed:', err));
        }
        return true;
      }
      if (directed && message.author.id !== job.requesterId && !isAdminMessage(message)) return true;
      const text = stripBotMention(message.content, client.user.id);
      if (text.length === 0) return true;
      runner.handleReply(job, message.member?.displayName ?? message.author.username, text, { sentAt: message.createdTimestamp, messageId: message.id, trigger: directed });
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
