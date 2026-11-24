import { DatabaseSync } from 'node:sqlite';
import type { TokenUsage } from './builder/pricing.js';
import { statSync } from 'node:fs';
import { XP_BACKFILL_PER_MESSAGE } from './levels.js';
import { localParts, zonedToUtcMs } from './stats.js';
import { ALL_STORES, type FreeSettings, type Store } from './freegames/types.js';

export interface Settings {
  guildId: string;
  statsChannelId: string | null;
  weeklyEnabled: boolean;
  weeklyDay: number; // 0 = Sunday ... 6 = Saturday
  weeklyHour: number; // 0-23, local time
  timezone: string;
  embedChannels: string[];
  levelingEnabled: boolean;
  levelupChannelId: string | null; // null = track XP but never announce
}

export interface UserRow {
  userId: string;
  messages: number;
}

export interface UserStats {
  userId: string;
  messages: number;
  firstTs: number | null;
  lastTs: number | null;
}

/** Leveling XP for one member: permanent total plus when XP was last awarded. */
export interface UserXp {
  xp: number;
  lastXpAt: number; // 0 = XP was never awarded
}

export interface EmbedLogRow {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string;
  url: string;
  provider: string;
  ts: number;
}

export interface ReactionRow {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string; // message author — counts as "received"
  reactorId: string; // who reacted — counts as "given"
  emojiKey: string; // custom emoji id, or the unicode char
  emojiLabel: string; // display form: <:name:id> or the unicode char
  ts: number;
}

export interface ReactionStats {
  given: number;
  received: number;
}

export interface EmojiRow {
  emojiKey: string;
  emojiLabel: string;
  count: number;
}

export interface ChannelRow {
  channelId: string;
  count: number;
}

export interface ReactionCountRow {
  userId: string;
  count: number;
}

export interface DayCount {
  day: string; // YYYY-MM-DD in the guild timezone
  count: number;
}

/** One activity from a Discord presence (game, stream, custom status, ...). */
export interface ActivityInput {
  name: string;
  type: number; // discord.js ActivityType
  details: string | null;
  state: string | null;
  applicationId: string | null;
  startedAt: number | null; // from activity.timestamps.start, if the app provides it
}

export interface ActivityAggregateRow {
  name: string;
  type: number;
  sessions: number;
  totalMs: number; // open sessions count up to "now"
  lastAt: number; // most recent session end (or now if still open)
}

export interface CurrentActivityRow {
  name: string;
  type: number;
  details: string | null;
  state: string | null;
  startedAt: number;
  lastSeenAt: number;
}

export interface VoiceStats {
  totalMs: number; // open sessions count up to "now"
  sessions: number;
}

export interface VoiceChannelRow {
  channelId: string;
  sessions: number;
  totalMs: number;
  lastAt: number;
}

export interface CurrentVoiceRow {
  channelId: string;
  startedAt: number;
  lastSeenAt: number;
}

