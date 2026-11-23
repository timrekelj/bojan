import type { UserRow } from './db.js';

// ---- timezone helpers ---------------------------------------------------

/** Offset of `timeZone` from UTC, in ms, at the given instant. */
export function tzOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - date.getTime();
}

/** UTC timestamp of local wall-clock time in `timeZone`. */
export function zonedToUtcMs(timeZone: string, y: number, mo: number, d: number, h = 0, mi = 0): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - tzOffsetMs(timeZone, new Date(guess));
  ts = guess - tzOffsetMs(timeZone, new Date(ts)); // refine across DST edge
  return ts;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local (in `timeZone`) calendar date parts + weekday of an instant. */
export function localParts(timeZone: string, date: Date): { y: number; mo: number; d: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), weekday: WEEKDAY_INDEX[parts.weekday ?? ''] ?? 0 };
}

/** Monday (YYYY-MM-DD) of the week containing `date`, in `timeZone`. Weeks start Monday. */
export function weekKey(timeZone: string, date: Date): string {
  const { y, mo, d, weekday } = localParts(timeZone, date);
  const daysSinceMonday = (weekday + 6) % 7;
  const mondayUtc = Date.UTC(y, mo - 1, d - daysSinceMonday);
  const m = new Date(mondayUtc);
  return `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}-${String(m.getUTCDate()).padStart(2, '0')}`;
}

export interface WeekBounds {
  start: number; // inclusive, UTC ms
  end: number; // exclusive, UTC ms
  key: string; // YYYY-MM-DD of week start (local)
}

/** The most recently completed Monday-Sunday week in `timeZone`. */
export function lastWeekBounds(timeZone: string, now = new Date()): WeekBounds {
  const thisMonday = weekKey(timeZone, now);
  const [y, mo, d] = thisMonday.split('-').map(Number) as [number, number, number];
  const start = zonedToUtcMs(timeZone, y, mo, d) - 7 * 86_400_000;
  const end = zonedToUtcMs(timeZone, y, mo, d);
  const prev = new Date(start);
  const key = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
  return { start, end, key };
}

/** The current, in-progress week. */
export function currentWeekBounds(timeZone: string, now = new Date()): WeekBounds {
  const key = weekKey(timeZone, now);
  const [y, mo, d] = key.split('-').map(Number) as [number, number, number];
  const start = zonedToUtcMs(timeZone, y, mo, d);
  return { start, end: start + 7 * 86_400_000, key };
}

// ---- formatting ---------------------------------------------------------

export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtDate(ts: number | null, timeZone: string): string {
  if (ts === null) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
}

/** Human duration for a millisecond span: "2d 4h", "3h 12m", "45m", "<1m". */
export function fmtDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1m';
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** Label + emoji for a discord.js ActivityType (0=Playing … 5=Competing). */
export function activityTypeLabel(type: number): string {
  switch (type) {
    case 0: return '🎮 Playing';
    case 1: return '📺 Streaming';
    case 2: return '🎧 Listening to';
    case 3: return '👀 Watching';
    case 4: return '💬';
    case 5: return '🏆 Competing in';
    default: return '📱';
  }
}

export function weekRangeLabel(b: WeekBounds, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone, month: 'short', day: 'numeric' };
  const a = new Intl.DateTimeFormat('en-GB', opts).format(new Date(b.start));
  const endMinus1 = new Date(b.end - 1);
  const bb = new Intl.DateTimeFormat('en-GB', { ...opts, year: 'numeric' }).format(endMinus1);
  return `${a} – ${bb}`;
}

/** The 7 local days of a week (Mon..Sun) with a YYYY-MM-DD key and a short label. */
export function daySeries(week: WeekBounds, timeZone: string): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(week.start + i * 86_400_000);
    const p = localParts(timeZone, d);
    const key = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    const label = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric' }).format(d);
    out.push({ key, label });
  }
  return out;
}

/** Leaderboard lines, e.g. "**1.** <@123> — **1,234** (35.5%)". */
export function leaderboardLines(rows: UserRow[], total: number): string[] {
  if (rows.length === 0) return ['No messages recorded yet.'];
  const medals = ['🥇', '🥈', '🥉'];
  return rows.map((r, i) => {
    const medal = medals[i] ?? `**${i + 1}.**`;
    const share = total > 0 ? ` (${((r.messages / total) * 100).toFixed(1)}%)` : '';
    return `${medal} <@${r.userId}> — **${fmt(r.messages)}**${share}`;
  });
}
