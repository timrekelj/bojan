import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { localParts } from './stats.js';

export interface Settings {
  guildId: string;
  statsChannelId: string | null;
  weeklyEnabled: boolean;
  weeklyDay: number; // 0 = Sunday ... 6 = Saturday
  weeklyHour: number; // 0-23, local time
  timezone: string;
  embedChannels: string[];
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
  embed_channels TEXT NOT NULL DEFAULT '[]'
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

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS: Omit<Settings, 'guildId'> = {
  statsChannelId: null,
  weeklyEnabled: true,
  weeklyDay: 1, // Monday
  weeklyHour: 9,
  timezone: 'UTC',
  embedChannels: [],
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
    // Migration for databases created before message_id existed.
    const cols = this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'message_id')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN message_id TEXT');
    }
    // Dedup key: the same Discord message must never be counted twice
    // (live tracking + backfill can overlap).
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_guild_msg ON messages (guild_id, message_id)');
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

  // ---- settings -------------------------------------------------------

  getSettings(guildId: string): Settings {
    const row = this.db.prepare('SELECT * FROM settings WHERE guild_id = ?').get(guildId) as
      | { stats_channel_id: string | null; weekly_enabled: number; weekly_day: number; weekly_hour: number; timezone: string; embed_channels: string }
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
    };
  }

  saveSettings(s: Settings): void {
    this.db
      .prepare(`INSERT INTO settings (guild_id, stats_channel_id, weekly_enabled, weekly_day, weekly_hour, timezone, embed_channels)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(guild_id) DO UPDATE SET
                  stats_channel_id = excluded.stats_channel_id,
                  weekly_enabled = excluded.weekly_enabled,
                  weekly_day = excluded.weekly_day,
                  weekly_hour = excluded.weekly_hour,
                  timezone = excluded.timezone,
                  embed_channels = excluded.embed_channels`)
      .run(s.guildId, s.statsChannelId, s.weeklyEnabled ? 1 : 0, s.weeklyDay, s.weeklyHour, s.timezone, JSON.stringify(s.embedChannels));
  }

  // ---- embed conversion log -------------------------------------------

  logEmbed(row: Omit<EmbedLogRow, 'id'>): void {
    this.db.prepare('INSERT INTO embed_log (guild_id, channel_id, message_id, url, provider, ts) VALUES (?, ?, ?, ?, ?, ?)').run(
      row.guildId, row.channelId, row.messageId, row.url, row.provider, row.ts,
    );
  }

  recentEmbeds(guildId: string, limit: number, offset = 0): EmbedLogRow[] {
    return this.db
      .prepare('SELECT * FROM embed_log WHERE guild_id = ? ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?')
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
}
