import type { EditDeleteRow, MessageActivityRow, VoiceRangeRow } from './db.js';

// Pure computations for the monthly recap. Every ranking is deterministic:
// ties are broken by userId ASC (pairs by a, then b).

const MINUTE_MS = 60_000;

/** Night owls: messages with local hour in [NIGHT_START, NIGHT_END). */
export const NIGHT_START_HOUR = 0;
export const NIGHT_END_HOUR = 5;
/** Early birds: messages with local hour in [EARLY_START, EARLY_END). */
export const EARLY_START_HOUR = 5;
export const EARLY_END_HOUR = 8;
/** A message after at least this much channel silence starts a conversation. */
export const CONVO_GAP_MS = 3_600_000;
/** Members need this many (word-counted) messages to compete for novelist / one-worder. */
export const NOVELIST_MIN_MESSAGES = 20;
/** Voice buddies need at least this much shared time. */
export const BUDDY_MIN_MS = MINUTE_MS;

export interface LocalTime {
  hour: number; // 0-23
  weekday: number; // 0 = Mon .. 6 = Sun
  dayKey: string; // YYYY-MM-DD (local)
}

const WEEKDAY_MON0: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** A fast converter ts -> local hour/weekday/day key. One cached formatter; results cached per minute. */
export function localHourWeekday(timeZone: string): (ts: number) => LocalTime {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit',
  });
  // UTC offsets are whole minutes, so local hour/day cannot change inside a UTC minute: cache per minute.
  const cache = new Map<number, LocalTime>();
  return (ts: number): LocalTime => {
    const bucket = Math.floor(ts / MINUTE_MS);
    const hit = cache.get(bucket);
    if (hit) return hit;
    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(new Date(bucket * MINUTE_MS))) parts[p.type] = p.value;
    const out: LocalTime = {
      hour: Number(parts.hour) % 24,
      weekday: WEEKDAY_MON0[parts.weekday ?? ''] ?? 0,
      dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    };
    if (cache.size > 200_000) cache.clear();
    cache.set(bucket, out);
    return out;
  };
}

function byCountThenUser<T extends { userId: string }>(rows: T[], value: (r: T) => number): T[] {
  return rows.sort((x, y) => value(y) - value(x) || (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0));
}

function countByUser(userIds: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const u of userIds) m.set(u, (m.get(u) ?? 0) + 1);
  return m;
}

function rankCounts(m: Map<string, number>, limit: number): { userId: string; count: number }[] {
  return byCountThenUser([...m].map(([userId, count]) => ({ userId, count })), (r) => r.count).slice(0, limit);
}

function hourRange(rows: MessageActivityRow[], tz: string, from: number, to: number, limit: number): { userId: string; count: number }[] {
  const local = localHourWeekday(tz);
  const users: string[] = [];
  for (const r of rows) {
    const h = local(r.ts).hour;
    if (h >= from && h < to) users.push(r.userId);
  }
  return rankCounts(countByUser(users), limit);
}

/** Most messages with a local hour in [0, 5). */
export function nightOwls(rows: MessageActivityRow[], tz: string, limit: number): { userId: string; count: number }[] {
  return hourRange(rows, tz, NIGHT_START_HOUR, NIGHT_END_HOUR, limit);
}

/** Most messages with a local hour in [5, 8). */
export function earlyBirds(rows: MessageActivityRow[], tz: string, limit: number): { userId: string; count: number }[] {
  return hourRange(rows, tz, EARLY_START_HOUR, EARLY_END_HOUR, limit);
}

/**
 * Who opens conversations. `rows` are sorted by ts and may start up to `gapMs` before
 * `fromTs` (lookback). A message in [fromTs, toTs) counts when the previous message in
 * the same channel (within `rows`) is at least `gapMs` earlier, or there is none.
 */
export function conversationStarters(
  rows: MessageActivityRow[],
  fromTs: number,
  toTs: number,
  limit: number,
  gapMs = CONVO_GAP_MS,
): { userId: string; count: number }[] {
  const lastInChannel = new Map<string, number>();
  const starters: string[] = [];
  for (const r of rows) {
    const prev = lastInChannel.get(r.channelId);
    lastInChannel.set(r.channelId, r.ts);
    if (r.ts < fromTs || r.ts >= toTs) continue;
    if (prev === undefined || r.ts - prev >= gapMs) starters.push(r.userId);
  }
  return rankCounts(countByUser(starters), limit);
}

function dayNumber(dayKey: string): number {
  const [y, mo, d] = dayKey.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, mo - 1, d) / 86_400_000);
}

