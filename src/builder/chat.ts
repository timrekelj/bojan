// General chat assistant: an @mention opens a thread backed by one OpenCode session (agent `chat`).
// A directed (@mention) message from an admin, while building is enabled, is first checked by a decision
// model (feature request or not): a feature request goes to the build runner, anything else to the chat session.
import { PermissionFlagsBits, type Client, type Message, type SendableChannels } from 'discord.js';
import { config } from '../config.js';
import { ACTIVE_BUILD_STATUSES, type BotDatabase, type ChatThread } from '../db.js';
import {
  chatThreadNameFor,
  chunkMessage,
  featureRequestText,
  FEATURE_REQUEST_QUESTION,
  formatChatMessage,
  formatDecisionInput,
  formatInitialPrompt,
  formatJobStatus,
  formatTranscript,
  isFeatureRequest,
  parseChatReply,
  pickReplyTarget,
  replaceBotMention,
  shouldRunDecision,
  withLanguageRule,
  withNotes,
  type ChatMessageInfo,
} from './chat-parse.js';
import { OpenCodeAgent, REPO_DIR } from './opencode.js';
import { isAdminLike, parseModelRef } from './parse.js';
import { estimateCostUsd, getGoPrices, goPriceFor } from './pricing.js';
import { queuePosition } from './queue.js';
import { addReaction, removeOwnReaction, thinkingEmoji } from './reactions.js';
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
  /** Prompt text for the chat agent ("<name> (<id>): text" lines or the initial-mention wrapper). */
  text: string;
  /** What the author wrote, bot mention replaced; no prefix or wrapper. */
  plain: string;
  /** Plain text of the message this one replies to. */
  replyTo?: { name: string; text: string };
  authorId: string;
  admin: boolean;
  /** The message mentions the bot or replies to one of its messages. */
  directed: boolean;
  messageId: string;
  /** Channel the message was sent in (the parent channel for the message that opens a thread). */
  channelId: string;
}