export interface ActivitySummaryRow {
  name: string;
  sessions: number;
  totalMs: number;
  avgMs: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface ActivityBreakdownRow {
  label: string; // details (e.g. game mode) or state, '—' if none
  sessions: number;
  totalMs: number;
}

export interface ActivitySessionRow {
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  details: string | null;
  state: string | null;
  open: number; // 1 if still running
}

/** A dashboard login session, persisted so redeploys don't force a re-login. */
export interface WebSessionRow {
  sid: string;
  userId: string;
  username: string;
  avatar: string;
  accessToken: string;
  createdAt: number;
  expiresAt: number; // epoch ms; the row (and its cookie) die after this
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_guild_ts ON messages (guild_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_guild_user ON messages (guild_id, user_id);

CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT PRIMARY KEY,
  stats_channel_id TEXT,
  weekly_enabled INTEGER NOT NULL DEFAULT 1,
  weekly_day INTEGER NOT NULL DEFAULT 1,
  weekly_hour INTEGER NOT NULL DEFAULT 9,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  embed_channels TEXT NOT NULL DEFAULT '[]',
  leveling_enabled INTEGER NOT NULL DEFAULT 1,
  levelup_channel_id TEXT
);

CREATE TABLE IF NOT EXISTS user_xp (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  last_xp_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS embed_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  url TEXT NOT NULL,
  provider TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embed_log_guild_ts ON embed_log (guild_id, ts);

CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  reactor_id TEXT NOT NULL,
  emoji_key TEXT NOT NULL,
  emoji_label TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reactions_guild_reactor ON reactions (guild_id, reactor_id);
CREATE INDEX IF NOT EXISTS idx_reactions_guild_author ON reactions (guild_id, author_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_unique ON reactions (guild_id, message_id, reactor_id, emoji_key);

CREATE TABLE IF NOT EXISTS free_settings (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT,
  ping_role_id TEXT,
  stores TEXT NOT NULL,
  include_dlc INTEGER NOT NULL DEFAULT 0,
  include_beta INTEGER NOT NULL DEFAULT 0,
  include_mobile INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS free_posted (
  guild_id TEXT NOT NULL,
  game_key TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, game_key)
);

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  sid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  avatar TEXT NOT NULL,
  access_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  tag TEXT,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts);

CREATE TABLE IF NOT EXISTS activity_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type INTEGER NOT NULL,
  details TEXT,
  state TEXT,
  application_id TEXT,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_activity_guild_user ON activity_sessions (guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_activity_open ON activity_sessions (guild_id, user_id, ended_at);

CREATE TABLE IF NOT EXISTS voice_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_voice_guild_user ON voice_sessions (guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_voice_open ON voice_sessions (guild_id, user_id, ended_at);

CREATE TABLE IF NOT EXISTS build_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  request TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  session_id TEXT,
  worktree_dir TEXT,
  branch TEXT,
  pr_url TEXT,
  error TEXT,
  model TEXT,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approved_at INTEGER,
  resume_count INTEGER NOT NULL DEFAULT 0,
  fix_attempts INTEGER NOT NULL DEFAULT 0,
  conflict_notified INTEGER NOT NULL DEFAULT 0,
  trigger_message_id TEXT,
  plan_message_id TEXT,
  plan_posted_at INTEGER,
  last_plan TEXT
);
CREATE INDEX IF NOT EXISTS idx_build_jobs_status ON build_jobs (status);
CREATE INDEX IF NOT EXISTS idx_build_jobs_thread ON build_jobs (thread_id);

CREATE TABLE IF NOT EXISTS chat_threads (
  thread_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  started_by TEXT NOT NULL,
  model TEXT,
  one_off INTEGER NOT NULL DEFAULT 0,
  pending_notes TEXT NOT NULL DEFAULT '[]',
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_guild ON chat_threads (guild_id, last_active_at);
`;

export type BuildJobStatus = 'planning' | 'awaiting_input' | 'queued' | 'building' | 'pr_open' | 'merged' | 'closed' | 'failed' | 'cancelled';

export interface BuildJob {
  id: number;
  guildId: string;
  threadId: string;
  channelId: string;
  requesterId: string;
  request: string;
  title: string | null;
  status: BuildJobStatus;
  sessionId: string | null;
  worktreeDir: string | null;
  branch: string | null;
  prUrl: string | null;
  error: string | null;
  model: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  createdAt: number;
  updatedAt: number;
  /** When the plan was approved (queue order); null before approval. */
  approvedAt: number | null;
  /** Discord message that caused the job (may be null). */
  triggerMessageId: string | null;
  /** Message id of the latest posted plan card. */
  planMessageId: string | null;
  /** When (ms) the latest plan card was posted. */
  planPostedAt: number | null;
  /** Plan text of the latest posted plan card. */
  lastPlan: string | null;
  /** Resume attempts after restarts. */
  resumeCount: number;
  /** Automatic merge-conflict fix attempts (at most one). */
  fixAttempts: number;
  /** The "needs a manual merge" message was already posted. */
  conflictNotified: boolean;
}

export type BuildUsage = TokenUsage;

export interface BuilderSettings {
  /** Admins may request features (build jobs). */
  enabled: boolean;
  /** Plan/build model, "providerID/modelID". */
  model: string;
  /** Members can chat with the bot by mentioning it. */
  chatEnabled: boolean;
  /** Chat model, "providerID/modelID". */
  chatModel: string;
  /** Decision model detecting feature requests before the chat agent runs, "providerID/modelID". */
  chatDecisionModel: string;
  /** How many builds may run at once (1–5); further approved requests wait in a queue. */
  maxParallelBuilds: number;
  /** Refuse AI requests while any OpenCode Go limit is at this percent or more (50–100). */
  limitThreshold: number;
  /** Languages the chat assistant must reply in; empty = no constraint (any language). */
  chatLanguages: string[];
}

export const DEFAULT_BUILDER_MODEL = 'opencode-go/glm-5.3';
export const DEFAULT_CHAT_MODEL = 'opencode-go/glm-5.3-flash';
export const DEFAULT_CHAT_DECISION_MODEL = 'opencode-go/jev-1.14';
export const DEFAULT_MAX_PARALLEL_BUILDS = 1;
export const MAX_PARALLEL_BUILDS_LIMIT = 5;
export const DEFAULT_LIMIT_THRESHOLD = 95;
export const MIN_LIMIT_THRESHOLD = 50;
export const MAX_LIMIT_THRESHOLD = 100;

/** Whole number in 1..5; anything else becomes the default. */
export function clampMaxParallel(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_PARALLEL_BUILDS;
  return Math.min(MAX_PARALLEL_BUILDS_LIMIT, Math.max(1, Math.trunc(n)));
}

/** Whole percent in 50..100; anything else becomes the default. */
export function clampLimitThreshold(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_LIMIT_THRESHOLD;
  return Math.min(MAX_LIMIT_THRESHOLD, Math.max(MIN_LIMIT_THRESHOLD, Math.round(n)));
}

export interface ChatThread {
  threadId: string;
  guildId: string;
  channelId: string;
  sessionId: string;
  startedBy: string;
  model: string | null;
  /** A one-off reply in a thread the bot does not own (thread_id is "<thread>:<message>"). */
  oneOff: boolean;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  createdAt: number;
  lastActiveAt: number;
}

function parseNotes(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Chat languages are stored as a JSON string array in bot_state; missing or invalid state = no constraint. */
function parseChatLanguages(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x.length > 0);
  } catch {
    return [];
  }
}

function chatThreadFromRow(r: Record<string, unknown>): ChatThread {
  return {
    threadId: r.thread_id as string,
    guildId: r.guild_id as string,
    channelId: r.channel_id as string,
    sessionId: r.session_id as string,
    startedBy: r.started_by as string,
    model: (r.model as string | null) ?? null,
    oneOff: (r.one_off as number) === 1,
    tokensInput: r.tokens_input as number,
    tokensOutput: r.tokens_output as number,
    tokensReasoning: r.tokens_reasoning as number,
    tokensCacheRead: r.tokens_cache_read as number,
    tokensCacheWrite: r.tokens_cache_write as number,
    costUsd: r.cost_usd as number,
    createdAt: r.created_at as number,
    lastActiveAt: r.last_active_at as number,
  };
}

/** Statuses in which a job owns its thread (at most one such job per thread). */
export const ACTIVE_BUILD_STATUSES: readonly BuildJobStatus[] = ['planning', 'awaiting_input', 'queued', 'building'];

function buildJobFromRow(r: Record<string, unknown>): BuildJob {
  return {
    id: r.id as number,
    guildId: r.guild_id as string,
    threadId: r.thread_id as string,
    channelId: r.channel_id as string,
    requesterId: r.requester_id as string,
    request: r.request as string,
    title: (r.title as string | null) ?? null,
    status: r.status as BuildJobStatus,
    sessionId: (r.session_id as string | null) ?? null,
    worktreeDir: (r.worktree_dir as string | null) ?? null,
    branch: (r.branch as string | null) ?? null,
    prUrl: (r.pr_url as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    tokensInput: r.tokens_input as number,
    tokensOutput: r.tokens_output as number,
    tokensReasoning: r.tokens_reasoning as number,
    tokensCacheRead: r.tokens_cache_read as number,
    tokensCacheWrite: r.tokens_cache_write as number,
    costUsd: r.cost_usd as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    approvedAt: (r.approved_at as number | null) ?? null,
    triggerMessageId: (r.trigger_message_id as string | null) ?? null,
    planMessageId: (r.plan_message_id as string | null) ?? null,
    planPostedAt: (r.plan_posted_at as number | null) ?? null,
    lastPlan: (r.last_plan as string | null) ?? null,
    resumeCount: (r.resume_count as number | null) ?? 0,
    fixAttempts: (r.fix_attempts as number | null) ?? 0,
    conflictNotified: ((r.conflict_notified as number | null) ?? 0) === 1,
  };
}

/** Fields of a build job that callers may update (besides status/usage, which have their own methods). */
export type BuildJobPatch = Partial<Pick<BuildJob, 'title' | 'sessionId' | 'worktreeDir' | 'branch' | 'prUrl' | 'error' | 'model' | 'approvedAt' | 'resumeCount' | 'fixAttempts' | 'conflictNotified' | 'triggerMessageId' | 'planMessageId' | 'planPostedAt' | 'lastPlan'>>;

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogRow {
  id: number;
  ts: number;
  level: LogLevel;
  tag: string | null;
  message: string;
}
const MAX_LOG_ROWS = 5000;

const DEFAULT_SETTINGS: Omit<Settings, 'guildId'> = {
  statsChannelId: null,
  weeklyEnabled: true,
  weeklyDay: 1, // Monday
  weeklyHour: 9,
  timezone: 'UTC',
  embedChannels: [],
  levelingEnabled: true,
  levelupChannelId: null,
};

export class BotDatabase {
  private db: DatabaseSync;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    try {
      this.db = new DatabaseSync(path);
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec(SCHEMA);
    } catch (err) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
      throw new Error(
        `Cannot open SQLite database at "${path}" (process uid=${uid}). ` +
          'If this runs in Docker with a bind-mounted ./data volume, the host directory must be writable by the container user (uid 1000): sudo chown -R 1000:1000 data',
        { cause: err },
      );
    }
    // Migration for settings created before leveling existed. The `user_xp`
    // table is new, so the CREATE TABLE IF NOT EXISTS above already covers it.
    const settingsCols = this.db.prepare('PRAGMA table_info(settings)').all() as { name: string }[];
    if (!settingsCols.some((c) => c.name === 'leveling_enabled')) {
      this.db.exec('ALTER TABLE settings ADD COLUMN leveling_enabled INTEGER NOT NULL DEFAULT 1');
    }
    if (!settingsCols.some((c) => c.name === 'levelup_channel_id')) {
      this.db.exec('ALTER TABLE settings ADD COLUMN levelup_channel_id TEXT');
    }
    // Migration for build_jobs created before the model column existed.
    const jobCols = this.db.prepare('PRAGMA table_info(build_jobs)').all() as { name: string }[];
    if (!jobCols.some((c) => c.name === 'model')) {
      this.db.exec('ALTER TABLE build_jobs ADD COLUMN model TEXT');
    }
    // Migrations for the build queue, restart resume and conflict fix columns.
    const queueCols = (this.db.prepare('PRAGMA table_info(build_jobs)').all() as { name: string }[]).map((c) => c.name);
    for (const [name, ddl] of [
      ['approved_at', 'INTEGER'],
      ['resume_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['fix_attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['conflict_notified', 'INTEGER NOT NULL DEFAULT 0'],
      ['trigger_message_id', 'TEXT'],
      ['plan_message_id', 'TEXT'],
      ['plan_posted_at', 'INTEGER'],
      ['last_plan', 'TEXT'],
    ] as const) {
      if (!queueCols.includes(name)) this.db.exec(`ALTER TABLE build_jobs ADD COLUMN ${name} ${ddl}`);
    }
    // Migration for chat_threads created before pending_notes existed.
    const chatCols = this.db.prepare('PRAGMA table_info(chat_threads)').all() as { name: string }[];
    if (!chatCols.some((c) => c.name === 'pending_notes')) {
      this.db.exec(`ALTER TABLE chat_threads ADD COLUMN pending_notes TEXT NOT NULL DEFAULT '[]'`);
    }
    // build_jobs.thread_id used to be UNIQUE; a thread may now hold several jobs over time. SQLite
    // cannot drop a constraint, so rebuild the table (same columns) when the old unique index exists.
    const jobIdx = this.db.prepare('PRAGMA index_list(build_jobs)').all() as { name: string; unique: number }[];
    const threadUnique = jobIdx.some((ix) => {
      if (ix.unique !== 1) return false;
      const cols = this.db.prepare(`PRAGMA index_info(${JSON.stringify(ix.name)})`).all() as { name: string }[];
      return cols.length === 1 && cols[0]!.name === 'thread_id';
    });
    if (threadUnique) {
      const names = (this.db.prepare('PRAGMA table_info(build_jobs)').all() as { name: string }[]).map((c) => c.name).join(', ');
      this.db.exec('BEGIN');
      try {
        this.db.exec(`ALTER TABLE build_jobs RENAME TO build_jobs_old`);
        this.db.exec('DROP INDEX IF EXISTS idx_build_jobs_status');
        this.db.exec('DROP INDEX IF EXISTS idx_build_jobs_thread');
        this.db.exec(SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS build_jobs'), SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS chat_threads')));
        this.db.exec(`INSERT INTO build_jobs (${names}) SELECT ${names} FROM build_jobs_old`);
        this.db.exec('DROP TABLE build_jobs_old');
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      console.log('[db] build_jobs: thread_id is no longer unique');
    }
    // Dedup key: the same Discord message must never be counted twice
    // (live tracking + backfill can overlap).
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_guild_msg ON messages (guild_id, message_id)');
    // Split sessions used to restart at the original game start and overlap.
    const repaired = this.repairActivityOverlaps();
    if (repaired > 0) console.log(`[db] repaired ${repaired} overlapping activity session(s)`);
  }

  close(): void {
    this.db.close();
  }

  get sizeBytes(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  // ---- messages -------------------------------------------------------

  recordMessage(guildId: string, channelId: string, userId: string, ts: number, messageId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO messages (guild_id, channel_id, user_id, ts, message_id) VALUES (?, ?, ?, ?, ?)')
      .run(guildId, channelId, userId, ts, messageId);
  }

  /** Insert many rows in one transaction; returns how many were actually new. */
  recordMessagesBatch(rows: { guildId: string; channelId: string; userId: string; ts: number; messageId: string }[]): number {
    if (rows.length === 0) return 0;
    this.db.exec('BEGIN');
    try {
      const ins = this.db.prepare('INSERT OR IGNORE INTO messages (guild_id, channel_id, user_id, ts, message_id) VALUES (?, ?, ?, ?, ?)');
      let changes = 0;
      for (const r of rows) changes += Number(ins.run(r.guildId, r.channelId, r.userId, r.ts, r.messageId).changes);
      this.db.exec('COMMIT');
      return changes;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  countMessages(guildId: string, fromTs?: number, toTs?: number): number {
    if (fromTs !== undefined && toTs !== undefined) {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE guild_id = ? AND ts >= ? AND ts < ?').get(guildId, fromTs, toTs) as { c: number };
      return row.c;
    }
    if (fromTs !== undefined) {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE guild_id = ? AND ts >= ?').get(guildId, fromTs) as { c: number };
      return row.c;
    }
    if (toTs !== undefined) {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE guild_id = ? AND ts < ?').get(guildId, toTs) as { c: number };
      return row.c;
    }
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE guild_id = ?').get(guildId) as { c: number };
    return row.c;
  }

  topUsers(guildId: string, limit: number, fromTs?: number, toTs?: number): UserRow[] {
    if (fromTs !== undefined && toTs !== undefined) {
      return this.db
        .prepare('SELECT user_id AS userId, COUNT(*) AS messages FROM messages WHERE guild_id = ? AND ts >= ? AND ts < ? GROUP BY user_id ORDER BY messages DESC, user_id ASC LIMIT ?')
        .all(guildId, fromTs, toTs, limit) as unknown as UserRow[];
    }
    return this.db
      .prepare('SELECT user_id AS userId, COUNT(*) AS messages FROM messages WHERE guild_id = ? GROUP BY user_id ORDER BY messages DESC, user_id ASC LIMIT ?')
      .all(guildId, limit) as unknown as UserRow[];
  }

  /**
   * 1-based leaderboard position of a user (same ordering as `topUsers`: messages DESC,
   * user_id ASC) with their message count; null when they have no messages in the range.
   */
  userRank(guildId: string, userId: string, fromTs?: number, toTs?: number): { rank: number; messages: number } | null {
    const ranged = fromTs !== undefined && toTs !== undefined;
    const where = ranged ? 'guild_id = ? AND ts >= ? AND ts < ?' : 'guild_id = ?';
    const args: (string | number)[] = ranged ? [guildId, fromTs, toTs] : [guildId];
    const own = this.db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE ${where} AND user_id = ?`).get(...args, userId) as { c: number };
    if (own.c === 0) return null;
    const ahead = this.db
      .prepare(`SELECT COUNT(*) AS c FROM (SELECT user_id FROM messages WHERE ${where} GROUP BY user_id HAVING COUNT(*) > ? OR (COUNT(*) = ? AND user_id < ?))`)
      .get(...args, own.c, own.c, userId) as { c: number };
    return { rank: ahead.c + 1, messages: own.c };
  }

  userStats(guildId: string, userId: string): UserStats {
    const row = this.db
      .prepare('SELECT user_id AS userId, COUNT(*) AS messages, MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM messages WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId) as unknown as UserStats | undefined;
    return row ?? { userId, messages: 0, firstTs: null, lastTs: null };
  }

  distinctActiveUsers(guildId: string): number {
    const row = this.db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM messages WHERE guild_id = ?').get(guildId) as { c: number };
    return row.c;
  }

  // ---- reactions --------------------------------------------------------

  recordReaction(r: ReactionRow): void {
    this.db
      .prepare('INSERT OR IGNORE INTO reactions (guild_id, channel_id, message_id, author_id, reactor_id, emoji_key, emoji_label, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.guildId, r.channelId, r.messageId, r.authorId, r.reactorId, r.emojiKey, r.emojiLabel, r.ts);
  }

  /** Insert many reaction rows in one transaction; returns how many were new. */
  recordReactionsBatch(rows: ReactionRow[]): number {
    if (rows.length === 0) return 0;
    this.db.exec('BEGIN');
    try {
      const ins = this.db.prepare('INSERT OR IGNORE INTO reactions (guild_id, channel_id, message_id, author_id, reactor_id, emoji_key, emoji_label, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      let changes = 0;
      for (const r of rows) changes += Number(ins.run(r.guildId, r.channelId, r.messageId, r.authorId, r.reactorId, r.emojiKey, r.emojiLabel, r.ts).changes);
      this.db.exec('COMMIT');
      return changes;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  reactionStats(guildId: string, userId: string): ReactionStats {
    const given = this.db.prepare('SELECT COUNT(*) AS c FROM reactions WHERE guild_id = ? AND reactor_id = ?').get(guildId, userId) as { c: number };
    const received = this.db.prepare('SELECT COUNT(*) AS c FROM reactions WHERE guild_id = ? AND author_id = ?').get(guildId, userId) as { c: number };
    return { given: given.c, received: received.c };
  }

  countReactions(guildId: string, fromTs?: number, toTs?: number): number {
    if (fromTs !== undefined && toTs !== undefined) {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM reactions WHERE guild_id = ? AND ts >= ? AND ts < ?').get(guildId, fromTs, toTs) as { c: number };
      return row.c;
    }
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM reactions WHERE guild_id = ?').get(guildId) as { c: number };
    return row.c;
  }

  topChannels(guildId: string, fromTs: number, toTs: number, limit: number): ChannelRow[] {
    return this.db
      .prepare('SELECT channel_id AS channelId, COUNT(*) AS count FROM messages WHERE guild_id = ? AND ts >= ? AND ts < ? GROUP BY channel_id ORDER BY count DESC, channel_id ASC LIMIT ?')
      .all(guildId, fromTs, toTs, limit) as unknown as ChannelRow[];
  }

  topReactionsGiven(guildId: string, limit: number, fromTs?: number, toTs?: number): ReactionCountRow[] {
    if (fromTs !== undefined && toTs !== undefined) {
      return this.db
        .prepare('SELECT reactor_id AS userId, COUNT(*) AS count FROM reactions WHERE guild_id = ? AND ts >= ? AND ts < ? GROUP BY reactor_id ORDER BY count DESC, userId ASC LIMIT ?')
        .all(guildId, fromTs, toTs, limit) as unknown as ReactionCountRow[];
    }
    return this.db
      .prepare('SELECT reactor_id AS userId, COUNT(*) AS count FROM reactions WHERE guild_id = ? GROUP BY reactor_id ORDER BY count DESC, userId ASC LIMIT ?')
      .all(guildId, limit) as unknown as ReactionCountRow[];
  }

  topReactionsReceived(guildId: string, limit: number, fromTs?: number, toTs?: number): ReactionCountRow[] {
    if (fromTs !== undefined && toTs !== undefined) {
      return this.db
        .prepare('SELECT author_id AS userId, COUNT(*) AS count FROM reactions WHERE guild_id = ? AND ts >= ? AND ts < ? GROUP BY author_id ORDER BY count DESC, userId ASC LIMIT ?')
        .all(guildId, fromTs, toTs, limit) as unknown as ReactionCountRow[];
    }
    return this.db
      .prepare('SELECT author_id AS userId, COUNT(*) AS count FROM reactions WHERE guild_id = ? GROUP BY author_id ORDER BY count DESC, userId ASC LIMIT ?')
      .all(guildId, limit) as unknown as ReactionCountRow[];
  }

  /** Emojis most used on this user's messages (i.e. reactions they received). */
  topEmojiReceived(guildId: string, userId: string, limit: number): EmojiRow[] {
    return this.db
      .prepare('SELECT emoji_key AS emojiKey, emoji_label AS emojiLabel, COUNT(*) AS count FROM reactions WHERE guild_id = ? AND author_id = ? GROUP BY emoji_key ORDER BY count DESC, emoji_key ASC LIMIT ?')
      .all(guildId, userId, limit) as unknown as EmojiRow[];
  }

  /** Message counts bucketed by local calendar day in `timeZone` (DST-safe). */
  messageCountsPerDay(guildId: string, fromTs: number, toTs: number, timeZone: string): DayCount[] {
    const rows = this.db.prepare('SELECT ts FROM messages WHERE guild_id = ? AND ts >= ? AND ts < ?').all(guildId, fromTs, toTs) as unknown as { ts: number }[];
    const map = new Map<string, number>();
    for (const r of rows) {
      const p = localParts(timeZone, new Date(r.ts));
      const key = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day));
  }

  topEmojiForUser(guildId: string, userId: string, limit: number): EmojiRow[] {
    return this.db
      .prepare('SELECT emoji_key AS emojiKey, emoji_label AS emojiLabel, COUNT(*) AS count FROM reactions WHERE guild_id = ? AND reactor_id = ? GROUP BY emoji_key ORDER BY count DESC, emoji_key ASC LIMIT ?')
      .all(guildId, userId, limit) as unknown as EmojiRow[];
  }

  topEmojiAll(guildId: string, limit: number): EmojiRow[] {
    return this.db
      .prepare('SELECT emoji_key AS emojiKey, emoji_label AS emojiLabel, COUNT(*) AS count FROM reactions WHERE guild_id = ? GROUP BY emoji_key ORDER BY count DESC, emoji_key ASC LIMIT ?')
      .all(guildId, limit) as unknown as EmojiRow[];
  }

  // ---- activities (Discord presences) -----------------------------------

  /**
   * Reconcile one member's presence with the open sessions in the DB:
   * activities still present get their open session touched (or a new one
   * opened), activities that disappeared get their session closed.
   */
  recordPresence(guildId: string, userId: string, activities: ActivityInput[], ts: number): void {
    this.db.exec('BEGIN');
    try {
      const closeStmt = this.db.prepare('UPDATE activity_sessions SET ended_at = ? WHERE id = ?');
      const touchStmt = this.db.prepare('UPDATE activity_sessions SET last_seen_at = ? WHERE id = ?');
      const openStmt = this.db.prepare('SELECT id FROM activity_sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL AND name = ? AND type = ? AND application_id IS ? AND details IS ? AND state IS ? ORDER BY id DESC LIMIT 1');
      const insStmt = this.db.prepare('INSERT INTO activity_sessions (guild_id, user_id, name, type, details, state, application_id, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const prevEndStmt = this.db.prepare('SELECT MAX(COALESCE(ended_at, ?)) AS e FROM activity_sessions WHERE guild_id = ? AND user_id = ? AND name = ? AND type = ? AND application_id IS ?');

      // A session is one continuous run of the same activity (name + type +
      // app + details/state); a change in details/state (e.g. LoL game mode)
      // closes the session and starts a new one.
      const key = (name: string, type: number, appId: string | null, details: string | null, state: string | null): string =>
        `${name}${type}${appId ?? ''}${details ?? ''}${state ?? ''}`;
      const seen = new Set<string>();
      for (const a of activities) {
        seen.add(key(a.name, a.type, a.applicationId, a.details, a.state));
        const open = openStmt.get(guildId, userId, a.name, a.type, a.applicationId, a.details, a.state) as { id: number } | undefined;
        if (open) {
          touchStmt.run(ts, open.id);
        } else {
          // Discord's start timestamp is the original launch; never let a split
          // session start before the previous session of the same activity ended
          // (an open one is about to be closed at `ts`).
          const prev = prevEndStmt.get(ts, guildId, userId, a.name, a.type, a.applicationId) as { e: number | null } | undefined;
          const startedAt = Math.min(Math.max(a.startedAt ?? ts, prev?.e ?? -Infinity), ts);
          insStmt.run(guildId, userId, a.name, a.type, a.details, a.state, a.applicationId, startedAt, ts);
        }
      }
      // Close every open session whose activity is no longer present (or changed).
      const openRows = this.db
        .prepare('SELECT id, name, type, application_id, details, state FROM activity_sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL')
        .all(guildId, userId) as unknown as { id: number; name: string; type: number; application_id: string | null; details: string | null; state: string | null }[];
      for (const row of openRows) {
        if (!seen.has(key(row.name, row.type, row.application_id, row.details, row.state))) {
          closeStmt.run(ts, row.id);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Custom statuses (type 4) are recorded but never shown in stats.
  /** Activities ranked by total time for one user, all time. Open sessions count up to `now`. */
  topActivities(guildId: string, userId: string, limit: number, now = Date.now()): ActivityAggregateRow[] {
    return this.db
      .prepare(`SELECT name, MAX(type) AS type, COUNT(*) AS sessions,
                       SUM((CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) - started_at) AS totalMs,
                       MAX(CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) AS lastAt
                FROM activity_sessions WHERE guild_id = ? AND user_id = ? AND type <> 4
                GROUP BY name ORDER BY totalMs DESC, name ASC LIMIT ?`)
      .all(now, now, guildId, userId, limit) as unknown as ActivityAggregateRow[];
  }

  /** Total tracked activity time for one user, all time. Open sessions count up to `now`. */
  totalActivityMs(guildId: string, userId: string, now = Date.now()): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM((CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) - started_at), 0) AS ms FROM activity_sessions WHERE guild_id = ? AND user_id = ? AND type <> 4')
      .get(now, guildId, userId) as { ms: number };
    return row.ms;
  }

  /** Currently open (still running) activities for one user. */
  currentActivities(guildId: string, userId: string): CurrentActivityRow[] {
    return this.db
      .prepare('SELECT name, type, details, state, started_at AS startedAt, last_seen_at AS lastSeenAt FROM activity_sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL AND type <> 4 ORDER BY last_seen_at DESC')
      .all(guildId, userId) as unknown as CurrentActivityRow[];
  }

  /** Distinct non-custom-status activity names seen in a guild (for /activity autocomplete). */
  activityNames(guildId: string, prefix = '', limit = 25): string[] {
    const rows = this.db.prepare('SELECT DISTINCT name FROM activity_sessions WHERE guild_id = ? AND type <> 4 ORDER BY name ASC').all(guildId) as unknown as { name: string }[];
    const p = prefix.trim().toLowerCase();
    return rows
      .map((r) => r.name)
      .filter((n) => (p === '' ? true : n.toLowerCase().includes(p)))
      .slice(0, limit);
  }

  /** Totals for one activity name for one user. Open sessions count up to `now`. */
  activitySummary(guildId: string, userId: string, name: string, now = Date.now()): ActivitySummaryRow | null {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS sessions,
                       COALESCE(SUM((CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) - started_at), 0) AS totalMs,
                       MIN(started_at) AS firstAt,
                       MAX(CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) AS lastAt
                FROM activity_sessions WHERE guild_id = ? AND user_id = ? AND name = ?`)
      .get(now, now, guildId, userId, name) as { sessions: number; totalMs: number; firstAt: number | null; lastAt: number | null } | undefined;
    if (!row || row.sessions === 0) return null;
    return { name, sessions: row.sessions, totalMs: row.totalMs, avgMs: row.totalMs / row.sessions, firstAt: row.firstAt, lastAt: row.lastAt };
  }

  /** Breakdown by details/state (game mode, song, status text, ...) for one activity. */
  activityBreakdown(guildId: string, userId: string, name: string, limit: number, now = Date.now()): ActivityBreakdownRow[] {
    return this.db
      .prepare(`SELECT CASE
                         WHEN NULLIF(details, '') IS NOT NULL AND NULLIF(state, '') IS NOT NULL THEN details || ' — ' || state
                         ELSE COALESCE(NULLIF(details, ''), NULLIF(state, ''), '—')
                       END AS label, COUNT(*) AS sessions,
                       SUM((CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) - started_at) AS totalMs
                FROM activity_sessions WHERE guild_id = ? AND user_id = ? AND name = ?
                GROUP BY label ORDER BY totalMs DESC, label ASC LIMIT ?`)
      .all(now, guildId, userId, name, limit) as unknown as ActivityBreakdownRow[];
  }

  /** Most recent sessions for one activity. Open sessions count up to `now`. */
  recentActivitySessions(guildId: string, userId: string, name: string, limit: number, now = Date.now()): ActivitySessionRow[] {
    return this.db
      .prepare(`SELECT started_at AS startedAt, ended_at AS endedAt,
                       (CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) - started_at AS durationMs,
                       details, state, ended_at IS NULL AS open
                FROM activity_sessions WHERE guild_id = ? AND user_id = ? AND name = ?
                ORDER BY started_at DESC LIMIT ?`)
      .all(now, guildId, userId, name, limit) as unknown as ActivitySessionRow[];
  }

  /**
   * Minutes per local calendar day for one activity. Sessions overlapping
   * [fromTs, toTs) are clipped to the window and split across local midnights.
   */
  activityMinutesPerDay(guildId: string, userId: string, name: string, fromTs: number, toTs: number, timeZone: string, now = Date.now()): DayCount[] {
    const rows = this.db
      .prepare(`SELECT started_at AS s, (CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) AS e
                FROM activity_sessions WHERE guild_id = ? AND user_id = ? AND name = ?
                  AND started_at < ? AND (CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) > ?`)
      .all(now, guildId, userId, name, toTs, now, fromTs) as unknown as { s: number; e: number }[];
    const ms = new Map<string, number>();
    for (const r of rows) {
      let cur = Math.max(r.s, fromTs);
      const end = Math.min(r.e, toTs);
      while (cur < end) {
        const p = localParts(timeZone, new Date(cur));
        const key = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
        let next = zonedToUtcMs(timeZone, p.y, p.mo, p.d + 1); // Date.UTC normalises day overflow
        if (!(next > cur)) next = end; // safety against helper oddities
        const segEnd = Math.min(end, next);
        ms.set(key, (ms.get(key) ?? 0) + (segEnd - cur));
        cur = segEnd;
      }
    }
    return [...ms.entries()]
      .map(([day, v]) => ({ day, count: Math.min(1440, Math.round(v / 60_000)) }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  /**
   * One-time/idempotent repair of overlapping activity sessions: within each
   * (guild, user, name, type, app) group no session may start before an
   * earlier one ended. Returns the number of rows adjusted.
   */
  repairActivityOverlaps(): number {
    const rows = this.db
      .prepare(`SELECT id, guild_id, user_id, name, type, application_id, started_at, ended_at, last_seen_at
                FROM activity_sessions ORDER BY guild_id, user_id, name, type, application_id, started_at, id`)
      .all() as unknown as { id: number; guild_id: string; user_id: string; name: string; type: number; application_id: string | null; started_at: number; ended_at: number | null; last_seen_at: number }[];
    const upd = this.db.prepare('UPDATE activity_sessions SET started_at = ? WHERE id = ?');
    let changed = 0;
    let groupKey = '';
    let maxEnd = -Infinity;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const k = JSON.stringify([r.guild_id, r.user_id, r.name, r.type, r.application_id]);
        if (k !== groupKey) {
          groupKey = k;
          maxEnd = -Infinity;
        }
        const end = r.ended_at ?? r.last_seen_at;
        let s = r.started_at;
        if (s < maxEnd) s = maxEnd;
        if (s > end) s = end;
        if (s !== r.started_at) {
          upd.run(s, r.id);
          changed++;
        }
        maxEnd = Math.max(maxEnd, r.ended_at ?? r.last_seen_at);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return changed;
  }

  // ---- voice channel time -------------------------------------------------

  /**
   * Reconcile one member's voice state: `channelId = null` means they left
   * voice (close the open session); a channel id means they joined it (open a
   * session, closing any open session in a different channel first).
   */
  recordVoiceState(guildId: string, userId: string, channelId: string | null, ts: number): void {
    this.db.exec('BEGIN');
    try {
      const openRows = this.db
        .prepare('SELECT id, channel_id FROM voice_sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL')
        .all(guildId, userId) as unknown as { id: number; channel_id: string }[];
      if (channelId === null) {
        const closeStmt = this.db.prepare('UPDATE voice_sessions SET ended_at = ? WHERE id = ?');
        for (const row of openRows) closeStmt.run(ts, row.id);
      } else {
        const closeStmt = this.db.prepare('UPDATE voice_sessions SET ended_at = ? WHERE id = ?');
        const touchStmt = this.db.prepare('UPDATE voice_sessions SET last_seen_at = ? WHERE id = ?');
        const insStmt = this.db.prepare('INSERT INTO voice_sessions (guild_id, user_id, channel_id, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)');
        const same = openRows.find((r) => r.channel_id === channelId);
        if (same) {
          touchStmt.run(ts, same.id);
          for (const row of openRows) if (row.id !== same.id) closeStmt.run(ts, row.id);
        } else {
          for (const row of openRows) closeStmt.run(ts, row.id); // switched channels
          insStmt.run(guildId, userId, channelId, ts, ts);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Open sessions count up to `now`. */
  voiceStats(guildId: string, userId: string, now = Date.now()): VoiceStats {
    const row = this.db
      .prepare('SELECT COUNT(*) AS sessions, COALESCE(SUM((CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) - started_at), 0) AS totalMs FROM voice_sessions WHERE guild_id = ? AND user_id = ?')
      .get(now, guildId, userId) as { sessions: number; totalMs: number };
    return { totalMs: row.totalMs, sessions: row.sessions };
  }

  /** Voice channels ranked by total time for one user, all time. Open sessions count up to `now`. */
  topVoiceChannels(guildId: string, userId: string, limit: number, now = Date.now()): VoiceChannelRow[] {
    return this.db
      .prepare(`SELECT channel_id AS channelId, COUNT(*) AS sessions,
                       SUM((CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) - started_at) AS totalMs,
                       MAX(CASE WHEN ended_at IS NULL THEN ? ELSE ended_at END) AS lastAt
                FROM voice_sessions WHERE guild_id = ? AND user_id = ?
                GROUP BY channel_id ORDER BY totalMs DESC, channel_id ASC LIMIT ?`)
      .all(now, now, guildId, userId, limit) as unknown as VoiceChannelRow[];
  }

  /** The voice channel the user is in right now, if any. */
  currentVoiceChannel(guildId: string, userId: string): CurrentVoiceRow | null {
    const row = this.db
      .prepare('SELECT channel_id AS channelId, started_at AS startedAt, last_seen_at AS lastSeenAt FROM voice_sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1')
      .get(guildId, userId) as CurrentVoiceRow | undefined;
    return row ?? null;
  }

  // ---- leveling (XP) ---------------------------------------------------

  /** A member's permanent XP total; null when they have never earned XP. */
  getUserXp(guildId: string, userId: string): UserXp | null {
    const row = this.db
      .prepare('SELECT xp, last_xp_at AS lastXpAt FROM user_xp WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId) as UserXp | undefined;
    return row ?? null;
  }

  /** Add XP to a member (creating their row); returns the new total. */
  addUserXp(guildId: string, userId: string, amount: number, ts: number): number {
    this.db
      .prepare(`INSERT INTO user_xp (guild_id, user_id, xp, last_xp_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = xp + excluded.xp, last_xp_at = excluded.last_xp_at`)
      .run(guildId, userId, amount, ts);
    const row = this.db.prepare('SELECT xp FROM user_xp WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as { xp: number };
    return row.xp;
  }

  /** Total XP per member of a guild, for level tags next to stat rows. */
  getUserXpTotals(guildId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT user_id AS userId, xp FROM user_xp WHERE guild_id = ?')
      .all(guildId) as unknown as { userId: string; xp: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.userId] = r.xp;
    return out;
  }

  /**
   * One-time XP backfill: grant `XP_BACKFILL_PER_MESSAGE` XP for every recorded
   * message of the guild, added on top of XP already earned. A no-op returning
   * zeroes when the guild has no recorded messages. "Only once" is the caller's
   * job (it marks the `xpbackfill:<guild>` bot_state key).
   */
  backfillMessageXp(guildId: string, ts: number): { members: number; messages: number; xpGranted: number } {
    const agg = this.db
      .prepare('SELECT COUNT(*) AS members, COALESCE(SUM(cnt), 0) AS messages FROM (SELECT COUNT(*) AS cnt FROM messages WHERE guild_id = ? GROUP BY user_id)')
      .get(guildId) as { members: number; messages: number };
    if (agg.messages > 0) {
      this.db
        .prepare(`INSERT INTO user_xp (guild_id, user_id, xp, last_xp_at)
                  SELECT guild_id, user_id, COUNT(*) * ?, ? FROM messages WHERE guild_id = ? GROUP BY user_id
                  ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = xp + excluded.xp, last_xp_at = excluded.last_xp_at`)
        .run(XP_BACKFILL_PER_MESSAGE, ts, guildId);
    }
    return { members: agg.members, messages: agg.messages, xpGranted: agg.messages * XP_BACKFILL_PER_MESSAGE };
  }

  // ---- settings -------------------------------------------------------

  getSettings(guildId: string): Settings {
    const row = this.db.prepare('SELECT * FROM settings WHERE guild_id = ?').get(guildId) as
      | { stats_channel_id: string | null; weekly_enabled: number; weekly_day: number; weekly_hour: number; timezone: string; embed_channels: string; leveling_enabled: number; levelup_channel_id: string | null }
      | undefined;
    if (!row) return { guildId, ...DEFAULT_SETTINGS };
    return {
      guildId,
      statsChannelId: row.stats_channel_id,
      weeklyEnabled: row.weekly_enabled === 1,
      weeklyDay: row.weekly_day,
      weeklyHour: row.weekly_hour,
      timezone: row.timezone,
      embedChannels: JSON.parse(row.embed_channels) as string[],
      levelingEnabled: row.leveling_enabled === 1,
      levelupChannelId: row.levelup_channel_id,
    };
  }

  saveSettings(s: Settings): void {
    this.db
      .prepare(`INSERT INTO settings (guild_id, stats_channel_id, weekly_enabled, weekly_day, weekly_hour, timezone, embed_channels, leveling_enabled, levelup_channel_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(guild_id) DO UPDATE SET
                  stats_channel_id = excluded.stats_channel_id,
                  weekly_enabled = excluded.weekly_enabled,
                  weekly_day = excluded.weekly_day,
                  weekly_hour = excluded.weekly_hour,
                  timezone = excluded.timezone,
                  embed_channels = excluded.embed_channels,
                  leveling_enabled = excluded.leveling_enabled,
                  levelup_channel_id = excluded.levelup_channel_id`)
      .run(s.guildId, s.statsChannelId, s.weeklyEnabled ? 1 : 0, s.weeklyDay, s.weeklyHour, s.timezone, JSON.stringify(s.embedChannels), s.levelingEnabled ? 1 : 0, s.levelupChannelId);
  }

  // ---- free games -----------------------------------------------------

  getFreeSettings(guildId: string): FreeSettings {
    const row = this.db.prepare('SELECT * FROM free_settings WHERE guild_id = ?').get(guildId) as
      | { channel_id: string | null; ping_role_id: string | null; stores: string; include_dlc: number; include_beta: number; include_mobile: number }
      | undefined;
    if (!row) {
      return { guildId, channelId: null, pingRoleId: null, stores: [...ALL_STORES], includeDlc: false, includeBeta: false, includeMobile: false };
    }
    let stores: Store[] = [...ALL_STORES];
    try {
      const parsed = JSON.parse(row.stores) as unknown;
      if (Array.isArray(parsed)) stores = parsed.filter((x): x is Store => ALL_STORES.includes(x as Store));
    } catch {
      // keep defaults on corrupt JSON
    }
    return {
      guildId,
      channelId: row.channel_id,
      pingRoleId: row.ping_role_id,
      stores,
      includeDlc: row.include_dlc === 1,
      includeBeta: row.include_beta === 1,
      includeMobile: row.include_mobile === 1,
    };
  }

  saveFreeSettings(s: FreeSettings): void {
    this.db
      .prepare(`INSERT INTO free_settings (guild_id, channel_id, ping_role_id, stores, include_dlc, include_beta, include_mobile)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(guild_id) DO UPDATE SET
                  channel_id = excluded.channel_id,
                  ping_role_id = excluded.ping_role_id,
                  stores = excluded.stores,
                  include_dlc = excluded.include_dlc,
                  include_beta = excluded.include_beta,
                  include_mobile = excluded.include_mobile`)
      .run(s.guildId, s.channelId, s.pingRoleId, JSON.stringify(s.stores), s.includeDlc ? 1 : 0, s.includeBeta ? 1 : 0, s.includeMobile ? 1 : 0);
  }

  isFreePosted(guildId: string, gameKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM free_posted WHERE guild_id = ? AND game_key = ?').get(guildId, gameKey) !== undefined;
  }

  /** Record games as announced; returns how many were newly recorded. */
  markFreePosted(guildId: string, gameKeys: string[], ts = Date.now()): number {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO free_posted (guild_id, game_key, posted_at) VALUES (?, ?, ?)');
    let added = 0;
    for (const key of gameKeys) added += Number(stmt.run(guildId, key, ts).changes);
    return added;
  }

  countFreePosted(guildId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM free_posted WHERE guild_id = ?').get(guildId) as { n: number }).n;
  }

  // ---- embed conversion log -------------------------------------------

  logEmbed(row: Omit<EmbedLogRow, 'id'>): void {
    this.db.prepare('INSERT INTO embed_log (guild_id, channel_id, message_id, url, provider, ts) VALUES (?, ?, ?, ?, ?, ?)').run(
      row.guildId, row.channelId, row.messageId, row.url, row.provider, row.ts,
    );
  }

  recentEmbeds(guildId: string, limit: number, offset = 0): EmbedLogRow[] {
    return this.db
      .prepare('SELECT id, guild_id AS guildId, channel_id AS channelId, message_id AS messageId, url, provider, ts FROM embed_log WHERE guild_id = ? ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?')
      .all(guildId, limit, offset) as unknown as EmbedLogRow[];
  }

  countEmbeds(guildId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM embed_log WHERE guild_id = ?').get(guildId) as { n: number };
    return row.n;
  }

  // ---- key/value bot state --------------------------------------------

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db.prepare('INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- dashboard web sessions -------------------------------------------

  saveWebSession(s: WebSessionRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO web_sessions (sid, user_id, username, avatar, access_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(s.sid, s.userId, s.username, s.avatar, s.accessToken, s.createdAt, s.expiresAt);
  }

  /** Non-expired sessions oldest first; expired rows are deleted along the way. */
  loadWebSessions(now = Date.now()): WebSessionRow[] {
    this.db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now);
    return this.db
      .prepare('SELECT sid, user_id AS userId, username, avatar, access_token AS accessToken, created_at AS createdAt, expires_at AS expiresAt FROM web_sessions ORDER BY created_at')
      .all() as unknown as WebSessionRow[];
  }

  deleteWebSessionsForUser(userId: string): void {
    this.db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(userId);
  }

  // ---- self-building (build_jobs) -------------------------------------

  getBuilderSettings(): BuilderSettings {
    const model = this.getState('builder:model');
    const chatModel = this.getState('chat:model');
    const decisionModel = this.getState('chat:decisionModel');
    return {
      enabled: this.getState('builder:enabled') === '1',
      model: model && model.length > 0 ? model : DEFAULT_BUILDER_MODEL,
      chatEnabled: this.getState('chat:enabled') === '1',
      chatModel: chatModel && chatModel.length > 0 ? chatModel : DEFAULT_CHAT_MODEL,
      chatDecisionModel: decisionModel && decisionModel.length > 0 ? decisionModel : DEFAULT_CHAT_DECISION_MODEL,
      maxParallelBuilds: clampMaxParallel(Number(this.getState('builder:maxParallel') ?? DEFAULT_MAX_PARALLEL_BUILDS)),
      limitThreshold: this.getState('builder:limitThreshold') ? clampLimitThreshold(Number(this.getState('builder:limitThreshold'))) : DEFAULT_LIMIT_THRESHOLD,
      chatLanguages: parseChatLanguages(this.getState('chat:languages')),
    };
  }

  setBuilderSettings(s: BuilderSettings): void {
    this.setState('builder:enabled', s.enabled ? '1' : '0');
    this.setState('builder:model', s.model.trim().length > 0 ? s.model.trim() : DEFAULT_BUILDER_MODEL);
    this.setState('chat:enabled', s.chatEnabled ? '1' : '0');
    this.setState('chat:model', s.chatModel.trim().length > 0 ? s.chatModel.trim() : DEFAULT_CHAT_MODEL);
    this.setState('chat:decisionModel', s.chatDecisionModel.trim().length > 0 ? s.chatDecisionModel.trim() : DEFAULT_CHAT_DECISION_MODEL);
    this.setState('builder:maxParallel', String(clampMaxParallel(s.maxParallelBuilds)));
    this.setState('builder:limitThreshold', String(clampLimitThreshold(s.limitThreshold)));
    this.setState('chat:languages', JSON.stringify(s.chatLanguages));
  }

  createBuildJob(j: { guildId: string; threadId: string; channelId: string; requesterId: string; request: string; triggerMessageId?: string | null }, now = Date.now()): BuildJob {
    const res = this.db
      .prepare(`INSERT INTO build_jobs (guild_id, thread_id, channel_id, requester_id, request, trigger_message_id, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?)`)
      .run(j.guildId, j.threadId, j.channelId, j.requesterId, j.request, j.triggerMessageId ?? null, now, now);
    return this.getBuildJob(Number(res.lastInsertRowid)) as BuildJob;
  }

  getBuildJob(id: number): BuildJob | null {
    const row = this.db.prepare('SELECT * FROM build_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? buildJobFromRow(row) : null;
  }

  getBuildJobByThread(threadId: string): BuildJob | null {
    // A thread can hold several jobs over time; the newest one is the one that matters.
    const row = this.db.prepare('SELECT * FROM build_jobs WHERE thread_id = ? ORDER BY id DESC LIMIT 1').get(threadId) as Record<string, unknown> | undefined;
    return row ? buildJobFromRow(row) : null;
  }

  setBuildJobStatus(id: number, status: BuildJobStatus, now = Date.now()): void {
    this.db.prepare('UPDATE build_jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }

  updateBuildJob(id: number, patch: BuildJobPatch, now = Date.now()): void {
    const cols: Record<keyof BuildJobPatch, string> = {
      title: 'title',
      sessionId: 'session_id',
      worktreeDir: 'worktree_dir',
      branch: 'branch',
      prUrl: 'pr_url',
      error: 'error',
      model: 'model',
      approvedAt: 'approved_at',
      resumeCount: 'resume_count',
      fixAttempts: 'fix_attempts',
      conflictNotified: 'conflict_notified',
      triggerMessageId: 'trigger_message_id',
      planMessageId: 'plan_message_id',
      planPostedAt: 'plan_posted_at',
      lastPlan: 'last_plan',
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of Object.keys(cols) as (keyof BuildJobPatch)[]) {
      const v = patch[key];
      if (v === undefined) continue;
      sets.push(`${cols[key]} = ?`);
      values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE build_jobs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now, id);
  }

  /** Overwrite the stored usage with the session totals reported by OpenCode. */
  setBuildJobUsage(id: number, u: BuildUsage, now = Date.now()): void {
    this.db
      .prepare(`UPDATE build_jobs SET tokens_input = ?, tokens_output = ?, tokens_reasoning = ?, tokens_cache_read = ?,
                tokens_cache_write = ?, cost_usd = ?, updated_at = ? WHERE id = ?`)
      .run(u.input, u.output, u.reasoning, u.cacheRead, u.cacheWrite, u.costUsd, now, id);
  }

  /** The non-terminal job (planning / awaiting_input / queued / building) of a thread, if any. */
  activeBuildJobInThread(threadId: string): BuildJob | null {
    const marks = ACTIVE_BUILD_STATUSES.map(() => '?').join(', ');
    const row = this.db
      .prepare(`SELECT * FROM build_jobs WHERE thread_id = ? AND status IN (${marks}) ORDER BY id DESC LIMIT 1`)
      .get(threadId, ...ACTIVE_BUILD_STATUSES) as Record<string, unknown> | undefined;
    return row ? buildJobFromRow(row) : null;
  }

  /** Jobs currently using a build slot (builds and conflict fixes). */
  countBuildingJobs(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM build_jobs WHERE status = 'building'`).get() as { n: number }).n;
  }

  listBuildJobsByStatus(statuses: BuildJobStatus[]): BuildJob[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT * FROM build_jobs WHERE status IN (${marks}) ORDER BY id`).all(...statuses) as Record<string, unknown>[];
    return rows.map(buildJobFromRow);
  }

  /** Newest first, for the dashboard. */
  recentBuildJobs(guildId: string, limit: number, offset = 0): BuildJob[] {
    const rows = this.db
      .prepare('SELECT * FROM build_jobs WHERE guild_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(guildId, limit, offset) as Record<string, unknown>[];
    return rows.map(buildJobFromRow);
  }

  buildUsageTotals(guildId: string): BuildUsage & { jobs: number } {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS jobs, COALESCE(SUM(tokens_input), 0) AS i, COALESCE(SUM(tokens_output), 0) AS o,
                COALESCE(SUM(tokens_reasoning), 0) AS r, COALESCE(SUM(tokens_cache_read), 0) AS cr,
                COALESCE(SUM(tokens_cache_write), 0) AS cw, COALESCE(SUM(cost_usd), 0) AS c
                FROM build_jobs WHERE guild_id = ?`)
      .get(guildId) as { jobs: number; i: number; o: number; r: number; cr: number; cw: number; c: number };
    return { jobs: r.jobs, input: r.i, output: r.o, reasoning: r.r, cacheRead: r.cr, cacheWrite: r.cw, costUsd: r.c };
  }

  // ---- chat threads (AI assistant) ------------------------------------

  createChatThread(c: { threadId: string; guildId: string; channelId: string; sessionId: string; startedBy: string; model: string | null; oneOff?: boolean }, now = Date.now()): ChatThread {
    this.db
      .prepare(`INSERT INTO chat_threads (thread_id, guild_id, channel_id, session_id, started_by, model, one_off, created_at, last_active_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.threadId, c.guildId, c.channelId, c.sessionId, c.startedBy, c.model, c.oneOff ? 1 : 0, now, now);
    return this.getChatThread(c.threadId) as ChatThread;
  }

  getChatThread(threadId: string): ChatThread | null {
    const row = this.db.prepare('SELECT * FROM chat_threads WHERE thread_id = ?').get(threadId) as Record<string, unknown> | undefined;
    return row ? chatThreadFromRow(row) : null;
  }

  /** Overwrite the stored usage with the session totals and mark the thread active. */
  setChatThreadUsage(threadId: string, u: BuildUsage, now = Date.now()): void {
    this.db
      .prepare(`UPDATE chat_threads SET tokens_input = ?, tokens_output = ?, tokens_reasoning = ?, tokens_cache_read = ?,
                tokens_cache_write = ?, cost_usd = ?, last_active_at = ? WHERE thread_id = ?`)
      .run(u.input, u.output, u.reasoning, u.cacheRead, u.cacheWrite, u.costUsd, now, threadId);
  }

  /** Queue a context note (e.g. a build update) for the thread's chat session. False when the thread has no chat. */
  addChatNote(threadId: string, note: string): boolean {
    const row = this.db.prepare('SELECT pending_notes FROM chat_threads WHERE thread_id = ?').get(threadId) as { pending_notes: string } | undefined;
    if (!row) return false;
    const notes = parseNotes(row.pending_notes);
    notes.push(note);
    this.db.prepare('UPDATE chat_threads SET pending_notes = ? WHERE thread_id = ?').run(JSON.stringify(notes), threadId);
    return true;
  }

  pendingChatNotes(threadId: string): string[] {
    const row = this.db.prepare('SELECT pending_notes FROM chat_threads WHERE thread_id = ?').get(threadId) as { pending_notes: string } | undefined;
    return row ? parseNotes(row.pending_notes) : [];
  }

  /** Drop the first `count` pending notes (those that were sent); notes queued meanwhile stay. */
  consumeChatNotes(threadId: string, count: number): void {
    const notes = this.pendingChatNotes(threadId).slice(count);
    this.db.prepare('UPDATE chat_threads SET pending_notes = ? WHERE thread_id = ?').run(JSON.stringify(notes), threadId);
  }

  /** The build job or chat thread of `guildId` that owns an OpenCode session id; null for any other id. */
  findSessionOwner(guildId: string, sessionId: string): { kind: 'job'; job: BuildJob } | { kind: 'chat'; thread: ChatThread } | null {
    const job = this.db.prepare('SELECT * FROM build_jobs WHERE guild_id = ? AND session_id = ? ORDER BY id DESC LIMIT 1').get(guildId, sessionId) as Record<string, unknown> | undefined;
    if (job) return { kind: 'job', job: buildJobFromRow(job) };
    const chat = this.db.prepare('SELECT * FROM chat_threads WHERE guild_id = ? AND session_id = ? ORDER BY last_active_at DESC LIMIT 1').get(guildId, sessionId) as Record<string, unknown> | undefined;
    return chat ? { kind: 'chat', thread: chatThreadFromRow(chat) } : null;
  }

  /** Most recently active first. */
  recentChatThreads(guildId: string, limit: number): ChatThread[] {
    const rows = this.db.prepare('SELECT * FROM chat_threads WHERE guild_id = ? ORDER BY last_active_at DESC LIMIT ?').all(guildId, limit) as Record<string, unknown>[];
    return rows.map(chatThreadFromRow);
  }

  /** `threads` counts real chat threads; one-off replies add to the token/cost totals only. */
  chatUsageTotals(guildId: string): BuildUsage & { threads: number; oneOffs: number } {
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(CASE WHEN one_off = 0 THEN 1 ELSE 0 END), 0) AS threads, COALESCE(SUM(one_off), 0) AS oneoffs,
                COALESCE(SUM(tokens_input), 0) AS i, COALESCE(SUM(tokens_output), 0) AS o,
                COALESCE(SUM(tokens_reasoning), 0) AS r, COALESCE(SUM(tokens_cache_read), 0) AS cr,
                COALESCE(SUM(tokens_cache_write), 0) AS cw, COALESCE(SUM(cost_usd), 0) AS c
                FROM chat_threads WHERE guild_id = ?`)
      .get(guildId) as { threads: number; oneoffs: number; i: number; o: number; r: number; cr: number; cw: number; c: number };
    return { threads: r.threads, oneOffs: r.oneoffs, input: r.i, output: r.o, reasoning: r.r, cacheRead: r.cr, cacheWrite: r.cw, costUsd: r.c };
  }

  // ---- captured console logs ------------------------------------------

  private logInserts = 0;

  addLog(entry: { ts: number; level: LogLevel; tag: string | null; message: string }): void {
    this.db.prepare('INSERT INTO logs (ts, level, tag, message) VALUES (?, ?, ?, ?)').run(entry.ts, entry.level, entry.tag, entry.message);
    if (++this.logInserts % 100 === 0) this.pruneLogs(MAX_LOG_ROWS);
  }

  /** Newest first. `level` 'warn' means warn + error. */
  recentLogs(opts: { limit: number; level?: 'all' | 'warn' | 'error'; tag?: string | null }): LogRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.level === 'error') where.push(`level = 'error'`);
    else if (opts.level === 'warn') where.push(`level IN ('warn', 'error')`);
    if (opts.tag) {
      where.push('tag = ?');
      params.push(opts.tag);
    }
    const sql = `SELECT id, ts, level, tag, message FROM logs${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, opts.limit) as unknown as LogRow[];
  }

  /** Distinct tags seen in the stored logs, for the filter UI. */
  logTags(): string[] {
    return (this.db.prepare('SELECT DISTINCT tag FROM logs WHERE tag IS NOT NULL ORDER BY tag').all() as { tag: string }[]).map((r) => r.tag);
  }

  countLogErrorsSince(since: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM logs WHERE level = 'error' AND ts >= ?`).get(since) as { n: number };
    return row.n;
  }

  /** Keeps only the newest `keep` rows. */
  pruneLogs(keep: number): void {
    this.db.prepare('DELETE FROM logs WHERE id <= (SELECT COALESCE(MAX(id), 0) - ? FROM logs)').run(keep);
  }
}