/** Longest run of consecutive local days with at least one message, per user (runs of 2+ days only). */
export function longestStreaks(rows: MessageActivityRow[], tz: string, limit: number): { userId: string; days: number }[] {
  const local = localHourWeekday(tz);
  const daysByUser = new Map<string, Set<number>>();
  for (const r of rows) {
    let s = daysByUser.get(r.userId);
    if (!s) daysByUser.set(r.userId, (s = new Set()));
    s.add(dayNumber(local(r.ts).dayKey));
  }
  const out: { userId: string; days: number }[] = [];
  for (const [userId, set] of daysByUser) {
    const sorted = [...set].sort((a, b) => a - b);
    let best = 0;
    let run = 0;
    let prev = Number.NaN;
    for (const d of sorted) {
      run = d === prev + 1 ? run + 1 : 1;
      prev = d;
      if (run > best) best = run;
    }
    if (best >= 2) out.push({ userId, days: best });
  }
  return byCountThenUser(out, (r) => r.days).slice(0, limit);
}

/** 7 rows (Mon..Sun) x 24 hours of message counts. */
export function activityHeatmap(rows: MessageActivityRow[], tz: string): number[][] {
  const local = localHourWeekday(tz);
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const r of rows) {
    const t = local(r.ts);
    grid[t.weekday]![t.hour]!++;
  }
  return grid;
}

export interface HeatmapPeaks {
  peak: { day: number; hour: number; count: number }; // busiest single slot
  busiestDay: number; // weekday index 0 = Mon .. 6 = Sun with the most messages overall
  busiestDayCount: number;
  busiestHour: number; // hour 0-23 with the most messages summed across weekdays
  busiestHourCount: number;
}

/** Peaks of a heatmap grid, or null when it is empty. Ties go to the lowest index. */
export function heatmapPeaks(grid: number[][]): HeatmapPeaks | null {
  let peak: HeatmapPeaks['peak'] | null = null;
  const dayTotals = new Array<number>(7).fill(0);
  const hourTotals = new Array<number>(24).fill(0);
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const c = grid[d]?.[h] ?? 0;
      dayTotals[d]! += c;
      hourTotals[h]! += c;
      if (c > 0 && (!peak || c > peak.count)) peak = { day: d, hour: h, count: c };
    }
  }
  if (!peak) return null;
  let busiestDay = 0;
  for (let d = 1; d < 7; d++) if (dayTotals[d]! > dayTotals[busiestDay]!) busiestDay = d;
  let busiestHour = 0;
  for (let h = 1; h < 24; h++) if (hourTotals[h]! > hourTotals[busiestHour]!) busiestHour = h;
  return {
    peak,
    busiestDay,
    busiestDayCount: dayTotals[busiestDay]!,
    busiestHour,
    busiestHourCount: hourTotals[busiestHour]!,
  };
}

// ---- voice --------------------------------------------------------------

type Interval = [number, number];

