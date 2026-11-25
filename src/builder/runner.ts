import { ActivityType, Events, type Client, type Message, type SendableChannels } from 'discord.js';
import { config } from '../config.js';
import type { BotDatabase, BuildJob } from '../db.js';
import {
  buildBuildingCard,
  buildCancelledCard,
  buildClosedCard,
  buildConflictFixCard,
  buildConflictFixedCard,
  buildConflictManualCard,
  buildFailedCard,
  buildMergedCard,
  buildNoteCard,
  buildPlanCard,
  buildPrOpenedCard,
  buildQueuedCard,
  buildResumingCard,
  type BuilderMessage,
} from './cards.js';
import { ChatRunner } from './chat.js';
import { LimitGate } from './limits.js';
import { addUsage, sessionUsageWithEstimate, type TokenUsage } from './pricing.js';
import { NO_MENTIONS, withReply } from '../discord.js';
import { OpenCodeAgent, REPO_DIR, type AgentReply } from './opencode.js';
import { formatBuildNote, type BuildNoteInfo, type PromptImage, MAX_IMAGES } from './chat-parse.js';
import { normalizeBuildResult, normalizePlanResult, parseAgentReply, parseModelRef, parsePrUrl, prInfoFromJson, type PrInfo, type PrRef } from './parse.js';
import { BUILDING, DONE, FAILED, PLANNING, addReaction, removeOwnReaction } from './reactions.js';
import { BUILD_ERROR_RETRY_PROMPT, PLAN_ERROR_RETRY_PROMPT, MAX_ERROR_RETRIES, isTransientAgentError, BUILD_RESUME_PROMPT, PLAN_RESUME_PROMPT, buildPrompt, buildingActivity, conflictAction, conflictFixPrompt, decideRecovery, followUpPrompt, formatPlannerMessage, freeSlots, shouldHoldPlanReply, reactionChannelFor, guardPlanStatus, pickJobsToStart, planChanged, queuePosition } from './queue.js';

const PLAN_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 90 * 60_000;
const PR_POLL_MS = 2 * 60_000;
const QUEUE_TICK_MS = 30_000;

interface BufferedItem {
  text: string;
  /** When the message was sent (ms). */
  sentAt: number;
  messageId?: string;
  /** Images attached to the message (data URIs). */
  images?: PromptImage[];
  /** Revising turn after follow-up messages: its reply can never approve. */
  followUp?: boolean;
}

interface JobState {
  busy: boolean;
  /** Messages that trigger the next planner turn. */
  buffer: BufferedItem[];
  /** Messages written while a turn was running: context for the next real turn, never a trigger or an approval. */
  preContext: BufferedItem[];
  /** Directed messages written while a turn was running: trigger a revising turn right after it, never an approval. */
  followUps: BufferedItem[];
}

const PRE_PLAN_HEADER = 'Other thread messages since your last reply (context only; they can not approve the plan):';

/** First ~500 chars of the visible text, for failure messages. */
function excerpt(text: string): string {
  const t = text.trim();
  return t.length > 500 ? `${t.slice(0, 500)}…` : t;
}

/** The part of OpenCodeAgent the runner uses (lets tests plug in a fake). */
export type AgentApi = Pick<OpenCodeAgent, 'warm' | 'createWorktree' | 'createSession' | 'switchAgent' | 'sessionExists' | 'waitIdle' | 'latestReply' | 'lastIsAssistant' | 'usage' | 'promptAndWait' | 'decide' | 'refreshMain' | 'limitMeters'>;

export interface RunnerDeps {
  agent?: AgentApi;
  fetchPrInfo?: (ref: PrRef) => Promise<PrInfo | 'rate-limited'>;
}

export class BuilderRunner {
  private agent: AgentApi | null = null;
  private readonly states = new Map<number, JobState>();
  private prTimer: NodeJS.Timeout | null = null;
  private pollingPrs = false;
  private stopped = false;
  /** Threads whose new job is being set up, so two quick handoffs can't both start one. */
  private readonly starting = new Set<string>();
  private queueTimer: NodeJS.Timeout | null = null;
  private drainingQueue = false;
  /** Shared by the chat assistant: refuses model calls while an OpenCode Go limit is nearly used up. */
  readonly limitGate = new LimitGate();
  private readonly fetchPrInfo: (ref: PrRef) => Promise<PrInfo | 'rate-limited'>;

  /** The chat assistant; hands feature requests to this runner. */
  readonly chat: ChatRunner;

  constructor(
    private readonly client: Client,
    private readonly db: BotDatabase,
    deps: RunnerDeps = {},
  ) {
    this.agent = deps.agent ?? null;
    this.fetchPrInfo = deps.fetchPrInfo ?? fetchPrInfo;
    this.chat = new ChatRunner(client, db, this);
  }

  /** True when the OpenCode password is configured (the dashboard switch is checked separately). */
  get configured(): boolean {
    return this.agent !== null || config.opencodePassword !== null;
  }

  /**
   * Reserve the right to start a job in a thread (one non-terminal job per thread). On success the
   * caller must hand it over by calling `startJob` (which releases it) or call `release()` if it gives
   * up. On failure, `active` is the thread's running job (null while one is still being set up).
   */
  reserve(threadId: string): { ok: true } | { ok: false; active: BuildJob | null } {
    const active = this.db.activeBuildJobInThread(threadId);
    if (active) return { ok: false, active };
    if (this.starting.has(threadId)) return { ok: false, active: null };
    this.starting.add(threadId);
    return { ok: true };
  }

