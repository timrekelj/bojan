import { Events, type Client, type SendableChannels } from 'discord.js';
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
import { estimateCostUsd, getGoPrices, goPriceFor } from './pricing.js';
import { OpenCodeAgent, REPO_DIR, type AgentReply } from './opencode.js';
import { formatBuildNote, type BuildNoteInfo } from './chat-parse.js';
import { normalizeBuildResult, normalizePlanResult, parseAgentReply, parseModelRef, parsePrUrl, prInfoFromJson, type PrInfo, type PrRef } from './parse.js';
import { BUILD_RESUME_PROMPT, PLAN_RESUME_PROMPT, conflictAction, conflictFixPrompt, decideRecovery, freeSlots, pickJobsToStart, queuePosition } from './queue.js';

const PLAN_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 90 * 60_000;
const PR_POLL_MS = 2 * 60_000;
const TYPING_MS = 8_000;
const QUEUE_TICK_MS = 30_000;

interface JobState {
  busy: boolean;
  buffer: string[];
}

/** First ~500 chars of the visible text, for failure messages. */
function excerpt(text: string): string {
  const t = text.trim();
  return t.length > 500 ? `${t.slice(0, 500)}…` : t;
}

/** The part of OpenCodeAgent the runner uses (lets tests plug in a fake). */
export type AgentApi = Pick<OpenCodeAgent, 'warm' | 'createWorktree' | 'createSession' | 'switchAgent' | 'sessionExists' | 'waitIdle' | 'latestReply' | 'lastIsAssistant' | 'usage' | 'promptAndWait'>;

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

  private getAgent(): AgentApi {
    if (this.agent) return this.agent;
    if (!config.opencodePassword) throw new Error('OPENCODE_PASSWORD is not set');
    this.agent = new OpenCodeAgent(config.opencodeUrl, config.opencodePassword);
    return this.agent;
  }

  private state(jobId: number): JobState {
    let s = this.states.get(jobId);
    if (!s) {
      s = { busy: false, buffer: [] };
      this.states.set(jobId, s);
    }
    return s;
  }

  // ---- entry points ---------------------------------------------------

  /** A new request whose thread already exists. Takes over the slot reserved with `reserve()`. */
  startJob(input: { threadId: string; channelId: string; requesterId: string; requesterName: string; request: string; context?: string }): BuildJob {
    try {
      const job = this.db.createBuildJob({ guildId: config.guildId, threadId: input.threadId, channelId: input.channelId, requesterId: input.requesterId, request: input.request });
      console.log(`[builder] guild=${job.guildId} job=${job.id} started by ${input.requesterId}: ${input.request.slice(0, 120)}`);
      const prompt =
        `Feature request from Discord user "${input.requesterName}". Replies in this conversation come from the Discord thread, ` +
        `so keep your visible text short and plain.\n\n${input.request}` +
        (input.context ? `\n\nRecent messages in the thread (oldest first, for context):\n${input.context}` : '');
      this.enqueue(job.id, prompt);
      return job;
    } finally {
      this.release(input.threadId);
    }
  }

  /** A thread message for a job that is planning or awaiting input. */
  handleReply(job: BuildJob, authorName: string, text: string): void {
    this.enqueue(job.id, `${authorName}: ${text}`);
  }

  // ---- per-job serialization -------------------------------------------

  private enqueue(jobId: number, text: string): void {
    const s = this.state(jobId);
    s.buffer.push(text);
    if (s.busy) return;
    s.busy = true;
    void this.drain(jobId, s);
  }

  private async drain(jobId: number, s: JobState): Promise<void> {
    try {
      while (s.buffer.length > 0 && !this.stopped) {
        const prompt = s.buffer.splice(0).join('\n\n');
        await this.runTurn(jobId, prompt);
        const status = this.db.getBuildJob(jobId)?.status;
        // Anything typed while the agent was busy only makes sense if we are still planning.
        if (status !== 'awaiting_input' && status !== 'planning') s.buffer.length = 0;
      }
    } finally {
      s.busy = false;
      if (s.buffer.length > 0 && !this.stopped) this.enqueue(jobId, s.buffer.splice(0).join('\n\n'));
    }
  }

  // ---- discord helpers --------------------------------------------------

  private async post(job: BuildJob, message: BuilderMessage): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(job.threadId);
      if (!channel || !channel.isSendable()) {
        console.warn(`[builder] guild=${job.guildId} job=${job.id} thread ${job.threadId} is not sendable`);
        return;
      }
      await (channel as SendableChannels).send(message);
    } catch (err) {
      console.error(`[builder] guild=${job.guildId} job=${job.id} could not post to thread:`, err);
    }
  }

  /** Keep the typing indicator alive until the returned function is called. */
  private typing(job: BuildJob): () => void {
    let channel: SendableChannels | null = null;
    const tick = async (): Promise<void> => {
      try {
        channel ??= await this.client.channels.fetch(job.threadId).then((c) => (c && c.isSendable() ? (c as SendableChannels) : null));
        await channel?.sendTyping();
      } catch {
        // typing is cosmetic
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), TYPING_MS);
    return () => clearInterval(timer);
  }

  // ---- turns ------------------------------------------------------------

  /** Tell the thread's chat session (if it has one) what happened; delivered with its next prompt, no model call now. */
  private note(job: BuildJob, info: Omit<BuildNoteInfo, 'jobId' | 'title'>): void {
    const fresh = this.db.getBuildJob(job.id) ?? job;
    this.db.addChatNote(job.threadId, formatBuildNote({ ...info, jobId: job.id, title: fresh.title }));
  }

  private fail(jobId: number, reason: string): Promise<void> {
    this.db.updateBuildJob(jobId, { error: reason.slice(0, 2000) });
    this.db.setBuildJobStatus(jobId, 'failed');
    const job = this.db.getBuildJob(jobId);
    if (!job) return Promise.resolve();
    this.note(job, { event: 'failed', reason });
    return this.post(job, buildFailedCard({ reason, usage: this.usageOf(job) }));
  }

  private usageOf(job: BuildJob): { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; costUsd: number } | null {
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
    if (!job.sessionId) return;
    try {
      const usage = await this.getAgent().usage(job.sessionId);
      if (usage.costUsd === 0) {
        // OpenCode reports no cost for Go models: store a list-price estimate instead.
        const price = goPriceFor(this.db.getBuildJob(job.id)?.model, await getGoPrices());
        if (price) usage.costUsd = estimateCostUsd(usage, price);
      }
      this.db.setBuildJobUsage(job.id, usage);
    } catch (err) {
      console.warn(`[builder] guild=${job.guildId} job=${job.id} could not read usage:`, err instanceof Error ? err.message : err);
    }
  }

  /** One planning turn: set up on the first call, then prompt the planner and handle its reply. */
  private async runTurn(jobId: number, prompt: string): Promise<void> {
    let job = this.db.getBuildJob(jobId);
    if (!job) return;
    const stopTyping = this.typing(job);
    try {
      this.db.setBuildJobStatus(jobId, 'planning');
      if (!job.sessionId) job = await this.setup(job);
      const reply = await this.getAgent().promptAndWait(job.sessionId as string, prompt, PLAN_TIMEOUT_MS);
      await this.saveUsage(job);
      await this.handlePlanReply(this.db.getBuildJob(jobId) ?? job, reply);
    } catch (err) {
      console.error(`[builder] guild=${job.guildId} job=${job.id} turn failed:`, err);
      await this.fail(jobId, err instanceof Error ? err.message : String(err));
    } finally {
      stopTyping();
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

  private async handlePlanReply(job: BuildJob, reply: AgentReply): Promise<void> {
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
      await this.post(job, buildNoteCard(visible));
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
    if (plan.status === 'needs_input') {
      this.db.setBuildJobStatus(job.id, 'awaiting_input');
      await this.post(job, buildPlanCard({ title, plan: plan.plan, questions: plan.questions, visible }));
      return;
    }
    // approved: build now when a slot is free (and nobody is waiting ahead), otherwise queue up
    this.db.updateBuildJob(job.id, { approvedAt: Date.now() });
    const slotFree = freeSlots(this.db.countBuildingJobs(), this.db.getBuilderSettings().maxParallelBuilds) > 0;
    if (slotFree && this.db.listBuildJobsByStatus(['queued']).length === 0) {
      this.launchBuild(this.db.getBuildJob(job.id) ?? job, plan.plan);
      return;
    }
    this.db.setBuildJobStatus(job.id, 'queued');
    const queued = this.db.getBuildJob(job.id) ?? job;
    const position = queuePosition(this.db.listBuildJobsByStatus(['queued']), job.id);
    console.log(`[builder] guild=${job.guildId} job=${job.id} approved, queued #${position}`);
    this.note(queued, { event: 'queued', plan: plan.plan, position });
    await this.post(queued, buildQueuedCard({ title, position }));
  }

  /** Start queued jobs (FIFO) while build slots are free. Synchronous, so slots can't be double-booked. */
  drainQueue(): void {
    if (this.stopped || !this.configured) return;
    const building = this.db.countBuildingJobs();
    const max = this.db.getBuilderSettings().maxParallelBuilds;
    for (const job of pickJobsToStart(this.db.listBuildJobsByStatus(['queued']), building, max)) {
      console.log(`[builder] guild=${job.guildId} job=${job.id} leaving the queue, building now`);
      this.launchBuild(job);
    }
  }

  /** Take a build slot (status `building`) and run the build in the background. */
  private launchBuild(job: BuildJob, plan?: string): void {
    this.db.setBuildJobStatus(job.id, 'building');
    this.note(job, { event: 'approved', plan });
    void this.inBackground(job, async (fresh) => {
      await this.post(fresh, buildBuildingCard(fresh.title ?? ''));
      await this.runBuild(fresh);
    }, (reason) => this.fail(job.id, reason));
  }

  /** Run a slot-holding task: typing indicator, failure handling, and start the next queued job afterwards. */
  private async inBackground(job: BuildJob, task: (fresh: BuildJob) => Promise<void>, onError: (reason: string) => Promise<void>): Promise<void> {
    const stopTyping = this.typing(job);
    try {
      await task(this.db.getBuildJob(job.id) ?? job);
    } catch (err) {
      console.error(`[builder] guild=${job.guildId} job=${job.id} background run failed:`, err);
      await onError(err instanceof Error ? err.message : String(err)).catch(() => undefined);
    } finally {
      stopTyping();
      this.drainQueue();
    }
  }

  private async runBuild(job: BuildJob): Promise<void> {
    const agent = this.getAgent();
    await agent.switchAgent(job.sessionId as string, 'feature-build');
    const reply = await agent.promptAndWait(job.sessionId as string, 'The user approved the plan above. Implement it now following your instructions.', BUILD_TIMEOUT_MS);
    await this.saveUsage(job);
    await this.handleBuildReply(this.db.getBuildJob(job.id) ?? job, reply);
  }

  // ---- merge conflict fix ---------------------------------------------------

  /** The single automatic attempt: the job takes a build slot again and the agent merges main into its branch. */
  private launchFix(job: BuildJob): void {
    this.db.updateBuildJob(job.id, { fixAttempts: job.fixAttempts + 1 });
    this.db.setBuildJobStatus(job.id, 'building');
    const fresh = this.db.getBuildJob(job.id) ?? job;
    console.log(`[builder] guild=${job.guildId} job=${job.id} PR ${job.prUrl} has conflicts, trying to fix`);
    this.note(fresh, { event: 'conflict_fix_started', prUrl: job.prUrl });
    void this.inBackground(fresh, async (f) => {
      await this.post(f, buildConflictFixCard(f.title ?? ''));
      const agent = this.getAgent();
      await agent.switchAgent(f.sessionId as string, 'feature-build');
      const reply = await agent.promptAndWait(f.sessionId as string, conflictFixPrompt(f.prUrl as string), BUILD_TIMEOUT_MS);
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
    await this.post(fresh, buildPrOpenedCard({ title: fresh.title ?? '', prUrl: build.prUrl, summary: build.summary, usage: this.usageOf(fresh) }));
  }

  // ---- startup: recovery + PR tracking -----------------------------------

  start(): void {
    const go = (): void => {
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
        if (s.buffer.length > 0 && !this.stopped) this.enqueue(job.id, s.buffer.splice(0).join('\n\n'));
        this.drainQueue();
      });
    }
    this.drainQueue();
  }

  private async recoverJob(job: BuildJob, s: JobState): Promise<void> {
    const kind = job.status === 'building' ? 'build' : 'plan';
    // A building job that already has a PR and a fix attempt was a conflict-fix run.
    const fix = kind === 'build' && job.prUrl !== null && job.fixAttempts > 0;
    const giveUp = (reason: string): Promise<void> => (fix ? this.failFix(job.id, reason) : this.fail(job.id, reason));
    const stopTyping = this.typing(job);
    try {
      if (!job.sessionId || !(await this.getAgent().sessionExists(job.sessionId))) {
        await giveUp('The bot restarted while this request was being set up, and its agent session could not be recovered. Please ask again.');
        return;
      }
      console.log(`[builder] guild=${job.guildId} job=${job.id} recovering ${job.status} session ${job.sessionId}`);
      const agent = this.getAgent();
      const timeout = kind === 'build' ? BUILD_TIMEOUT_MS : PLAN_TIMEOUT_MS;
      await agent.waitIdle(job.sessionId, timeout);
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
        if (kind === 'build') await agent.switchAgent(job.sessionId, 'feature-build');
        const prompt = kind === 'build' ? (fix ? `${BUILD_RESUME_PROMPT} This run was resolving merge conflicts on ${job.prUrl}.` : BUILD_RESUME_PROMPT) : PLAN_RESUME_PROMPT;
        reply = await agent.promptAndWait(job.sessionId, prompt, timeout);
        lastIsAssistant = true;
      }
      await this.saveUsage(job);
      const fresh = this.db.getBuildJob(job.id) ?? job;
      if (fix) await this.handleFixReply(fresh, reply);
      else if (kind === 'build') await this.handleBuildReply(fresh, reply);
      else await this.handlePlanReply(fresh, reply);
    } catch (err) {
      console.error(`[builder] guild=${job.guildId} job=${job.id} recovery failed:`, err);
      await giveUp(err instanceof Error ? err.message : String(err));
    } finally {
      stopTyping();
      const status = this.db.getBuildJob(job.id)?.status;
      if (status !== 'awaiting_input' && status !== 'planning') s.buffer.length = 0;
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
