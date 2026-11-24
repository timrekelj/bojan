import { Events, type Client, type SendableChannels } from 'discord.js';
import { config } from '../config.js';
import type { BotDatabase, BuildJob } from '../db.js';
import {
  buildBuildingCard,
  buildCancelledCard,
  buildClosedCard,
  buildFailedCard,
  buildMergedCard,
  buildNoteCard,
  buildPlanCard,
  buildPrOpenedCard,
  type BuilderMessage,
} from './cards.js';
import { estimateCostUsd, getGoPrices, goPriceFor } from './pricing.js';
import { OpenCodeAgent, REPO_DIR, type AgentReply } from './opencode.js';
import { normalizeBuildResult, normalizePlanResult, parseAgentReply, parseModelRef, parsePrUrl, prStateFromJson, type PrRef, type PrState } from './parse.js';

const PLAN_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 90 * 60_000;
const PR_POLL_MS = 2 * 60_000;
const TYPING_MS = 8_000;

interface JobState {
  busy: boolean;
  buffer: string[];
}

/** First ~500 chars of the visible text, for failure messages. */
function excerpt(text: string): string {
  const t = text.trim();
  return t.length > 500 ? `${t.slice(0, 500)}…` : t;
}

export class BuilderRunner {
  private agent: OpenCodeAgent | null = null;
  private readonly states = new Map<number, JobState>();
  private prTimer: NodeJS.Timeout | null = null;
  private pollingPrs = false;
  private stopped = false;
  /** Set synchronously while a new job is being set up, so two quick mentions can't both start one. */
  private starting = false;

  constructor(
    private readonly client: Client,
    private readonly db: BotDatabase,
  ) {}

  /** True when the OpenCode password is configured (the dashboard switch is checked separately). */
  get configured(): boolean {
    return config.opencodePassword !== null;
  }

  /**
   * Reserve the single builder slot. On success the caller must hand it over by calling `startJob`
   * (which releases it) or call `release()` if it gives up. On failure, `active` is the job holding
   * the slot (null while another request is still being set up).
   */
  reserve(): { ok: true } | { ok: false; active: BuildJob | null } {
    const active = this.db.activeBuildJob(config.guildId);
    if (active) return { ok: false, active };
    if (this.starting) return { ok: false, active: null };
    this.starting = true;
    return { ok: true };
  }

  release(): void {
    this.starting = false;
  }