function mergeIntervals(iv: Interval[]): Interval[] {
  iv.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Interval[] = [];
  for (const [s, e] of iv) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

function clipped(sessions: VoiceRangeRow[], fromTs: number, toTs: number, afk?: string | null): VoiceRangeRow[] {
  const out: VoiceRangeRow[] = [];
  for (const s of sessions) {
    if (afk && s.channelId === afk) continue;
    const start = Math.max(s.start, fromTs);
    const end = Math.min(s.end, toTs);
    if (end > start) out.push({ userId: s.userId, channelId: s.channelId, start, end });
  }
  return out;
}

/** Merged (non-overlapping) voice time per user within [fromTs, toTs), AFK channel excluded. */
function voiceMsByUser(sessions: VoiceRangeRow[], fromTs: number, toTs: number, afk?: string | null): Map<string, number> {
  const byUser = new Map<string, Interval[]>();
  for (const s of clipped(sessions, fromTs, toTs, afk)) {
    let l = byUser.get(s.userId);
    if (!l) byUser.set(s.userId, (l = []));
    l.push([s.start, s.end]);
  }
  const out = new Map<string, number>();
  for (const [u, iv] of byUser) {
    let ms = 0;
    for (const [s, e] of mergeIntervals(iv)) ms += e - s;
    if (ms > 0) out.set(u, ms);
  }
  return out;
}

/** Voice time per user in the range (clipped, AFK skipped, overlaps merged), ranked desc. */
export function voiceTotals(
  sessions: VoiceRangeRow[],
  fromTs: number,
  toTs: number,
  limit: number,
  afkChannelId?: string | null,
): { userId: string; ms: number }[] {
  const rows = [...voiceMsByUser(sessions, fromTs, toTs, afkChannelId)].map(([userId, ms]) => ({ userId, ms }));
  return byCountThenUser(rows, (r) => r.ms).slice(0, limit);
}

/** Server-wide voice time: the sum of every user's merged voice time. */
export function voiceTotalMs(sessions: VoiceRangeRow[], fromTs: number, toTs: number, afkChannelId?: string | null): number {
  let total = 0;
  for (const ms of voiceMsByUser(sessions, fromTs, toTs, afkChannelId).values()) total += ms;
  return total;
}

/**
 * Time two different users spent in the same channel at the same time, summed per
 * unordered pair across channels. Sweeps each channel separately.
 */
export function voiceBuddies(
  sessions: VoiceRangeRow[],
  fromTs: number,
  toTs: number,
  limit: number,
  afkChannelId?: string | null,
): { a: string; b: string; ms: number }[] {
  // channel -> user -> intervals
  const byChannel = new Map<string, Map<string, Interval[]>>();
  for (const s of clipped(sessions, fromTs, toTs, afkChannelId)) {
    let users = byChannel.get(s.channelId);
    if (!users) byChannel.set(s.channelId, (users = new Map()));
    let l = users.get(s.userId);
    if (!l) users.set(s.userId, (l = []));
    l.push([s.start, s.end]);
  }

  const pairMs = new Map<string, { a: string; b: string; ms: number }>();
  for (const users of byChannel.values()) {
    if (users.size < 2) continue;
    // Events: [time, delta, user]; ends sort before starts at the same instant.
    const events: [number, number, string][] = [];
    for (const [u, iv] of users) {
      for (const [s, e] of mergeIntervals(iv)) {
        events.push([s, 1, u], [e, -1, u]);
      }
    }
    events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const active = new Set<string>();
    let prevT = 0;
    for (const [t, delta, u] of events) {
      const dt = t - prevT;
      if (dt > 0 && active.size >= 2) {
        const list = [...active].sort();
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i]!;
            const b = list[j]!;
            const k = `${a}\u0000${b}`;
            const cur = pairMs.get(k);
            if (cur) cur.ms += dt;
            else pairMs.set(k, { a, b, ms: dt });
          }
        }
      }
      prevT = t;
      if (delta > 0) active.add(u);
      else active.delete(u);
    }
  }

  return [...pairMs.values()]
    .filter((p) => p.ms >= BUDDY_MIN_MS)
    .sort((x, y) => y.ms - x.ms || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || (x.b < y.b ? -1 : x.b > y.b ? 1 : 0))
    .slice(0, limit);
}

// ---- message length -----------------------------------------------------

interface WordStats {
  userId: string;
  messages: number;
  words: number;
  oneWord: number;
}

function wordStats(rows: MessageActivityRow[], minMessages: number): WordStats[] {
  const m = new Map<string, WordStats>();
  for (const r of rows) {
    if (r.words == null || r.words <= 0) continue;
    let s = m.get(r.userId);
    if (!s) m.set(r.userId, (s = { userId: r.userId, messages: 0, words: 0, oneWord: 0 }));
    s.messages++;
    s.words += r.words;
    if (r.words === 1) s.oneWord++;
  }
  return [...m.values()].filter((s) => s.messages >= minMessages);
}

/** Highest average words per message (only messages with a known, positive word count). */
export function novelists(
  rows: MessageActivityRow[],
  limit: number,
  minMessages = NOVELIST_MIN_MESSAGES,
): { userId: string; avgWords: number; messages: number }[] {
  const out = wordStats(rows, minMessages).map((s) => ({ userId: s.userId, avgWords: s.words / s.messages, messages: s.messages }));
  return byCountThenUser(out, (r) => r.avgWords).slice(0, limit);
}

/** Highest share of one-word messages, then most one-word messages. Share 0 is dropped. */
export function oneWorders(
  rows: MessageActivityRow[],
  limit: number,
  minMessages = NOVELIST_MIN_MESSAGES,
): { userId: string; share: number; oneWord: number; messages: number }[] {
  const out = wordStats(rows, minMessages)
    .filter((s) => s.oneWord > 0)
    .map((s) => ({ userId: s.userId, share: s.oneWord / s.messages, oneWord: s.oneWord, messages: s.messages }));
  return out
    .sort((x, y) => y.share - x.share || y.oneWord - x.oneWord || (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0))
    .slice(0, limit);
}

/** Most edits + deletes, then most edits. Rows with nothing are dropped. */
export function typoKings(rows: EditDeleteRow[], limit: number): EditDeleteRow[] {
  return rows
    .filter((r) => r.edits + r.deletes > 0)
    .sort((x, y) => y.edits + y.deletes - (x.edits + x.deletes) || y.edits - x.edits || (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0))
    .slice(0, limit);
}