/** A direct @mention of the bot (not @everyone) or a Discord reply to a message the bot wrote. */
export function isDirectedAtBot(message: Message, botId: string): boolean {
  if (message.mentions.everyone) return message.mentions.repliedUser?.id === botId;
  return message.mentions.users.has(botId) || message.mentions.repliedUser?.id === botId;
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
    for (const s of this.states.values()) {
      if (s.timer) clearTimeout(s.timer);
      // Messages that will never be processed must not keep a thinking reaction.
      void this.clearThinking(s.buffer.splice(0));
    }
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

  /** React with the thinking emoji on a directed message while it waits for / gets an answer. */
  private async markThinking(item: Pending): Promise<void> {
    await addReaction(this.client, item.channelId, item.messageId, await thinkingEmoji(this.client), 'chat');
  }

  /** Remove the thinking reaction from every directed message of a finished (or dropped) batch. */
  private async clearThinking(batch: readonly Pending[]): Promise<void> {
    const emoji = await thinkingEmoji(this.client);
    await Promise.all(batch.filter((b) => b.directed).map((b) => removeOwnReaction(this.client, b.channelId, b.messageId, emoji, 'chat')));
  }

  /** Message the reply to this batch attaches to (only messages in the thread itself can be referenced). */
  private replyTarget(threadId: string, batch: readonly Pending[]): string | null {
    return pickReplyTarget(batch.filter((b) => b.channelId === threadId));
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

  /** Send text to the thread; the first chunk replies to `replyTo` (when given), the rest are plain sends. */
  private async say(threadId: string, text: string, replyTo: string | null = null): Promise<void> {
    try {
      const channel = await this.channelFor(threadId);
      if (!channel) {
        console.warn(`[chat] guild=${config.guildId} thread ${threadId} is not sendable`);
        return;
      }
      let first = true;
      for (const chunk of chunkMessage(text)) {
        if (first && replyTo) {
          await channel.send({ content: chunk, reply: { messageReference: replyTo, failIfNotExists: false }, allowedMentions: NO_MENTIONS });
        } else {
          await channel.send({ content: chunk, allowedMentions: { parse: [] } });
        }
        first = false;
      }
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
    const pending: Pending = {
      text: prompt,
      plain: trigger.text,
      replyTo: referenced ? { name: referenced.name, text: referenced.text } : undefined,
      authorId: message.author.id,
      admin: isAdminMessage(message),
      directed: true,
      messageId: message.id,
      channelId: message.channelId,
    };
    void this.markThinking(pending);

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
      await this.clearThinking([pending]);
      return;
    }
    try {
      const { sessionId, modelRef } = await this.newSession(threadId);
      this.db.createChatThread({ threadId, guildId: config.guildId, channelId: message.channelId, sessionId, startedBy: message.author.id, model: modelRef });
      console.log(`[chat] guild=${config.guildId} thread=${threadId} started by ${message.author.id} session=${sessionId} model=${modelRef}`);
    } catch (err) {
      console.error(`[chat] guild=${config.guildId} thread=${threadId} could not create a session:`, err);
      await this.say(threadId, 'Sorry, I could not start the assistant right now. Please try again later.');
      await this.clearThinking([pending]);
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
    const directed = isDirectedAtBot(message, bot.id);
    // Thinking reaction right away so the member sees the bot noticed the message.
    const item: Pending = {
      text: formatChatMessage(info),
      plain: info.text,
      authorId: message.author.id,
      admin: isAdminMessage(message),
      directed,
      messageId: message.id,
      channelId: message.channelId,
    };
    if (directed) void this.markThinking(item);
    void (async () => {
      if (directed && message.mentions.users.has(bot.id) && message.reference?.messageId) {
        const ref = await message.fetchReference().catch(() => null);
        if (ref) item.replyTo = { name: displayName(ref), text: replaceBotMention(ref.content, bot.id, this.botName()) };
      }
      this.enqueue(chat.threadId, item, false);
    })();
  }

  // ---- per-thread queue ---------------------------------------------------------

  private enqueue(threadId: string, item: Pending, immediate: boolean): void {
    let s = this.states.get(threadId);
    if (!s) {
      s = { busy: false, buffer: [], timer: null };
      this.states.set(threadId, s);
    }
    if (this.stopped) {
      void this.clearThinking([item]);
      return;
    }
    s.buffer.push(item);
    if (s.busy) return;
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
        try {
          await this.runTurn(threadId, batch);
        } finally {
          await this.clearThinking(batch);
        }
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

  /** `[build status]` block for the thread's newest job while it is in flight; empty otherwise. */
  private jobStatusBlock(threadId: string): string {
    try {
      const job = this.db.getBuildJobByThread(threadId);
      if (!job || !(ACTIVE_BUILD_STATUSES.includes(job.status) || job.status === 'pr_open')) return '';
      const since = job.status === 'building' ? (job.approvedAt ?? job.updatedAt) : job.updatedAt;
      return formatJobStatus({
        jobId: job.id,
        title: job.title,
        request: job.request,
        status: job.status,
        queuePosition: job.status === 'queued' ? queuePosition(this.db.listBuildJobsByStatus(['queued']), job.id) : null,
        sinceMs: Date.now() - since,
        prUrl: job.prUrl,
      });
    } catch (err) {
      console.warn(`[chat] guild=${config.guildId} thread=${threadId} could not build job status:`, err instanceof Error ? err.message : err);
      return '';
    }
  }

  private async runTurn(threadId: string, batch: Pending[]): Promise<void> {
    const chat = this.db.getChatThread(threadId);
    if (!chat) return;
    // Typing only when someone is actually talking to the bot; undirected turns usually stay silent.
    const stopTyping = batch.some((b) => b.directed) ? this.typing(threadId) : () => undefined;
    try {
      // Feature requests never reach the chat agent; pending build notes stay for the next chat turn.
      const requester = this.requesterOf(batch);
      if (await this.detectFeatureRequest(threadId, batch, requester)) {
        await this.handoff(threadId, requester, featureRequestText({ text: requester.plain, replyTo: requester.replyTo }));
        return;
      }
      const notes = this.db.pendingChatNotes(threadId);
      const status = this.jobStatusBlock(threadId);
      const prompt = withNotes(status ? [status, ...notes] : notes, withLanguageRule(batch.map((b) => b.text).join('\n'), this.chatLanguages()));
      const parsed = await this.askChat(threadId, chat.sessionId, chat.model, prompt, () => this.db.consumeChatNotes(threadId, notes.length));
      if (parsed.reply) await this.say(threadId, parsed.visible, this.replyTarget(threadId, batch));
    } catch (err) {
      console.error(`[chat] guild=${config.guildId} thread=${threadId} turn failed:`, err);
      await this.say(threadId, 'Sorry, something went wrong on my side. Please try again in a bit.', this.replyTarget(threadId, batch));
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
      if (await this.detectFeatureRequest(threadId, [pending], pending)) {
        await this.handoff(threadId, pending, featureRequestText({ text: pending.plain, replyTo: pending.replyTo }));
        return;
      }
      const { sessionId, modelRef } = await this.newSession(key);
      this.db.createChatThread({ threadId: key, guildId: config.guildId, channelId: message.channel.isThread() ? (message.channel.parentId ?? threadId) : threadId, sessionId, startedBy: message.author.id, model: modelRef, oneOff: true });
      const parsed = await this.askChat(key, sessionId, modelRef, withLanguageRule(pending.text, this.chatLanguages()));
      if (parsed.reply) await this.say(threadId, parsed.visible, pending.messageId);
    } catch (err) {
      console.error(`[chat] guild=${config.guildId} thread=${threadId} one-off failed:`, err);
      await this.say(threadId, 'Sorry, something went wrong on my side. Please try again in a bit.', pending.messageId);
    } finally {
      stopTyping();
      await this.clearThinking([pending]);
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
      reply = await agent.promptAndWait(sessionId, withLanguageRule('Reply now with only your message to the thread, followed by the json block.', this.chatLanguages()), CHAT_TIMEOUT_MS);
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

  /**
   * Ask the decision model whether the requester's plain message is a feature request. Runs only for a
   * directed admin message while building is enabled; any failure means "no".
   */
  private async detectFeatureRequest(threadId: string, batch: Pending[], requester: Pending): Promise<boolean> {
    const buildingEnabled = this.db.getBuilderSettings().enabled && this.builder.configured;
    // A job is already active in this thread: never start another; the chat agent answers (it sees the status block).
    const job = this.db.getBuildJobByThread(threadId);
    if (job && ACTIVE_BUILD_STATUSES.includes(job.status)) return false;
    if (!batch.some((b) => b.directed) || !shouldRunDecision({ directed: requester.directed, admin: requester.admin, buildingEnabled, text: requester.plain })) return false;
    try {
      const modelRef = this.db.getBuilderSettings().chatDecisionModel;
      const model = parseModelRef(modelRef);
      if (!model) throw new Error(`Invalid decision model setting "${modelRef}"`);
      const input = formatDecisionInput({ text: requester.plain, replyTo: requester.replyTo });
      const probability = await this.getAgent().decide(model, input, FEATURE_REQUEST_QUESTION, DECISION_TIMEOUT_MS);
      const yes = isFeatureRequest(probability);
      console.log(`[chat] guild=${config.guildId} thread=${threadId} decision feature_request=${probability ?? 'none'} -> ${yes}`);
      return yes;
    } catch (err) {
      console.warn(`[chat] guild=${config.guildId} thread=${threadId} decision failed:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Start a build job for a request the gate already approved (directed, admin, building enabled). */
  private async handoff(threadId: string, requester: Pending, request: string): Promise<void> {
    // Only a message inside the thread itself can be replied to.
    const replyTo = requester.channelId === threadId ? requester.messageId : null;
    const slot = this.builder.reserve(threadId);
    if (!slot.ok) {
      await this.say(threadId, slot.active ? "There's already a feature request in progress in this thread." : "I'm already setting up a request in this thread. Please ask again in a minute.", replyTo);
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
        triggerMessageId: requester.messageId,
        context: formatTranscript(entries),
      });
      await this.say(threadId, "Got it, I'll make a plan for this.", replyTo);
    } catch (err) {
      this.builder.release(threadId);
      console.error(`[chat] guild=${config.guildId} thread=${threadId} could not hand off to the builder:`, err);
      await this.say(threadId, 'Sorry, I could not start that request.', replyTo);
    }
  }
}