  private getAgent(): OpenCodeAgent {
    if (!config.opencodePassword) throw new Error('OPENCODE_PASSWORD is not set');
    this.agent ??= new OpenCodeAgent(config.opencodeUrl, config.opencodePassword);
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
  startJob(input: { threadId: string; channelId: string; requesterId: string; requesterName: string; request: string }): BuildJob {
    try {
      const job = this.db.createBuildJob({ guildId: config.guildId, threadId: input.threadId, channelId: input.channelId, requesterId: input.requesterId, request: input.request });
      console.log(`[builder] guild=${job.guildId} job=${job.id} started by ${input.requesterId}: ${input.request.slice(0, 120)}`);
      const prompt =
        `Feature request from Discord user "${input.requesterName}". Replies in this conversation come from the Discord thread, ` +
        `so keep your visible text short and plain.\n\n${input.request}`;
      this.enqueue(job.id, prompt);
      return job;
    } finally {
      this.release();
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

  private fail(jobId: number, reason: string): Promise<void> {
    this.db.updateBuildJob(jobId, { error: reason.slice(0, 2000) });
    this.db.setBuildJobStatus(jobId, 'failed');
    const job = this.db.getBuildJob(jobId);
    if (!job) return Promise.resolve();
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
      await this.post(job, buildCancelledCard(this.usageOf(this.db.getBuildJob(job.id) ?? job)));
      return;
    }
    if (plan.status === 'needs_input') {
      this.db.setBuildJobStatus(job.id, 'awaiting_input');
      await this.post(job, buildPlanCard({ title, plan: plan.plan, questions: plan.questions, visible }));
      return;
    }
    // approved
    this.db.setBuildJobStatus(job.id, 'building');
    await this.post(job, buildBuildingCard(title));
    await this.runBuild(this.db.getBuildJob(job.id) ?? job);
  }

  private async runBuild(job: BuildJob): Promise<void> {
    const agent = this.getAgent();
    await agent.switchAgent(job.sessionId as string, 'feature-build');
    const reply = await agent.promptAndWait(job.sessionId as string, 'The user approved the plan above. Implement it now following your instructions.', BUILD_TIMEOUT_MS);
    await this.saveUsage(job);
    await this.handleBuildReply(this.db.getBuildJob(job.id) ?? job, reply);
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
    console.log(`[builder] guild=${job.guildId} job=${job.id} PR opened: ${build.prUrl}`);
    await this.post(fresh, buildPrOpenedCard({ title: fresh.title ?? '', prUrl: build.prUrl, summary: build.summary, usage: this.usageOf(fresh) }));
  }

  // ---- startup: recovery + PR tracking -----------------------------------

  start(): void {
    const go = (): void => {
      void this.recover().catch((err) => console.error('[builder] recovery failed:', err));
      void this.pollPrs();
      this.prTimer = setInterval(() => void this.pollPrs(), PR_POLL_MS);
    };
    if (this.client.isReady()) go();
    else this.client.once(Events.ClientReady, go);
  }

  stop(): void {
    this.stopped = true;
    if (this.prTimer) clearInterval(this.prTimer);
    this.prTimer = null;
  }

  /** Jobs that were planning/building when the bot went down: pick up their sessions again. */
  private async recover(): Promise<void> {
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
      });
    }
  }

  private async recoverJob(job: BuildJob, s: JobState): Promise<void> {
    const stopTyping = this.typing(job);
    try {
      if (!job.sessionId || !(await this.getAgent().sessionExists(job.sessionId))) {
        await this.fail(job.id, 'The bot restarted while this request was being set up, and its agent session could not be recovered. Please ask again.');
        return;
      }
      console.log(`[builder] guild=${job.guildId} job=${job.id} recovering ${job.status} session ${job.sessionId}`);
      const agent = this.getAgent();
      await agent.waitIdle(job.sessionId, job.status === 'building' ? BUILD_TIMEOUT_MS : PLAN_TIMEOUT_MS);
      const reply = await agent.latestReply(job.sessionId);
      await this.saveUsage(job);
      const fresh = this.db.getBuildJob(job.id) ?? job;
      if (job.status === 'building') await this.handleBuildReply(fresh, reply);
      else await this.handlePlanReply(fresh, reply);
    } catch (err) {
      console.error(`[builder] guild=${job.guildId} job=${job.id} recovery failed:`, err);
      await this.fail(job.id, err instanceof Error ? err.message : String(err));
    } finally {
      stopTyping();
      if (this.db.getBuildJob(job.id)?.status !== 'awaiting_input' && this.db.getBuildJob(job.id)?.status !== 'planning') s.buffer.length = 0;
    }
  }

  private async pollPrs(): Promise<void> {
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
          const state = await fetchPrState(ref);
          if (state === 'rate-limited') {
            console.warn('[builder] GitHub rate limit hit, will retry next round');
            break;
          }
          if (state === 'merged') {
            this.db.setBuildJobStatus(job.id, 'merged');
            console.log(`[builder] guild=${job.guildId} job=${job.id} PR merged`);
            await this.post(job, buildMergedCard({ title: job.title ?? '', prUrl: job.prUrl as string, usage: this.usageOf(job) }));
          } else if (state === 'closed') {
            this.db.setBuildJobStatus(job.id, 'closed');
            console.log(`[builder] guild=${job.guildId} job=${job.id} PR closed without merge`);
            await this.post(job, buildClosedCard({ title: job.title ?? '', prUrl: job.prUrl as string, usage: this.usageOf(job) }));
          }
        } catch (err) {
          console.warn(`[builder] guild=${job.guildId} job=${job.id} PR check failed:`, err instanceof Error ? err.message : err);
        }
      }
    } finally {
      this.pollingPrs = false;
    }
  }
}

async function fetchPrState(ref: PrRef): Promise<PrState> {
  const res = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'bojan-bot', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403 || res.status === 429) return 'rate-limited';
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return prStateFromJson((await res.json()) as { state?: unknown; merged?: unknown; merged_at?: unknown });
}
