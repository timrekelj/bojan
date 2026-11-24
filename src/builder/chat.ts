// General chat assistant: an @mention opens a thread backed by one OpenCode session (agent `chat`).
// Every later message in the thread is forwarded to that session; the agent decides whether to reply
// and whether the conversation is a feature request that should be handed to the build runner.
import { PermissionFlagsBits, type Client, type Message, type SendableChannels } from 'discord.js';
import { config } from '../config.js';
import type { BotDatabase, ChatThread } from '../db.js';
import {
  chatThreadNameFor,
  chunkMessage,
  formatChatMessage,
  formatInitialPrompt,
  formatTranscript,
  parseChatReply,
  replaceBotMention,
  withLanguageRule,
  withNotes,
  type ChatMessageInfo,
} from './chat-parse.js';
import { OpenCodeAgent, REPO_DIR } from './opencode.js';
import { isAdminLike, parseModelRef } from './parse.js';
import { estimateCostUsd, getGoPrices, goPriceFor } from './pricing.js';
import type { BuilderRunner } from './runner.js';

const DEBOUNCE_MS = 3_000;
const CHAT_TIMEOUT_MS = 5 * 60_000;
const TYPING_MS = 8_000;
const NO_MENTIONS = { parse: [] as never[], repliedUser: false };

export function isAdminMessage(message: Message): boolean {
  const member = message.member;
  if (!member) return false;
  return isAdminLike(member.permissions.has(PermissionFlagsBits.Administrator), [...member.roles.cache.keys()], config.adminRoleId);
}

interface Pending {
  /** Formatted "<name> (<id>): text" lines. */
  text: string;
  authorId: string;
  admin: boolean;
  /** The message mentioned the bot directly. */
  directed: boolean;
}

interface ThreadState {
  busy: boolean;
  buffer: Pending[];
  timer: NodeJS.Timeout | null;
}

function displayName(message: Message): string {
  return message.member?.displayName ?? message.author.displayName ?? message.author.username;
}

/** Flatten a message (author, text, attachments, embeds) into prompt info. */
export function messageInfo(message: Message, botId: string, botName: string): ChatMessageInfo {
  const extras: string[] = [];
  for (const a of message.attachments.values()) extras.push(`[attachment] ${a.name ?? 'file'}: ${a.url}`);
  for (const e of message.embeds) {
    const bits = [e.title, e.url].filter((v): v is string => !!v);
    if (bits.length > 0) extras.push(`[embed] ${bits.join(' — ')}`);
  }
  return { name: displayName(message), id: message.author.id, text: replaceBotMention(message.content, botId, botName), extras };
}

export class ChatRunner {
  private agent: OpenCodeAgent | null = null;
  private readonly states = new Map<string, ThreadState>();
  private stopped = false;

  constructor(
    private readonly client: Client,
    private readonly db: BotDatabase,
    private readonly builder: BuilderRunner,
  ) {}

