// General chat assistant: an @mention opens a thread backed by one OpenCode session (agent `chat`).
// Every later message in the thread is first checked by a decision model (feature request or not): a
// feature request goes straight to the build runner, anything else is forwarded to the chat session.
import { PermissionFlagsBits, type Client, type Message, type SendableChannels } from 'discord.js';
import { config } from '../config.js';
import { ACTIVE_BUILD_STATUSES, type BotDatabase, type ChatThread } from '../db.js';
import {
  chatThreadNameFor,
  chunkMessage,
  FEATURE_REQUEST_QUESTION,
  formatChatMessage,
  formatDecisionInput,
  formatInitialPrompt,
  formatTranscript,
  isFeatureRequest,
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
const DECISION_TIMEOUT_MS = 15_000;
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
        if (job && ACTIVE_BUILD_STATUSES.includes(job.status)) continue;
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
      // Feature requests never reach the chat agent; pending build notes stay for the next chat turn.
      if (await this.detectFeatureRequest(threadId, batch)) {
        await this.startFeatureRequest(threadId, batch);
        return;
      }
      const notes = this.db.pendingChatNotes(threadId);
      const prompt = withNotes(notes, withLanguageRule(batch.map((b) => b.text).join('\n'), this.chatLanguages()));
      const parsed = await this.askChat(threadId, chat.sessionId, chat.model, prompt, () => this.db.consumeChatNotes(threadId, notes.length));
      if (parsed.reply) await this.say(threadId, parsed.visible);
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
      if (await this.detectFeatureRequest(threadId, [pending])) {
        await this.startFeatureRequest(threadId, [pending]);
        return;
      }
      const parsed = await this.askChat(key, sessionId, modelRef, withLanguageRule(pending.text, this.chatLanguages()));
      if (parsed.reply) await this.say(threadId, parsed.visible);
    } catch (err) {
      console.error(`[chat] guild=${config.guildId} thread=${threadId} one-off failed:`, err);
      await this.say(threadId, 'Sorry, something went wrong on my side. Please try again in a bit.');
    } finally {
      stopTyping();
    }
  }

  /**
   * Prompt the chat agent and parse its `{reply}` block. A reply without a valid block is never
   * posted: the same session is asked once more, and if that still has no block nothing is posted.
   */
  private async askChat(chatKey: string, sessionId: string, modelRef: string | null, prompt: string, afterFirst?: () => void): Promise<ReturnType<typeof parseChatReply>> {
    const agent = this.getAgent();
    let reply = await agent.promptAndWait(sessionId, prompt, CHAT_TIMEOUT_MS);
    afterFirst?.();
    await this.saveUsage(chatKey, sessionId, modelRef);
    if (reply.error) throw new Error(`The agent reported an error: ${reply.error}`);
    let parsed = parseChatReply(reply.text);
    if (parsed.missingBlock) {
      console.warn(`[chat] guild=${config.guildId} thread=${chatKey} reply had no json block, asking again`);
      reply = await agent.promptAndWait(sessionId, 'Reply now with only your message to the thread, followed by the json block.', CHAT_TIMEOUT_MS);
      await this.saveUsage(chatKey, sessionId, modelRef);
      if (reply.error) throw new Error(`The agent reported an error: ${reply.error}`);
      parsed = parseChatReply(reply.text);
      if (parsed.missingBlock) console.warn(`[chat] guild=${config.guildId} thread=${chatKey} still no json block, posting nothing`);
    }
    return parsed;
  }

  /** The requester is whoever mentioned the bot last in the batch (else the last author). */
  private requesterOf(batch: Pending[]): Pending {
    return [...batch].reverse().find((b) => b.directed) ?? batch[batch.length - 1]!;
  }

  /** Ask the decision model whether the latest message is a feature request; any failure means "no". */
  private async detectFeatureRequest(threadId: string, batch: Pending[]): Promise<boolean> {
    try {
      const modelRef = this.db.getBuilderSettings().chatDecisionModel;
      const model = parseModelRef(modelRef);
      if (!model) throw new Error(`Invalid decision model setting "${modelRef}"`);
      const channel = await this.client.channels.fetch(threadId).catch(() => null);
      let entries: ChatMessageInfo[] = [];
      if (channel && channel.isThread()) {
        const recent = await channel.messages.fetch({ limit: 11 });
        entries = [...recent.values()]
          .reverse()
          .map((m) => ({ name: m.author.bot ? m.author.displayName : displayName(m), id: m.author.id, text: m.content }))
          .filter((e) => e.text.trim().length > 0);
        // The batch itself is in the history; it is passed separately as the latest message.
        entries = entries.length > batch.length ? entries.slice(0, entries.length - batch.length) : [];
      }
      const latest = batch.map((b) => b.text).join('\n');
      const probability = await this.getAgent().decide(model, formatDecisionInput(entries, latest), FEATURE_REQUEST_QUESTION, DECISION_TIMEOUT_MS);
      const yes = isFeatureRequest(probability);
      console.log(`[chat] guild=${config.guildId} thread=${threadId} decision feature_request=${probability ?? 'none'} -> ${yes}`);
      return yes;
    } catch (err) {
      console.warn(`[chat] guild=${config.guildId} thread=${threadId} decision failed:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** A detected feature request: fixed acknowledgement + build job (admins) or fixed refusal (others). */
  private async startFeatureRequest(threadId: string, batch: Pending[]): Promise<void> {
    const requester = this.requesterOf(batch);
    const request = (requester.directed ? requester.text : batch.map((b) => b.text).join('\n')).trim();
    await this.handoff(threadId, requester, request, {
      ack: "Got it, I'll make a plan for this.",
      notAdmin: 'That sounds like a change to the bot. Only admins can start one, so ask an admin to request it.',
    });
  }

  private async handoff(threadId: string, requester: Pending, request: string, msgs: { ack?: string; notAdmin?: string } = {}): Promise<void> {
    const settings = this.db.getBuilderSettings();
    if (!requester.admin) {
      await this.say(threadId, msgs.notAdmin ?? 'Only admins can ask me to change the bot, so I can\'t start that request. An admin can ask me to plan it.');
      return;
    }
    if (!settings.enabled || !this.builder.configured) {
      await this.say(threadId, 'Building features is turned off right now, so I can\'t start that request.');
      return;
    }
    const slot = this.builder.reserve(threadId);
    if (!slot.ok) {
      await this.say(threadId, slot.active ? "There's already a feature request in progress in this thread." : "I'm already setting up a request in this thread. Please ask again in a minute.");
      return;
    }
    try {
      const channel = await this.client.channels.fetch(threadId).catch(() => null);
      if (!channel || !channel.isThread()) throw new Error('not a thread');
      if (msgs.ack) await this.say(threadId, msgs.ack);
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
      this.builder.release(threadId);
      console.error(`[chat] guild=${config.guildId} thread=${threadId} could not hand off to the builder:`, err);
      await this.say(threadId, 'Sorry, I could not start that request.');
    }
  }
}