  release(threadId: string): void {
    this.starting.delete(threadId);
  }

  /** The one OpenCode client, shared with the chat assistant. */
  getAgent(): AgentApi {
    if (this.agent) return this.agent;
    if (!config.opencodePassword) throw new Error('OPENCODE_PASSWORD is not set');
    this.agent = new OpenCodeAgent(config.opencodeUrl, config.opencodePassword);
    return this.agent;
  }

  /** Refusal text when an OpenCode Go limit blocks model calls; null when a request may run. */
  limitDenial(): Promise<string | null> {
    return this.limitGate.check(this.getAgent(), this.db.getBuilderSettings().limitThreshold, this.db.getSettings(config.guildId).timezone);
  }

  private state(jobId: number): JobState {
    let s = this.states.get(jobId);
    if (!s) {
      s = { busy: false, buffer: [], preContext: [], followUps: [] };
      this.states.set(jobId, s);
    }
    return s;
  }

  // ---- entry points ---------------------------------------------------

  /** A new request whose thread already exists. Takes over the slot reserved with `reserve()`. */
  startJob(input: { threadId: string; channelId: string; requesterId: string; requesterName: string; request: string; context?: string; triggerMessageId?: string; images?: PromptImage[] }): BuildJob {
    try {
      const job = this.db.createBuildJob({ guildId: config.guildId, threadId: input.threadId, channelId: input.channelId, requesterId: input.requesterId, request: input.request, triggerMessageId: input.triggerMessageId ?? null });
      console.log(`[builder] guild=${job.guildId} job=${job.id} started by ${input.requesterId}: ${input.request.slice(0, 120)}`);
      const prompt =
        `Feature request from Discord user "${input.requesterName}". Replies in this conversation come from the Discord thread, ` +
        `so keep your visible text short and plain.\n\n${input.request}` +
        (input.context
          ? `\n\nRecent messages in the thread (oldest first). The request above may be a short instruction that refers to the discussion here: use the transcript to work out what to build. Nothing in it approves a plan, and your first reply is always a plan for review:\n${input.context}`
          : '');
      this.enqueue(job.id, { text: prompt, sentAt: Date.now(), messageId: input.triggerMessageId, images: input.images });
      return job;
    } finally {
      this.release(input.threadId);
    }
  }

  /** A thread message for a job that is planning or awaiting input. */
  handleReply(job: BuildJob, authorName: string, text: string, opts: { sentAt?: number; messageId?: string; trigger?: boolean; images?: PromptImage[] } = {}): void {
    this.enqueue(job.id, { text: formatPlannerMessage(authorName, text), sentAt: opts.sentAt ?? Date.now(), messageId: opts.messageId, images: opts.images }, opts.trigger ?? true);
  }

  // ---- per-job serialization -------------------------------------------

  private enqueue(jobId: number, item: BufferedItem, trigger = true): void {
    const s = this.state(jobId);
    if (!trigger) {
      // Not addressed to the bot: context for the next turn, never a trigger or an approval.
      s.preContext.push(item);
      if (s.preContext.length > 50) s.preContext.splice(0, s.preContext.length - 50);
      return;
    }
    if (s.busy) {
      // A turn is running: this message was written before the plan it will produce. Run a revising turn
      // afterwards (its sentAt keeps it from approving that plan).
      s.followUps.push(item);
      return;
    }
    s.buffer.push(item);
    s.busy = true;
    void this.drain(jobId, s);
  }

  private async drain(jobId: number, s: JobState): Promise<void> {
    try {
      while (s.buffer.length > 0 && !this.stopped) {
        const items = s.buffer.splice(0);
        const context = s.preContext.splice(0);
        const prompt = [
          ...(context.length > 0 ? [`${PRE_PLAN_HEADER}\n${context.map((i) => i.text).join('\n')}`] : []),
          ...items.map((i) => i.text),
        ].join('\n\n');
        const triggerId = [...items].reverse().find((i) => i.messageId)?.messageId;
        const images = items.flatMap((i) => i.images ?? []).slice(0, MAX_IMAGES);
        await this.runTurn(jobId, prompt, Math.max(...items.map((i) => i.sentAt)), triggerId, images, items.some((i) => i.followUp));
        const status = this.db.getBuildJob(jobId)?.status;
        // Context only makes sense while we are still planning.
        if (status !== 'awaiting_input' && status !== 'planning') {
          s.preContext.length = 0;
          s.followUps.length = 0;
        } else if (s.followUps.length > 0 && s.buffer.length === 0 && !this.stopped) {
          const followUps = s.followUps.splice(0);
          const context = s.preContext.splice(0);
          const prompt = followUpPrompt(followUps.map((i) => i.text), context.map((i) => i.text), PRE_PLAN_HEADER);
          const triggerId = [...followUps].reverse().find((i) => i.messageId)?.messageId;
          const images = followUps.flatMap((i) => i.images ?? []).slice(0, MAX_IMAGES);
          // Loop: a follow-up turn may itself collect follow-ups.
          s.buffer.push({ text: prompt, sentAt: Math.max(...followUps.map((i) => i.sentAt)), messageId: triggerId, images, followUp: true });
        }
      }
    } finally {
      s.followUps.length = 0;
      s.busy = false;
    }
  }

  // ---- discord helpers --------------------------------------------------

