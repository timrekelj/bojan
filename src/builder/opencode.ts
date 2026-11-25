// Thin wrapper around @opencode/client for the self-building feature.
// Deliberately free of config/db imports so it can be exercised standalone.
import { OpenCode } from '@opencode/client';
import type { GoLimits } from './limits.js';
import type { TokenUsage } from './pricing.js';
import { branchName, worktreeDirFor, type ModelRef } from './parse.js';
import type { PromptImage } from './chat-parse.js';

export const REPO_DIR = '/workspace/bojan';

export interface AgentReply {
  /** Id of the assistant message the reply came from (null when there is none). */
  id: string | null;
  /** Concatenated text parts of the newest assistant message ('' when none). */
  text: string;
  finish: string | null;
  /** Provider/runtime error attached to the reply, formatted for humans. */
  error: string | null;
}

export type SessionUsage = TokenUsage;

/** Structural subset of an OpenCode session message, enough to extract a reply. */
export interface MessageLike {
  id?: string;
  type: string;
  content?: ReadonlyArray<{ type: string; text?: string }>;
  finish?: string;
  error?: { type?: string; message?: string };
}

/** Pick the newest assistant message (list is newest-first) and flatten its text parts. */
export function extractReply(messages: readonly MessageLike[]): AgentReply {
  const m = messages.find((x) => x.type === 'assistant');
  if (!m) return { id: null, text: '', finish: null, error: null };
  const text = (m.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim();
  const error = m.error ? `${m.error.type ?? 'error'}: ${m.error.message ?? 'unknown error'}` : m.finish === 'error' ? 'The model run ended with an error.' : null;
  return { id: m.id ?? null, text, finish: m.finish ?? null, error };
}

/** Newest-first list: is the newest `user`/`assistant` message an assistant one? (true when there is none) */
export function lastConversationIsAssistant(messages: readonly MessageLike[]): boolean {
  const m = messages.find((x) => x.type === 'user' || x.type === 'assistant');
  return !m || m.type === 'assistant';
}

export type GoLimitMeter = GoLimits['rolling'];

export interface AgentStatus {
  reachable: boolean;
  version: string | null;
  error: string | null;
  /** OpenCode Go plan meters; null when unavailable. */
  limits: GoLimits | null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Probe the agent server for the dashboard: version, plus Go usage limits when available (never throws). */
export async function probeAgent(baseUrl: string, password: string, timeoutMs = 3000): Promise<AgentStatus> {
  const agent = new OpenCodeAgent(baseUrl, password);
  let version: string;
  try {
    version = (await withTimeout(agent.client.server.info(), timeoutMs)).version;
  } catch (err) {
    return { reachable: false, version: null, error: err instanceof Error ? err.message : String(err), limits: null };
  }
  return { reachable: true, version, error: null, limits: await agent.limitMeters(REPO_DIR, timeoutMs) };
}

export class AgentTimeoutError extends Error {}

/** Max length of a single `session.wait` request; shorter than fetch's own 5 minute header timeout. */
const WAIT_SLICE_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class OpenCodeAgent {
  readonly client: ReturnType<typeof OpenCode.make>;

  constructor(baseUrl: string, password: string) {
    this.client = OpenCode.make({
      baseUrl,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
    });
  }

  /** Right after server boot a location can briefly list no agents: retry until it does. */
  async warm(directory: string, attempts = 15): Promise<void> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.client.agent.list({ location: { directory } });
        if (res.data.length > 0) return;
      } catch (err) {
        last = err;
      }
      await sleep(1000);
    }
    throw new Error(`OpenCode location ${directory} did not become ready${last instanceof Error ? `: ${last.message}` : ''}`);
  }

  /** OpenCode Go plan meters; null when the call fails or the location has no Go plan (never throws). */
  async limitMeters(directory = REPO_DIR, timeoutMs = 3000): Promise<GoLimits | null> {
    try {
      const res = await withTimeout(this.client.experimental.usage.limits({ location: { directory } }), timeoutMs);
      const go = res.data?.go;
      return go ? { rolling: go.rolling, weekly: go.weekly, monthly: go.monthly } : null;
    } catch {
      return null;
    }
  }

  /** Run a shell command in the agent container and return its output; throws on non-zero exit. */
  async shell(directory: string, command: string, timeoutMs = 180_000): Promise<string> {
    const location = { directory };
    const created = await this.client.shell.create({ location, cwd: directory, command, timeout: timeoutMs });
    const id = created.data.id;
    const deadline = Date.now() + timeoutMs + 10_000;
    let exit: number | undefined;
    let status: string = created.data.status;
    while (status === 'running') {
      if (Date.now() > deadline) throw new AgentTimeoutError(`shell command timed out: ${command}`);
      await sleep(500);
      const got = await this.client.shell.get({ id, location });
      status = got.data.status;
      exit = got.data.exit;
    }
    const out = await this.client.shell.output({ id, location });
    await this.client.shell.remove({ id, location }).catch(() => undefined);
    if (status !== 'exited' || (exit ?? 0) !== 0) {
      throw new Error(`shell command failed (${status}, exit ${exit ?? '?'}): ${out.data.output.slice(-600)}`);
    }
    return out.data.output;
  }

  /**
   * New git worktree `/workspace/jobs/<id>` on branch `bot/<id>` from fresh origin/main.
   * (Done with git directly: the worktree API treats `branch`/`from` as existing refs.)
   */
  async createWorktree(jobId: number): Promise<{ directory: string; branch: string }> {
    const directory = worktreeDirFor(jobId);
    const branch = branchName(jobId);
    await this.shell(REPO_DIR, `git fetch --prune origin && git worktree add --no-track -b ${branch} ${directory} origin/main`);
    return { directory, branch };
  }

  /**
   * Bring the main checkout to the current origin/main (hard reset: nobody edits it, builds use
   * worktrees). Existing worktrees are untouched. Failures are logged and ignored.
   */
  async refreshMain(): Promise<void> {
    try {
      await this.shell(REPO_DIR, 'git fetch --prune origin && git checkout --quiet --force -B main origin/main', 60_000);
    } catch (err) {
      console.warn('[chat] could not update the main checkout:', err instanceof Error ? err.message : err);
    }
  }

  async createSession(opts: { directory: string; agent: string; model: ModelRef; title: string; metadata?: Record<string, string | number> }): Promise<string> {
    const session = await this.client.session.create({
      location: { directory: opts.directory },
      agent: opts.agent,
      model: { providerID: opts.model.providerID, id: opts.model.id },
      title: opts.title.slice(0, 200),
      metadata: opts.metadata ?? null,
    });
    return session.id;
  }

  async switchAgent(sessionID: string, agent: string): Promise<void> {
    await this.client.session.switchAgent({ sessionID, agent });
  }

  async sessionExists(sessionID: string): Promise<boolean> {
    try {
      await this.client.session.get({ sessionID });
      return true;
    } catch {
      return false;
    }
  }

  /** Stop whatever the session is running. Returns false when nothing was running. */
  async interrupt(sessionID: string): Promise<boolean> {
    const res = await this.client.session.interrupt({ sessionID });
    return res.interrupted;
  }

  async isRunning(sessionID: string): Promise<boolean> {
    const active = await this.client.session.active();
    return sessionID in active;
  }

  /**
   * Wait until the session stops. `wait` may give up on long runs (proxy/idle timeouts), so
   * it is called again until the session is no longer active, up to `timeoutMs` overall.
   */
  async waitIdle(sessionID: string, timeoutMs: number, settleMs = 3000, onProgress?: () => Promise<void> | void): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const started = Date.now();
    const progress = async (): Promise<void> => {
      try {
        await onProgress?.();
      } catch {
        // progress reporting must never break the wait
      }
    };
    for (;;) {
      if (Date.now() > deadline) throw new AgentTimeoutError(`agent did not finish within ${Math.round(timeoutMs / 60_000)} minutes`);
      // Every call is bounded by us: a hanging request would otherwise be cut by fetch after ~5 min with a noisy error.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), WAIT_SLICE_MS);
      try {
        await this.client.experimental.session.wait({ sessionID }, { signal: ctrl.signal });
      } catch (err) {
        const sliceEnded = ctrl.signal.aborted;
        if (!(await this.isRunning(sessionID).catch(() => true))) return;
        if (!sliceEnded) {
          console.warn(`[builder] wait for session ${sessionID} interrupted (${err instanceof Error ? err.message : String(err)}), retrying`);
          await sleep(2000);
        }
        await progress();
        continue;
      } finally {
        clearTimeout(timer);
      }
      // A prompt that was only just queued may not have started yet: give it a moment before trusting "idle".
      if (await this.isRunning(sessionID)) continue;
      if (Date.now() - started < settleMs) {
        await sleep(500);
        if (await this.isRunning(sessionID)) continue;
      }
      return;
    }
  }

  async latestReply(sessionID: string): Promise<AgentReply> {
    const res = await this.client.message.list({ sessionID, order: 'desc', limit: 5, type: 'assistant' });
    return extractReply(res.data as unknown as MessageLike[]);
  }

  /**
   * True when the newest user/assistant message is an assistant one (false: a prompt is still waiting
   * for an answer). Other message types (idle, agent-switched, ...) are skipped.
   */
  async lastIsAssistant(sessionID: string): Promise<boolean> {
    try {
      const res = await this.client.message.list({ sessionID, order: 'desc', limit: 20 });
      return lastConversationIsAssistant(res.data as unknown as MessageLike[]);
    } catch {
      return false;
    }
  }

  async usage(sessionID: string): Promise<SessionUsage> {
    const s = await this.client.session.get({ sessionID });
    return {
      input: s.tokens.input,
      output: s.tokens.output,
      reasoning: s.tokens.reasoning,
      cacheRead: s.tokens.cache.read,
      cacheWrite: s.tokens.cache.write,
      costUsd: s.cost,
    };
  }

  /**
   * Ask a decision model one yes/no question about `inputText`. Returns the probability (0..1) that
   * the predicate is true, or null when the model answered with an error / gave no usable answer.
   */
  async decide(
    model: ModelRef,
    inputText: string,
    question: { name: string; instructions: string; criteria?: { true?: string; false?: string } },
    timeoutMs = 15_000,
  ): Promise<number | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.client.experimental.generate.decisions(
        {
          model: { providerID: model.providerID, id: model.id },
          input: [{ type: 'text', text: inputText }],
          questions: [{ type: 'predicate', name: question.name, instructions: question.instructions, criteria: question.criteria }],
        },
        { signal: ctrl.signal },
      );
      const answer = res.answers.find((a) => a.name === question.name);
      if (!answer || answer.type !== 'predicate') return null;
      return typeof answer.probability === 'number' ? answer.probability : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Queue a prompt, wait for the agent to stop, and return its final reply. */
  async promptAndWait(sessionID: string, text: string, timeoutMs: number, files?: readonly PromptImage[], onProgress?: () => Promise<void> | void): Promise<AgentReply> {
    const before = (await this.latestReply(sessionID)).id;
    await this.client.session.prompt(files && files.length > 0 ? { sessionID, text, files } : { sessionID, text });
    await this.waitIdle(sessionID, timeoutMs, 3000, onProgress);
    const reply = await this.latestReply(sessionID);
    if (reply.id !== null && reply.id === before && !reply.error) {
      return { ...reply, text: '', error: 'The agent produced no new reply.' };
    }
    return reply;
  }
}