  /** The dashboard switch is on and OPENCODE_PASSWORD is set. */
  get available(): boolean {
    return config.opencodePassword !== null && this.db.getBuilderSettings().chatEnabled;
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.states.values()) if (s.timer) clearTimeout(s.timer);
  }

  private getAgent(): OpenCodeAgent {
    if (!config.opencodePassword) throw new Error('OPENCODE_PASSWORD is not set');
    this.agent ??= new OpenCodeAgent(config.opencodeUrl, config.opencodePassword);
    return this.agent;
  }

  private botName(): string {
    return this.client.user?.displayName ?? 'bojan';
  }

  /** Languages the chat assistant must reply in; read per turn so dashboard changes apply to ongoing threads. */
  private chatLanguages(): string[] {
    return this.db.getBuilderSettings().chatLanguages;
  }

  private async newSession(title: string): Promise<{ sessionId: string; modelRef: string }> {
    const modelRef = this.db.getBuilderSettings().chatModel;
    const model = parseModelRef(modelRef);
    if (!model) throw new Error(`Invalid chat model setting "${modelRef}" (expected provider/model)`);
    const agent = this.getAgent();
    await agent.warm(REPO_DIR);
    await this.refresh(agent);
    const sessionId = await agent.createSession({ directory: REPO_DIR, agent: 'chat', model, title: `bojan chat ${title}` });
    return { sessionId, modelRef };
  }

  private refreshing: Promise<void> | null = null;

  /** Fast-forward the checkout the chat agent reads; concurrent new chats share one refresh. */
  private refresh(agent: OpenCodeAgent): Promise<void> {
    this.refreshing ??= agent.refreshMain().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  // ---- discord helpers ---------------------------------------------------

  private async channelFor(threadId: string): Promise<SendableChannels | null> {
    const c = await this.client.channels.fetch(threadId).catch(() => null);
    return c && c.isSendable() ? (c as SendableChannels) : null;
  }

  private typing(threadId: string): () => void {
    let channel: SendableChannels | null = null;
    const tick = async (): Promise<void> => {
      try {
        channel ??= await this.channelFor(threadId);
        await channel?.sendTyping();
      } catch {
        // typing is cosmetic
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), TYPING_MS);
    return () => clearInterval(timer);
  }

  private async say(threadId: string, text: string): Promise<void> {
    try {
      const channel = await this.channelFor(threadId);
      if (!channel) {
        console.warn(`[chat] guild=${config.guildId} thread ${threadId} is not sendable`);
        return;
      }
      for (const chunk of chunkMessage(text)) await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error(`[chat] guild=${config.guildId} thread=${threadId} could not post:`, err);
    }
  }

  // ---- entry points ---------------------------------------------------------

  /** A direct mention outside a bot thread. In a text channel this opens a thread; inside a foreign thread it is a one-off reply. */
  async startFromMention(message: Message): Promise<void> {
    const bot = this.client.user;
    if (!bot) return;
    const trigger = messageInfo(message, bot.id, this.botName());
    let referenced: ChatMessageInfo | null = null;
    if (message.reference?.messageId) {
      const ref = await message.fetchReference().catch(() => null);
      if (ref) referenced = messageInfo(ref, bot.id, this.botName());
    }
    const channelName = 'name' in message.channel ? (message.channel.name as string | null) : null;
    // No language wrap here: the pending prompt goes through oneOff() or runTurn(), which both add the rule.
    const prompt = formatInitialPrompt({ channelName, trigger, referenced });
    const pending: Pending = { text: prompt, authorId: message.author.id, admin: isAdminMessage(message), directed: true };

    if (message.channel.isThread()) {
      void this.oneOff(message, pending);
      return;
    }
    let threadId: string;
    try {
      const thread = await message.startThread({ name: chatThreadNameFor(trigger.text.replace(`@${this.botName()}`, '')) });
      threadId = thread.id;
    } catch (err) {
      console.error(`[chat] guild=${config.guildId} could not start a thread:`, err);
      await message.reply({ content: 'I could not open a thread for that (need Create Public Threads permission).', allowedMentions: NO_MENTIONS }).catch(() => undefined);
      return;
    }
    try {
      const { sessionId, modelRef } = await this.newSession(threadId);
      this.db.createChatThread({ threadId, guildId: config.guildId, channelId: message.channelId, sessionId, startedBy: message.author.id, model: modelRef });
      console.log(`[chat] guild=${config.guildId} thread=${threadId} started by ${message.author.id} session=${sessionId} model=${modelRef}`);
    } catch (err) {
      console.error(`[chat] guild=${config.guildId} thread=${threadId} could not create a session:`, err);
      await this.say(threadId, 'Sorry, I could not start the assistant right now. Please try again later.');
      return;
    }
    this.enqueue(threadId, pending, true);
  }

  /** A non-bot message in a chat thread. */
  handleThreadMessage(message: Message, chat: ChatThread): void {
    const bot = this.client.user;
    if (!bot) return;
    const info = messageInfo(message, bot.id, this.botName());
    if (info.text.trim().length === 0 && (info.extras?.length ?? 0) === 0) return;
    this.enqueue(
      chat.threadId,
      { text: formatChatMessage(info), authorId: message.author.id, admin: isAdminMessage(message), directed: message.mentions.users.has(bot.id) && !message.mentions.everyone },
      false,
    );
  }

  // ---- per-thread queue ---------------------------------------------------------

  private enqueue(threadId: string, item: Pending, immediate: boolean): void {
    let s = this.states.get(threadId);
    if (!s) {
      s = { busy: false, buffer: [], timer: null };
      this.states.set(threadId, s);
    }
    s.buffer.push(item);
    if (s.busy || this.stopped) return;
    if (s.timer) clearTimeout(s.timer);
    const state = s;
    state.timer = setTimeout(() => void this.drain(threadId, state), immediate ? 0 : DEBOUNCE_MS);
  }

  private async drain(threadId: string, s: ThreadState): Promise<void> {
    s.timer = null;
    if (s.busy) return;
    s.busy = true;
    try {
      while (s.buffer.length > 0 && !this.stopped) {
        const batch = s.buffer.splice(0);
        // While a build job owns the thread, its messages belong to the build runner.
        const job = this.db.getBuildJobByThread(threadId);
        if (job && (job.status === 'planning' || job.status === 'awaiting_input' || job.status === 'building')) continue;
        await this.runTurn(threadId, batch);
      }
    } finally {
      s.busy = false;
    }
  }

  // ---- turns ----------------------------------------------------------------------

  private async saveUsage(chatKey: string, sessionId: string, modelRef: string | null): Promise<void> {
    try {
      const usage = await this.getAgent().usage(sessionId);
      if (usage.costUsd === 0) {
        const price = goPriceFor(modelRef, await getGoPrices());
        if (price) usage.costUsd = estimateCostUsd(usage, price);
      }
      this.db.setChatThreadUsage(chatKey, usage);
    } catch (err) {
      console.warn(`[chat] guild=${config.guildId} thread=${chatKey} could not read usage:`, err instanceof Error ? err.message : err);
    }
  }

  private async runTurn(threadId: string, batch: Pending[]): Promise<void> {
    const chat = this.db.getChatThread(threadId);
    if (!chat) return;
    const stopTyping = this.typing(threadId);
    try {
      const notes = this.db.pendingChatNotes(threadId);
      const prompt = withNotes(notes, withLanguageRule(batch.map((b) => b.text).join('\n'), this.chatLanguages()));
      const reply = await this.getAgent().promptAndWait(chat.sessionId, prompt, CHAT_TIMEOUT_MS);
      this.db.consumeChatNotes(threadId, notes.length);
      await this.saveUsage(threadId, chat.sessionId, chat.model);
      if (reply.error) throw new Error(`The agent reported an error: ${reply.error}`);
      await this.deliver(threadId, reply.text, batch);
    } catch (err) {
      console.error(`[chat] guild=${config.guildId} thread=${threadId} turn failed:`, err);
      await this.say(threadId, 'Sorry, something went wrong on my side. Please try again in a bit.');
    } finally {
      stopTyping();
    }
  }

  /** A mention inside a thread the bot does not own: fresh session, one reply, usage recorded as a one-off. */
  private async oneOff(message: Message, pending: Pending): Promise<void> {
    const threadId = message.channelId;
    const key = `${threadId}:${message.id}`;
    const stopTyping = this.typing(threadId);
    try {
      const { sessionId, modelRef } = await this.newSession(key);
      this.db.createChatThread({ threadId: key, guildId: config.guildId, channelId: message.channel.isThread() ? (message.channel.parentId ?? threadId) : threadId, sessionId, startedBy: message.author.id, model: modelRef, oneOff: true });
      const reply = await this.getAgent().promptAndWait(sessionId, withLanguageRule(pending.text, this.chatLanguages()), CHAT_TIMEOUT_MS);
      await this.saveUsage(key, sessionId, modelRef);
      if (reply.error) throw new Error(`The agent reported an error: ${reply.error}`);
      await this.deliver(threadId, reply.text, [pending]);
    } catch (err) {
      console.error(`[chat] guild=${config.guildId} thread=${threadId} one-off failed:`, err);
      await this.say(threadId, 'Sorry, something went wrong on my side. Please try again in a bit.');
    } finally {
      stopTyping();
    }
  }

  /** Post the agent's reply and act on a feature request. */
  private async deliver(threadId: string, text: string, batch: Pending[]): Promise<void> {
    const parsed = parseChatReply(text);
    if (parsed.reply) await this.say(threadId, parsed.visible);
    if (!parsed.featureRequest) return;
    // The requester is whoever mentioned the bot last in the batch (else the last author).
    const requester = [...batch].reverse().find((b) => b.directed) ?? batch[batch.length - 1]!;
    await this.handoff(threadId, requester, parsed.featureRequest);
  }

  private async handoff(threadId: string, requester: Pending, request: string): Promise<void> {
    const settings = this.db.getBuilderSettings();
    if (!requester.admin) {
      await this.say(threadId, 'Only admins can ask me to change the bot, so I can\'t start that request. An admin can ask me to plan it.');
      return;
    }
    if (!settings.enabled || !this.builder.configured) {
      await this.say(threadId, 'Building features is turned off right now, so I can\'t start that request.');
      return;
    }
    const slot = this.builder.reserve();
    if (!slot.ok) {
      await this.say(threadId, slot.active ? `I'm already working on another request. Follow it here: <#${slot.active.threadId}>` : "I'm already setting up another request. Please ask again in a minute.");
      return;
    }
    try {
      const channel = await this.client.channels.fetch(threadId).catch(() => null);
      if (!channel || !channel.isThread()) throw new Error('not a thread');
      const recent = await channel.messages.fetch({ limit: 20 });
      const entries: ChatMessageInfo[] = [...recent.values()]
        .reverse()
        .map((m) => ({ name: m.author.bot ? m.author.displayName : displayName(m), id: m.author.id, text: m.content }))
        .filter((e) => e.text.trim().length > 0);
      const requesterName = [...recent.values()].find((m) => m.author.id === requester.authorId);
      this.builder.startJob({
        threadId,
        channelId: channel.parentId ?? threadId,
        requesterId: requester.authorId,
        requesterName: requesterName ? displayName(requesterName) : requester.authorId,
        request,
        context: formatTranscript(entries),
      });
    } catch (err) {
      this.builder.release();
      console.error(`[chat] guild=${config.guildId} thread=${threadId} could not hand off to the builder:`, err);
      await this.say(threadId, 'Sorry, I could not start that request.');
    }
  }
}