  /** Post a message to the job's thread (as a reply to `replyTo` when given); returns the sent message, or null when it could not be posted. */
  private async post(job: BuildJob, message: BuilderMessage, replyTo?: string | null): Promise<Message | null> {
    try {
      const channel = await this.client.channels.fetch(job.threadId);
      if (!channel || !channel.isSendable()) {
        console.warn(`[builder] guild=${job.guildId} job=${job.id} thread ${job.threadId} is not sendable`);
        return null;
      }
      // The thread's starter message (id === thread id) can't be replied to from inside the thread.
      return await (channel as SendableChannels).send(replyTo && replyTo !== job.threadId ? withReply(message, replyTo) : message);
    } catch (err) {
      console.error(`[builder] guild=${job.guildId} job=${job.id} could not post to thread:`, err);
      return null;
    }
  }

  // ---- reactions + presence -----------------------------------------------

  private react(job: BuildJob, messageId: string | null | undefined, emoji: string): Promise<void> {
    return messageId ? addReaction(this.client, reactionChannelFor(messageId, job.threadId, job.channelId), messageId, emoji, 'builder') : Promise.resolve();
  }

  private unreact(job: BuildJob, messageId: string | null | undefined, emoji: string): Promise<void> {
    return messageId ? removeOwnReaction(this.client, reactionChannelFor(messageId, job.threadId, job.channelId), messageId, emoji, 'builder') : Promise.resolve();
  }

  /** 🔨 on the plan message while a build or conflict fix runs; also refreshes the bot activity. */
  private buildStarted(job: BuildJob): void {
    void this.react(job, job.planMessageId, BUILDING);
    this.updatePresence();
  }

  /** Build/fix finished (any outcome): drop 🔨 and refresh the bot activity. */
  private async buildEnded(jobId: number): Promise<void> {
    const job = this.db.getBuildJob(jobId);
    if (job) await this.unreact(job, job.planMessageId, BUILDING);
    this.updatePresence();
  }

  /** Bot activity: "Building <title>" while jobs are building, cleared otherwise. */
  updatePresence(): void {
    try {
      const text = buildingActivity(this.db.listBuildJobsByStatus(['building']).map((j) => j.title));
      this.client.user?.setPresence({ activities: text ? [{ name: text, state: text, type: ActivityType.Custom }] : [] });
    } catch (err) {
      console.warn('[builder] could not update presence:', err instanceof Error ? err.message : err);
    }
  }

  // ---- turns ------------------------------------------------------------

  /** Tell the thread's chat session (if it has one) what happened; delivered with its next prompt, no model call now. */
  private note(job: BuildJob, info: Omit<BuildNoteInfo, 'jobId' | 'title'>): void {
    const fresh = this.db.getBuildJob(job.id) ?? job;
    this.db.addChatNote(job.threadId, formatBuildNote({ ...info, jobId: job.id, title: fresh.title }));
  }

  private async fail(jobId: number, reason: string): Promise<void> {
    const wasBuilding = this.db.getBuildJob(jobId)?.status === 'building';
    this.db.updateBuildJob(jobId, { error: reason.slice(0, 2000) });
    this.db.setBuildJobStatus(jobId, 'failed');
    const job = this.db.getBuildJob(jobId);
    if (!job) return;
    if (wasBuilding && job.planMessageId) void this.react(job, job.planMessageId, FAILED);
    this.updatePresence();
    this.note(job, { event: 'failed', reason });
    await this.post(job, buildFailedCard({ reason, usage: this.usageOf(job) }), job.planMessageId);
  }

  private usageOf(job: BuildJob): TokenUsage | null {
    const total = job.tokensInput + job.tokensOutput + job.tokensReasoning + job.tokensCacheRead + job.tokensCacheWrite;
    if (total === 0 && job.costUsd === 0) return null;
    return {
      input: job.tokensInput,
      output: job.tokensOutput,
      reasoning: job.tokensReasoning,
      cacheRead: job.tokensCacheRead,
      cacheWrite: job.tokensCacheWrite,
      costUsd: job.costUsd,
    };
  }

  private async saveUsage(job: BuildJob): Promise<void> {
    try {
      // Re-read: the build session replaces `sessionId` (and `planSessionId` gets set) after `job` was loaded.
      const cur = this.db.getBuildJob(job.id) ?? job;
      if (!cur.sessionId) return;
      const agent = this.getAgent();
      let usage = await sessionUsageWithEstimate(agent, cur.sessionId, cur.model);
      if (cur.planSessionId) usage = addUsage(usage, await sessionUsageWithEstimate(agent, cur.planSessionId, cur.model));
      this.db.setBuildJobUsage(job.id, usage);
    } catch (err) {
      console.warn(`[builder] guild=${job.guildId} job=${job.id} could not read usage:`, err instanceof Error ? err.message : err);
    }
  }

  /** Re-prompts the session while the reply ended with a transient error; returns the final reply for the normal handling. */
  private async retryTransient(job: BuildJob, sessionId: string, first: AgentReply, retryPrompt: string, timeoutMs: number, onProgress: () => Promise<void>): Promise<AgentReply> {
    const status = (this.db.getBuildJob(job.id) ?? job).status;
    let reply = first;
    for (let attempt = 1; attempt <= MAX_ERROR_RETRIES && isTransientAgentError(reply.error) && !this.stopped; attempt++) {
      const cur = this.db.getBuildJob(job.id);
      if (!cur || cur.status !== status) break;
      console.warn(`[builder] guild=${job.guildId} job=${job.id} transient agent error (${reply.error}), retry ${attempt}/${MAX_ERROR_RETRIES}`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
      if (this.stopped) break;
      const again = this.db.getBuildJob(job.id);
      if (!again || again.status !== status) break;
      reply = await this.getAgent().promptAndWait(sessionId, retryPrompt, timeoutMs, undefined, onProgress);
      await this.saveUsage(job);
    }
    return reply;
  }

  /** One planning turn: set up on the first call, then prompt the planner and handle its reply. */
  private async runTurn(jobId: number, prompt: string, latestUserMessageAt: number, triggerId?: string, images: readonly PromptImage[] = [], noApprove = false): Promise<void> {
    let job = this.db.getBuildJob(jobId);
    if (!job) return;
    const trigger = triggerId ?? job.triggerMessageId;
    const denial = await this.limitDenial();
    if (denial) {
      console.warn(`[builder] guild=${job.guildId} job=${job.id} turn refused: ${denial}`);
      const fresh = this.db.getBuildJob(jobId) ?? job;
      if (!fresh.sessionId) {
        // Nothing reached the agent yet: the request itself is denied.
        await this.fail(jobId, denial);
        return;
      }
      // Keep the job so the member can continue after the reset; the dropped message can be resent.
      this.db.setBuildJobStatus(jobId, 'awaiting_input');
      await this.post(fresh, buildNoteCard(denial), trigger);
      return;
    }
    const added = this.react(job, trigger, PLANNING);
    try {
      this.db.setBuildJobStatus(jobId, 'planning');
      if (!job.sessionId) job = await this.setup(job);
      const current = job;
      const first = await this.getAgent().promptAndWait(job.sessionId as string, prompt, PLAN_TIMEOUT_MS, images, () => this.saveUsage(current));
      const reply = await this.retryTransient(job, job.sessionId as string, first, PLAN_ERROR_RETRY_PROMPT, PLAN_TIMEOUT_MS, () => this.saveUsage(current));
      await this.saveUsage(job);
      // Directed messages arrived during this turn: its reply is stale, the follow-up turn posts the plan.
      const pending = this.state(jobId).followUps.length;
      if (pending > 0 && !this.stopped) {
        const planStatus = reply.error ? null : (normalizePlanResult(parseAgentReply(reply.text).result)?.status ?? null);
        if (shouldHoldPlanReply({ pendingFollowUps: pending, error: Boolean(reply.error), planStatus })) {
          console.log(`[builder] guild=${job.guildId} job=${job.id} reply held: ${pending} follow-up message(s) arrived during the turn`);
          return;
        }
      }
      await this.handlePlanReply(this.db.getBuildJob(jobId) ?? job, reply, latestUserMessageAt, trigger, noApprove);
    } catch (err) {
      console.error(`[builder] guild=${job.guildId} job=${job.id} turn failed:`, err);
      await this.fail(jobId, err instanceof Error ? err.message : String(err));
    } finally {
      await added;
      await this.unreact(job, trigger, PLANNING);
    }
  }

  /** Worktree + planner session for a brand new job. */
  private async setup(job: BuildJob): Promise<BuildJob> {
    const agent = this.getAgent();
    const modelRef = this.db.getBuilderSettings().model;
    const model = parseModelRef(modelRef);
    if (!model) throw new Error(`Invalid model setting "${modelRef}" (expected provider/model)`);
    await agent.warm(REPO_DIR);
    const { directory, branch } = await agent.createWorktree(job.id);
    await agent.warm(directory);
    const sessionId = await agent.createSession({
      directory,
      agent: 'feature-plan',
      model,
      title: `bojan job ${job.id}`,
      metadata: { jobId: job.id, threadId: job.threadId },
    });
    this.db.updateBuildJob(job.id, { worktreeDir: directory, branch, sessionId, model: modelRef });
    console.log(`[builder] guild=${job.guildId} job=${job.id} worktree=${directory} branch=${branch} session=${sessionId} model=${modelRef}`);
    return this.db.getBuildJob(job.id) as BuildJob;
  }

  /**
   * `latestUserMessageAt`: send time of the newest user message that triggered this turn. Restart recovery
   * doesn't know the triggering messages and passes Date.now(), so a recovered turn may approve as long as
   * a plan card was already posted.
   */
  private async handlePlanReply(job: BuildJob, reply: AgentReply, latestUserMessageAt: number, replyTo?: string | null, noApprove = false): Promise<void> {
    if (reply.error) {
      await this.fail(job.id, `The agent reported an error: ${reply.error}`);
      return;
    }
    const { visible, result } = parseAgentReply(reply.text);
    const plan = normalizePlanResult(result);
    if (!plan) {
      if (!visible) {
        await this.fail(job.id, 'The agent returned an empty reply.');
        return;
      }
      // No usable result block: show what it said and let the user continue the conversation.
      console.warn(`[builder] guild=${job.guildId} job=${job.id} planner reply had no valid result block`);
      this.db.setBuildJobStatus(job.id, 'awaiting_input');
      await this.post(job, buildNoteCard(visible), replyTo);
      return;
    }
    if (plan.title) this.db.updateBuildJob(job.id, { title: plan.title });
    const title = plan.title || job.title || '';

    if (plan.status === 'cancelled') {
      this.db.setBuildJobStatus(job.id, 'cancelled');
      this.note(job, { event: 'cancelled' });
      await this.post(job, buildCancelledCard(this.usageOf(this.db.getBuildJob(job.id) ?? job)));
      return;
    }
    // A follow-up turn answers messages written before its plan is shown, so it can never approve.
    const status = noApprove && plan.status === 'approved' ? 'needs_input' : guardPlanStatus({ status: plan.status, planPostedAt: job.planPostedAt, latestUserMessageAt });
    const downgraded = plan.status === 'approved' && status === 'needs_input';
    if (downgraded) console.warn(`[builder] guild=${job.guildId} job=${job.id} approval ignored: no user message after the plan`);
    if (status === 'needs_input') {
      this.db.setBuildJobStatus(job.id, 'awaiting_input');
      if (downgraded || planChanged(job.lastPlan, plan.plan)) {
        const sent = await this.post(job, buildPlanCard({ title, plan: plan.plan, questions: plan.questions, visible }), replyTo);
        if (sent) {
          this.db.updateBuildJob(job.id, { planMessageId: sent.id, planPostedAt: Date.now(), lastPlan: plan.plan || job.lastPlan || visible });
        }
      } else {
        const questions = plan.questions.length > 0 ? `**Questions**\n${plan.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}` : '';
        const text = [visible, questions].filter((t) => t.length > 0).join('\n\n');
        if (text) await this.post(job, buildNoteCard(text), replyTo);
      }
      return;
    }
    // approved: keep the latest full plan (the fresh build session is started from it, also for a queued launch);
    // an approval reply with an empty plan keeps the last posted one.
    this.db.updateBuildJob(job.id, { approvedAt: Date.now(), ...(plan.plan.trim() ? { lastPlan: plan.plan } : {}) });
    // build now when a slot is free (and nobody is waiting ahead), otherwise queue up
    job = this.db.getBuildJob(job.id) ?? job;
    const slotFree = freeSlots(this.db.countBuildingJobs(), this.db.getBuilderSettings().maxParallelBuilds) > 0;
    let limitNote: string | null = null;
    if (slotFree && this.db.listBuildJobsByStatus(['queued']).length === 0) {
      limitNote = await this.limitDenial();
      if (!limitNote) {
        this.launchBuild(this.db.getBuildJob(job.id) ?? job, plan.plan);
        return;
      }
      console.warn(`[builder] guild=${job.guildId} job=${job.id} build not started yet: ${limitNote}`);
    }
    this.db.setBuildJobStatus(job.id, 'queued');
    const queued = this.db.getBuildJob(job.id) ?? job;
    const position = queuePosition(this.db.listBuildJobsByStatus(['queued']), job.id);
    console.log(`[builder] guild=${job.guildId} job=${job.id} approved, queued #${position}`);
    this.note(queued, { event: 'queued', plan: plan.plan, position });
    await this.post(queued, buildQueuedCard({ title, position }));
    if (limitNote) await this.post(queued, buildNoteCard(limitNote));
    this.drainQueue();
  }

  /** Start queued jobs (FIFO) while build slots are free and the Go limits allow it. Overlapping calls are ignored (the 30s tick retries). */
  drainQueue(): void {
    if (this.stopped || !this.configured || this.drainingQueue) return;
    const queued = this.db.listBuildJobsByStatus(['queued']);
    const max = this.db.getBuilderSettings().maxParallelBuilds;
    if (queued.length === 0 || freeSlots(this.db.countBuildingJobs(), max) === 0) return;
    this.drainingQueue = true;
    void this.startQueued(max)
      .catch((err) => console.error('[builder] could not start queued jobs:', err))
      .finally(() => {
        this.drainingQueue = false;
      });
  }

  private async startQueued(max: number): Promise<void> {
    const denial = await this.limitDenial();
    // Blocked: the 30s tick retries after the reset; the queued card already told the requester it waits.
    if (denial) return;
    // Synchronous from here, so slots can't be double-booked.
    const building = this.db.countBuildingJobs();
    for (const job of pickJobsToStart(this.db.listBuildJobsByStatus(['queued']), building, max)) {
      console.log(`[builder] guild=${job.guildId} job=${job.id} leaving the queue, building now`);
      this.launchBuild(job);
    }
  }

  /** Take a build slot (status `building`) and run the build in the background. */
  private launchBuild(job: BuildJob, plan?: string): void {
    this.db.updateBuildJob(job.id, { resumeCount: 0 });
    this.db.setBuildJobStatus(job.id, 'building');
    this.note(job, { event: 'approved', plan });
    this.buildStarted(this.db.getBuildJob(job.id) ?? job);
    void this.inBackground(job, async (fresh) => {
      await this.post(fresh, buildBuildingCard(fresh.title ?? ''), fresh.planMessageId);
      await this.runBuild(fresh);
    }, (reason) => this.fail(job.id, reason));
  }

  /** Run a slot-holding task: failure handling, reaction/presence cleanup, and start the next queued job afterwards. */
  private async inBackground(job: BuildJob, task: (fresh: BuildJob) => Promise<void>, onError: (reason: string) => Promise<void>): Promise<void> {
    try {
      await task(this.db.getBuildJob(job.id) ?? job);
    } catch (err) {
      console.error(`[builder] guild=${job.guildId} job=${job.id} background run failed:`, err);
      await onError(err instanceof Error ? err.message : String(err)).catch(() => undefined);
    } finally {
      await this.buildEnded(job.id);
      this.drainQueue();
    }
  }

  private async runBuild(job: BuildJob): Promise<void> {
    const agent = this.getAgent();
    const plan = job.lastPlan?.trim() ?? '';
    let reply: AgentReply;
    if (plan) {
      // Fresh session: only the request and the approved plan, not the planner's conversation.
      const build = job.planSessionId === null ? await this.startBuildSession(job) : job;
      const prompt = buildPrompt({ request: job.request, title: job.title, plan });
      reply = await agent.promptAndWait(build.sessionId as string, prompt, BUILD_TIMEOUT_MS, undefined, () => this.saveUsage(build));
      reply = await this.retryTransient(job, build.sessionId as string, reply, BUILD_ERROR_RETRY_PROMPT, BUILD_TIMEOUT_MS, () => this.saveUsage(build));
    } else {
      // No plan text to hand over: continue the planner session instead of building blind.
      console.warn(`[builder] guild=${job.guildId} job=${job.id} no plan text stored, building in the planner session`);
      await agent.switchAgent(job.sessionId as string, 'feature-build');
      reply = await agent.promptAndWait(job.sessionId as string, 'The user approved the plan above. Implement it now following your instructions.', BUILD_TIMEOUT_MS, undefined, () => this.saveUsage(job));
      reply = await this.retryTransient(job, job.sessionId as string, reply, BUILD_ERROR_RETRY_PROMPT, BUILD_TIMEOUT_MS, () => this.saveUsage(job));
    }
    await this.saveUsage(job);
    await this.handleBuildReply(this.db.getBuildJob(job.id) ?? job, reply);
  }

  /** New `feature-build` session in the job's worktree; the planner session moves to `planSessionId`. */
  private async startBuildSession(job: BuildJob): Promise<BuildJob> {
    const modelRef = job.model ?? this.db.getBuilderSettings().model;
    const model = parseModelRef(modelRef);
    if (!model) throw new Error(`Invalid model setting "${modelRef}" (expected provider/model)`);
    const sessionId = await this.getAgent().createSession({
      directory: job.worktreeDir as string,
      agent: 'feature-build',
      model,
      title: `bojan job ${job.id} build`,
      metadata: { jobId: job.id, threadId: job.threadId },
    });
    this.db.updateBuildJob(job.id, { planSessionId: job.sessionId, sessionId });
    console.log(`[builder] guild=${job.guildId} job=${job.id} build session=${sessionId} (planner session=${job.sessionId}) model=${modelRef}`);
    return this.db.getBuildJob(job.id) as BuildJob;
  }

  // ---- merge conflict fix ---------------------------------------------------

  /** The single automatic attempt: the job takes a build slot again and the agent merges main into its branch. */
  private launchFix(job: BuildJob): void {
    this.db.updateBuildJob(job.id, { fixAttempts: job.fixAttempts + 1, resumeCount: 0 });
    this.db.setBuildJobStatus(job.id, 'building');
    const fresh = this.db.getBuildJob(job.id) ?? job;
    console.log(`[builder] guild=${job.guildId} job=${job.id} PR ${job.prUrl} has conflicts, trying to fix`);
    this.note(fresh, { event: 'conflict_fix_started', prUrl: job.prUrl });
    this.buildStarted(fresh);
    void this.inBackground(fresh, async (f) => {
      await this.post(f, buildConflictFixCard(f.title ?? ''), f.planMessageId);
      const agent = this.getAgent();
      if (f.planSessionId === null) await agent.switchAgent(f.sessionId as string, 'feature-build');
      const first = await agent.promptAndWait(f.sessionId as string, conflictFixPrompt(f.prUrl as string), BUILD_TIMEOUT_MS, undefined, () => this.saveUsage(f));
      const reply = await this.retryTransient(f, f.sessionId as string, first, BUILD_ERROR_RETRY_PROMPT, BUILD_TIMEOUT_MS, () => this.saveUsage(f));
      await this.saveUsage(f);
      await this.handleFixReply(this.db.getBuildJob(f.id) ?? f, reply);
    }, (reason) => this.failFix(job.id, reason));
  }

  private async handleFixReply(job: BuildJob, reply: AgentReply): Promise<void> {
    if (reply.error) return this.failFix(job.id, `The build agent reported an error: ${reply.error}`);
    const { visible, result } = parseAgentReply(reply.text);
    const build = normalizeBuildResult(result);
    if (!build) return this.failFix(job.id, `The build agent did not report a result.${visible ? `\n\n${excerpt(visible)}` : ''}`);
    if (build.status === 'failed') return this.failFix(job.id, build.reason);
    if (job.prUrl && build.prUrl !== job.prUrl) {
      console.warn(`[builder] guild=${job.guildId} job=${job.id} conflict fix reported a different PR (keeping ${job.prUrl}, agent said ${build.prUrl})`);
      return this.failFix(job.id, `The build agent reported a different pull request (${build.prUrl}) than the one being tracked (${job.prUrl}).`);
    }
    this.db.updateBuildJob(job.id, { prUrl: build.prUrl, error: null });
    this.db.setBuildJobStatus(job.id, 'pr_open');
    const fresh = this.db.getBuildJob(job.id) ?? job;
    console.log(`[builder] guild=${job.guildId} job=${job.id} conflicts fixed: ${build.prUrl}`);
    this.note(fresh, { event: 'conflict_fixed', prUrl: build.prUrl });
    await this.post(fresh, buildConflictFixedCard({ title: fresh.title ?? '', prUrl: build.prUrl }));
  }

  /** The PR is still open, so the job is not failed: record why and ask for a manual merge (once). */
  private async failFix(jobId: number, reason: string): Promise<void> {
    this.db.updateBuildJob(jobId, { error: reason.slice(0, 2000), conflictNotified: true });
    this.db.setBuildJobStatus(jobId, 'pr_open');
    const job = this.db.getBuildJob(jobId);
    if (!job) return;
    console.warn(`[builder] guild=${job.guildId} job=${job.id} conflict fix failed: ${reason.slice(0, 200)}`);
    this.note(job, { event: 'conflict_failed', prUrl: job.prUrl, reason });
    await this.post(job, buildConflictManualCard({ title: job.title ?? '', prUrl: job.prUrl ?? '', reason }));
  }

  private async handleBuildReply(job: BuildJob, reply: AgentReply): Promise<void> {
    if (reply.error) {
      await this.fail(job.id, `The build agent reported an error: ${reply.error}`);
      return;
    }
    const { visible, result } = parseAgentReply(reply.text);
    const build = normalizeBuildResult(result);
    if (!build) {
      await this.fail(job.id, `The build agent did not report a pull request.${visible ? `\n\n${excerpt(visible)}` : ''}`);
      return;
    }
    if (build.status === 'failed') {
      await this.fail(job.id, build.reason);
      return;
    }
    this.db.updateBuildJob(job.id, { prUrl: build.prUrl });
    this.db.setBuildJobStatus(job.id, 'pr_open');
    const fresh = this.db.getBuildJob(job.id) ?? job;
    this.note(fresh, { event: 'pr_opened', prUrl: build.prUrl, summary: build.summary });
    console.log(`[builder] guild=${job.guildId} job=${job.id} PR opened: ${build.prUrl}`);
    void this.react(fresh, fresh.planMessageId, DONE);
    await this.post(fresh, buildPrOpenedCard({ title: fresh.title ?? '', prUrl: build.prUrl, summary: build.summary, usage: this.usageOf(fresh) }), fresh.planMessageId);
  }

  // ---- startup: recovery + PR tracking -----------------------------------

  start(): void {
    const go = (): void => {
      this.updatePresence();
      void this.recover().catch((err) => console.error('[builder] recovery failed:', err));
      void this.pollPrs();
      this.prTimer = setInterval(() => void this.pollPrs(), PR_POLL_MS);
      // Cheap DB check: also picks up a raised maxParallelBuilds from the dashboard.
      this.queueTimer = setInterval(() => this.drainQueue(), QUEUE_TICK_MS);
    };
    if (this.client.isReady()) go();
    else this.client.once(Events.ClientReady, go);
  }

  stop(): void {
    this.stopped = true;
    this.chat.stop();
    if (this.prTimer) clearInterval(this.prTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.prTimer = null;
    this.queueTimer = null;
  }

  /**
   * Jobs that were planning/building when the bot went down: pick up their sessions again. Recovering
   * builds keep status `building`, so they count against the build slots when the queue is drained.
   */
  async recover(): Promise<void> {
    const jobs = this.db.listBuildJobsByStatus(['planning', 'building']);
    for (const job of jobs) {
      if (!this.configured) {
        await this.fail(job.id, 'The bot restarted and the OpenCode agent is no longer configured.');
        continue;
      }
      const s = this.state(job.id);
      s.busy = true;
      // Run each recovery in the background so one long build doesn't delay the others or startup.
      void this.recoverJob(job, s).finally(() => {
        s.busy = false;
        this.drainQueue();
      });
    }
    this.drainQueue();
    this.updatePresence();
  }

  private async recoverJob(job: BuildJob, s: JobState): Promise<void> {
    const kind = job.status === 'building' ? 'build' : 'plan';
    // A building job that already has a PR and a fix attempt was a conflict-fix run.
    const fix = kind === 'build' && job.prUrl !== null && job.fixAttempts > 0;
    const giveUp = (reason: string): Promise<void> => (fix ? this.failFix(job.id, reason) : this.fail(job.id, reason));
    // Reactions while recovering: 📝 on the triggering message until a plan was posted; 🔨 for builds and fixes.
    const planning = kind === 'plan' && job.planPostedAt === null;
    const added = planning ? this.react(job, job.triggerMessageId, PLANNING) : Promise.resolve();
    if (kind === 'build') this.buildStarted(job);
    try {
      if (!job.sessionId || !(await this.getAgent().sessionExists(job.sessionId))) {
        await giveUp('The bot restarted while this request was being set up, and its agent session could not be recovered. Please ask again.');
        return;
      }
      console.log(`[builder] guild=${job.guildId} job=${job.id} recovering ${job.status} session ${job.sessionId}`);
      const agent = this.getAgent();
      const timeout = kind === 'build' ? BUILD_TIMEOUT_MS : PLAN_TIMEOUT_MS;
      await agent.waitIdle(job.sessionId, timeout, undefined, () => this.saveUsage(job));
      let reply = await agent.latestReply(job.sessionId);
      let lastIsAssistant = await agent.lastIsAssistant(job.sessionId);
      for (;;) {
        const current = this.db.getBuildJob(job.id) ?? job;
        const decision = decideRecovery({ kind, reply, lastIsAssistant, resumeCount: current.resumeCount });
        if (decision.action === 'handle') break;
        if (decision.action === 'fail') {
          await giveUp(decision.reason);
          return;
        }
        this.db.updateBuildJob(job.id, { resumeCount: current.resumeCount + 1 });
        console.log(`[builder] guild=${job.guildId} job=${job.id} resuming ${kind} session (attempt ${current.resumeCount + 1})`);
        this.note(current, { event: 'resumed' });
        await this.post(current, buildResumingCard(current.title ?? ''));
        // Old jobs (no planSessionId) build in the shared planner session, which still needs the agent switch.
        if (kind === 'build' && current.planSessionId === null) await agent.switchAgent(job.sessionId, 'feature-build');
        let prompt = kind === 'build' ? (fix ? `${BUILD_RESUME_PROMPT} This run was resolving merge conflicts on ${job.prUrl}.` : BUILD_RESUME_PROMPT) : PLAN_RESUME_PROMPT;
        // The fresh build session was created but never got its first prompt: send the plan instead of a resume hint.
        if (kind === 'build' && !fix && current.planSessionId !== null && !lastIsAssistant && reply.text === '' && current.lastPlan?.trim()) {
          prompt = buildPrompt({ request: current.request, title: current.title, plan: current.lastPlan });
        }
        reply = await agent.promptAndWait(job.sessionId, prompt, timeout, undefined, () => this.saveUsage(job));
        lastIsAssistant = true;
      }
      await this.saveUsage(job);
      const fresh = this.db.getBuildJob(job.id) ?? job;
      if (fix) await this.handleFixReply(fresh, reply);
      else if (kind === 'build') await this.handleBuildReply(fresh, reply);
      else await this.handlePlanReply(fresh, reply, Date.now(), job.triggerMessageId);
    } catch (err) {
      console.error(`[builder] guild=${job.guildId} job=${job.id} recovery failed:`, err);
      await giveUp(err instanceof Error ? err.message : String(err));
    } finally {
      if (planning) {
        await added;
        await this.unreact(job, job.triggerMessageId, PLANNING);
      }
      if (kind === 'build') await this.buildEnded(job.id);
      const status = this.db.getBuildJob(job.id)?.status;
      if (status !== 'awaiting_input' && status !== 'planning') {
        s.preContext.length = 0;
        s.followUps.length = 0;
      }
    }
  }

  async pollPrs(): Promise<void> {
    if (this.pollingPrs || this.stopped) return;
    this.pollingPrs = true;
    try {
      for (const job of this.db.listBuildJobsByStatus(['pr_open'])) {
        const ref = job.prUrl ? parsePrUrl(job.prUrl) : null;
        if (!ref) {
          console.warn(`[builder] guild=${job.guildId} job=${job.id} has no valid PR url: ${job.prUrl ?? 'none'}`);
          continue;
        }
        try {
          const info = await this.fetchPrInfo(ref);
          if (info === 'rate-limited') {
            console.warn('[builder] GitHub rate limit hit, will retry next round');
            break;
          }
          if (info.state === 'merged') {
            this.db.setBuildJobStatus(job.id, 'merged');
            this.note(job, { event: 'merged', prUrl: job.prUrl });
            console.log(`[builder] guild=${job.guildId} job=${job.id} PR merged`);
            await this.post(job, buildMergedCard({ title: job.title ?? '', prUrl: job.prUrl as string, usage: this.usageOf(job) }));
          } else if (info.state === 'closed') {
            this.db.setBuildJobStatus(job.id, 'closed');
            this.note(job, { event: 'closed', prUrl: job.prUrl });
            console.log(`[builder] guild=${job.guildId} job=${job.id} PR closed without merge`);
            await this.post(job, buildClosedCard({ title: job.title ?? '', prUrl: job.prUrl as string, usage: this.usageOf(job) }));
          } else {
            await this.checkConflict(job, info);
          }
        } catch (err) {
          console.warn(`[builder] guild=${job.guildId} job=${job.id} PR check failed:`, err instanceof Error ? err.message : err);
        }
      }
    } finally {
      this.pollingPrs = false;
    }
  }

  /** An open PR: start the one automatic conflict fix, or post the manual-merge card once. */
  private async checkConflict(job: BuildJob, info: PrInfo): Promise<void> {
    const slotFree = freeSlots(this.db.countBuildingJobs(), this.db.getBuilderSettings().maxParallelBuilds) > 0;
    const action = conflictAction({
      conflict: info.mergeability,
      fixAttempts: job.fixAttempts,
      notified: job.conflictNotified,
      slotFree,
      sinceUpdateMs: Date.now() - job.updatedAt,
    });
    if (action === 'fix') {
      if (!this.configured || !job.sessionId) {
        this.db.updateBuildJob(job.id, { fixAttempts: job.fixAttempts + 1 });
        await this.failFix(job.id, 'The agent session is not available to resolve the conflicts.');
        return;
      }
      const denial = await this.limitDenial();
      if (denial) {
        // Still conflicted: the next poll round (every 2 min) tries again once the limit resets.
        console.warn(`[builder] guild=${job.guildId} job=${job.id} conflict fix waits: ${denial}`);
        return;
      }
      this.launchFix(job);
    } else if (action === 'wait') {
      console.log(`[builder] guild=${job.guildId} job=${job.id} PR has conflicts, waiting for a free build slot`);
    } else if (action === 'notify') {
      this.db.updateBuildJob(job.id, { conflictNotified: true });
      this.note(job, { event: 'conflict_failed', prUrl: job.prUrl });
      await this.post(job, buildConflictManualCard({ title: job.title ?? '', prUrl: job.prUrl as string, reason: job.error ?? undefined }));
    }
  }
}

async function fetchPrInfo(ref: PrRef): Promise<PrInfo | 'rate-limited'> {
  const res = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'bojan-bot', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403 || res.status === 429) return 'rate-limited';
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return prInfoFromJson((await res.json()) as Parameters<typeof prInfoFromJson>[0]);
}
