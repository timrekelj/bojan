import type { Settings, UserRow, UserStats, EmbedLogRow, EmojiRow, ReactionStats, VoiceStats, VoiceChannelRow, CurrentVoiceRow, ActivityAggregateRow, CurrentActivityRow } from '../db.js';
import { activityTypeLabel, fmt, fmtDate, fmtDuration, lastWeekBounds, weekRangeLabel } from '../stats.js';
import { ALL_STORES, STORE_LABELS, type FreeSettings } from '../freegames/types.js';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `
  :root {
    color-scheme: dark light;
    --bg: #1a1a1e; --chrome: #17171b; --raised: #27272b; --input: rgba(255,255,255,.06); --soft: rgba(255,255,255,.08);
    --border: rgba(255,255,255,.10); --border-strong: rgba(255,255,255,.25);
    --text: #fff; --text-2: #ccccd1; --muted: #a1a1aa;
    --btn-bg: #f9f9fa; --btn-fg: #101013; --accent: #fa500f; --success: #3ec979;
    --float: 0 0 0 1px rgba(255,255,255,.1), 0 1px 2px rgba(0,0,0,.2), 0 6px 16px -6px rgba(0,0,0,.28);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #fafaf9; --chrome: #f6f5f3; --raised: #fff; --input: rgba(0,0,0,.04); --soft: #f3f2ef;
      --border: rgba(0,0,0,.10); --border-strong: rgba(0,0,0,.25);
      --text: #18181b; --text-2: #3f3f46; --muted: #71706b;
      --btn-bg: #1a1a1e; --btn-fg: #fff; --success: #1f8a4c;
      --float: 0 0 0 1px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.06), 0 6px 16px -6px rgba(0,0,0,.14);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 400 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  a { color: inherit; text-underline-offset: 3px; text-decoration-color: var(--muted); }
  code { background: var(--soft); padding: 1px 6px; border-radius: 6px; font-size: 12px; }
  .topbar { background: var(--chrome); border-bottom: 1px solid var(--border); }
  .topbar-in { max-width: 960px; margin: 0 auto; padding: 10px 20px; display: flex; align-items: center; gap: 12px; }
  .brand { flex: 1; display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 500; }
  .mark { display: block; flex: none; }
  .auth .mark { margin: 0 auto; }
  .me { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .me img { width: 24px; height: 24px; border-radius: 50%; }
  .me span { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
  .me a { color: var(--muted); font-size: 13px; text-decoration: none; margin-left: 6px; }
  .me a:hover { color: var(--text); text-decoration: underline; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 40px 20px 64px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 36px; }
  .wrap > * { min-width: 0; }
  .wrap > section, .wrap > .cols { border-top: 1px solid var(--border); padding-top: 28px; }
  .wrap > .kpis + .cols { border-top: 0; padding-top: 0; }
  h1 { margin: 0; font-weight: 400; }
  h2 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -.01em; }
  .title { font-size: 32px; line-height: 1.2; letter-spacing: -.02em; }
  .lede { margin: 8px 0 0; color: var(--muted); font-size: 14px; font-variant-numeric: tabular-nums; }
  .head { display: grid; gap: 0; }
  .sec-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; margin-bottom: 14px; }
  .sub, .muted { color: var(--muted); font-size: 13px; }
  .muted { margin: 0; }
  .empty { margin: 0; padding: 4px 0; color: var(--muted); }
  .flash { position: fixed; right: 24px; bottom: 24px; z-index: 50; max-width: min(360px, calc(100vw - 32px)); display: flex; align-items: center; gap: 10px; background: var(--raised); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--float); padding: 12px 16px; font-weight: 500; animation: toast 4.4s ease forwards; }
  @keyframes toast {
    0% { opacity: 0; transform: translateY(8px); visibility: visible; pointer-events: auto; }
    5%, 91% { opacity: 1; transform: translateY(0); visibility: visible; pointer-events: auto; }
    100% { opacity: 0; transform: translateY(0); visibility: hidden; pointer-events: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    @keyframes toast {
      0% { opacity: 0; visibility: visible; pointer-events: auto; }
      5%, 91% { opacity: 1; visibility: visible; pointer-events: auto; }
      100% { opacity: 0; visibility: hidden; pointer-events: none; }
    }
  }
  @media (max-width: 480px) { .flash { left: 16px; right: 16px; bottom: 16px; max-width: none; } }
  .flash::before { content: ''; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--success); }
  .kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .kpi { padding: 18px 20px; border-left: 1px solid var(--border); }
  .kpi:first-child { border-left: 0; padding-left: 0; }
  .kpi span { display: block; color: var(--muted); font-size: 13px; }
  .kpi b { display: block; font-size: 28px; line-height: 1.2; font-weight: 500; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; margin-right: 8px; }
  .dot.ok { background: var(--success); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px 48px; }
  .cols > section { min-width: 0; }
  .lb { list-style: none; margin: 0; padding: 0; }
  .lb li { display: grid; grid-template-columns: 28px 24px minmax(0, 1fr) auto; align-items: center; gap: 4px 10px; padding: 9px 0; border-top: 1px solid var(--border); }
  .lb li:first-child { border-top: 0; }
  .wrap > .kpis + section { border-top: 0; padding-top: 0; }
  #you .kpis { margin-bottom: 14px; }
  .kpi small { display: block; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .you-cols { margin-top: 18px; }
  .you-cols > div { min-width: 0; }
  .mini-h { margin: 0 0 8px; font-size: 13px; font-weight: 500; color: var(--muted); }
  .mini { list-style: none; margin: 0; padding: 0; }
  .mini li { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 6px 0; border-top: 1px solid var(--border); }
  .mini li:first-child { border-top: 0; }
  .mini .name { flex: 1; min-width: 0; }
  .mini .val { flex: none; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .lb li.you .av { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--accent); }
  .lb li.you .name { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--text); }
  .lb li.you .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .lb li.you .rank { color: var(--text); }
  .you-tag { flex: none; color: var(--muted); font-size: 12px; font-weight: 400; }
  .lb li.gap { border-top: 0; padding: 2px 0; }
  .lb li.gap .rank { grid-column: 1; line-height: 1; }
  .lb li.extra { border-top: 0; }
  .rank { color: var(--muted); font-size: 13px; text-align: right; font-variant-numeric: tabular-nums; }
  .top .name { font-weight: 600; }
  .av { width: 24px; height: 24px; border-radius: 50%; background: var(--soft); object-fit: cover; display: grid; place-items: center; font-size: 11px; font-weight: 500; color: var(--muted); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; }
  .share { grid-column: 3 / 5; display: flex; align-items: center; gap: 8px; }
  .bar { flex: 1; height: 2px; background: var(--soft); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); }
  .pct { color: var(--muted); font-size: 12px; min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; }
  .emojis { display: flex; flex-wrap: wrap; gap: 10px 28px; margin: 0 0 14px; padding: 0; list-style: none; }
  .emojis li { display: inline-flex; align-items: center; gap: 8px; font-size: 20px; line-height: 1.3; }
  .emojis small { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .emojis img { width: 20px; height: 20px; }
  .panel { background: var(--raised); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  fieldset + fieldset { margin-top: 24px; padding-top: 22px; border-top: 1px solid var(--border); }
  legend { float: left; width: 100%; padding: 0; font-weight: 600; font-size: 15px; }
  legend + .sub { clear: both; margin: 2px 0 14px; }
  .field { margin-top: 14px; }
  .field > label, .lbl { display: block; font-weight: 500; margin-bottom: 2px; }
  .help { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  select, input[type=text] { width: 100%; max-width: 100%; background: var(--input); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: inherit; }
  select option { background: var(--raised); color: var(--text); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .switch { display: flex; align-items: center; gap: 12px; cursor: pointer; }
  .switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .track { flex: none; width: 36px; height: 20px; border-radius: 999px; background: var(--border-strong); position: relative; transition: background .15s; }
  .track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
  .switch input:checked + .track { background: var(--accent); }
  .switch input:checked + .track::after { transform: translateX(16px); }
  .switch input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 2px 12px; max-height: 240px; overflow: auto; padding: 8px; background: var(--input); border: 1px solid var(--border); border-radius: 8px; }
  .opt { display: flex; align-items: center; gap: 8px; padding: 4px 6px; margin: 0; font-weight: 400; border-radius: 6px; cursor: pointer; min-width: 0; }
  .opt:hover { background: var(--soft); }
  .opt input { accent-color: var(--accent); margin: 0; flex: none; }
  .opt span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { margin-top: 24px; }
  button, .btn { display: inline-block; background: var(--btn-bg); color: var(--btn-fg); border: 0; border-radius: 8px; padding: 9px 16px; font: inherit; font-weight: 500; text-decoration: none; cursor: pointer; box-shadow: inset 0 -1.5px 0 rgba(0,0,0,.08); }
  button:hover, .btn:hover { opacity: .88; }
  .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border-strong); box-shadow: none; opacity: 1; }
  .btn.ghost:hover { background: var(--soft); }
  .pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin-top: 12px; }
  .pager .muted, .pager-nav { font-variant-numeric: tabular-nums; }
  .pager-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
  .pager-btn { display: inline-block; background: var(--soft); color: var(--text); border-radius: 8px; padding: 4px 12px; font-size: 13px; font-weight: 500; text-decoration: none; }
  a.pager-btn:hover { background: var(--border); }
  .pager-btn[aria-disabled=true] { color: var(--muted); opacity: .55; }
  .scroll { overflow-x: auto; max-width: 100%; border: 1px solid var(--border); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 14px; border-top: 1px solid var(--border); white-space: nowrap; }
  th { border-top: 0; color: var(--muted); font-size: 12px; font-weight: 500; }
  td.url { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
  td.url a { display: block; overflow: hidden; text-overflow: ellipsis; text-decoration: none; }
  td.url a:hover { text-decoration: underline; }
  .badge { display: inline-block; background: var(--soft); color: var(--text-2); border-radius: 6px; padding: 1px 8px; font-size: 12px; font-weight: 500; }
  .center { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
  .auth { width: 100%; max-width: 380px; text-align: center; padding: 36px 28px; background: var(--raised); border-radius: 12px; box-shadow: var(--float); }
  .auth h1 { margin: 18px 0 8px; font-size: 24px; letter-spacing: -.02em; }
  .auth p { margin: 0 0 24px; color: var(--muted); }
  @media (max-width: 800px) { .cols { grid-template-columns: 1fr; } }
  @media (max-width: 640px) {
    .kpis { grid-template-columns: 1fr 1fr; }
    .kpi, .kpi:first-child { padding: 14px 16px; border-left: 0; border-top: 1px solid var(--border); }
    .kpi:nth-child(-n+2) { border-top: 0; }
    .kpi:nth-child(odd) { padding-left: 0; }
    .kpi:nth-child(even) { border-left: 1px solid var(--border); }
  }
  @media (max-width: 480px) {
    .wrap { padding: 28px 16px 48px; gap: 28px; }
    .panel { padding: 16px; }
    .topbar-in { padding: 10px 16px; }
    .me span { max-width: 90px; }
    .row { grid-template-columns: 1fr; }
    .title { font-size: 26px; }
  }
`;

// Chunky pixel "B" on a 7x7 grid, drawn as runs of <rect>s.
const MARK_ROWS = ['XXXXXX.', 'XX...XX', 'XX...XX', 'XXXXXX.', 'XX...XX', 'XX...XX', 'XXXXXX.'];

function mark(px: number): string {
  const rects = MARK_ROWS.flatMap((row, y) => Array.from(row.matchAll(/X+/g), (m) => `<rect x="${m.index}" y="${y}" width="${m[0].length}" height="1"/>`));
  return `<svg class="mark" width="${px * 7}" height="${px * 7}" viewBox="0 0 7 7" fill="#fa500f" shape-rendering="crispEdges" aria-hidden="true">${rects.join('')}</svg>`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

function layout(title: string, body: string, user: { username: string; avatar: string }): string {
  const header = `<header class="topbar"><div class="topbar-in"><div class="brand">${mark(3)}Bojan</div><div class="me"><img src="${escapeHtml(user.avatar)}" alt=""><span>${escapeHtml(user.username)}</span><a href="/logout">Log out</a></div></div></header>`;
  return page(title, `${header}<main class="wrap">${body}</main>`);
}

function authCard(title: string, text: string, button: string): string {
  return page(title, `<main class="center"><div class="auth">${mark(5)}<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${button}</div></main>`);
}

export function loginPage(discordAuthUrl: string): string {
  return authCard('Server stats dashboard', 'Sign in with Discord. Only server administrators can access this.', `<a class="btn" href="${escapeHtml(discordAuthUrl)}">Sign in with Discord</a>`);
}

export function errorPage(message: string): string {
  return authCard('Access denied', message, '<a class="btn ghost" href="/login">Try again</a>');
}

export interface DashboardData {
  settings: Settings;
  channels: { id: string; name: string }[];
  botStatus: { ping: number; uptimeSec: number; guilds: number; totalMessages: number; dbBytes: number; lastWeeklySent: string | null; embedsConverted: number };
  today: number;
  week: { bounds: ReturnType<typeof lastWeekBounds>; total: number; rows: UserRow[] };
  allTime: { total: number; rows: UserRow[] };
  reactions: { total: number; top: EmojiRow[] };
  recentEmbeds: EmbedLogRow[];
  embedPage: { page: number; pages: number; total: number; pageSize: number };
  members: Record<string, { name: string; avatar: string | null }>;
  channelNames: Record<string, string>;
  user: { id: string; username: string; avatar: string };
  you: YouData;
  saved: boolean;
  free: {
    settings: FreeSettings;
    roles: { id: string; name: string }[];
    /** Games free now matching the filters; null when the sources couldn't be reached. */
    webhookEnabled: boolean;
    postedCount: number;
    flash: { kind: 'saved' } | null;
  };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const kpi = (value: string, label: string, note?: string): string =>
  `<div class="kpi"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`;

function emptyState(text: string): string {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

/** The logged-in user as seen by a leaderboard: their id and real rank (null = no messages in range). */
export interface LeaderboardYou {
  userId: string;
  rank: { rank: number; messages: number } | null;
}

function lbRow(rank: number, userId: string, messages: number, total: number, members: DashboardData['members'], opts: { top: boolean; you: boolean; extra: boolean }): string {
  const m = members[userId];
  const name = m?.name ?? userId;
  const avatar = m?.avatar
    ? `<img class="av" src="${escapeHtml(m.avatar)}" alt="" loading="lazy">`
    : `<span class="av" aria-hidden="true">${escapeHtml(Array.from(name)[0]?.toUpperCase() ?? '?')}</span>`;
  const pct = total > 0 ? Math.min(100, (messages / total) * 100) : 0;
  const classes = [opts.top ? 'top' : '', opts.you ? 'you' : '', opts.extra ? 'extra' : ''].filter(Boolean).join(' ');
  const nameCell = opts.you
    ? `<span class="name" title="${escapeHtml(name)}"><span class="nm">${escapeHtml(name)}</span><span class="you-tag">You</span></span>`
    : `<span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
  return `<li${classes ? ` class="${classes}"` : ''}${opts.you ? ' aria-current="true"' : ''}><span class="rank">${rank}</span>${avatar}${nameCell}<span class="num">${fmt(messages)}</span><div class="share"><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div><span class="pct">${total > 0 ? pct.toFixed(1) + '%' : '—'}</span></div></li>`;
}

// Pure: plain data in, HTML out. The row of `you` is highlighted; when they rank
// below the shown rows, their real position is appended as a separated extra row.
export function leaderboard(rows: UserRow[], total: number, members: DashboardData['members'], you?: LeaderboardYou): string {
  if (rows.length === 0) return emptyState('No messages yet.');
  const items = rows.map((r, i) => lbRow(i + 1, r.userId, r.messages, total, members, { top: i < 3, you: you?.userId === r.userId, extra: false }));
  if (you && you.rank && !rows.some((r) => r.userId === you.userId)) {
    items.push('<li class="gap" aria-hidden="true"><span class="rank">⋯</span></li>');
    items.push(lbRow(you.rank.rank, you.userId, you.rank.messages, total, members, { top: false, you: true, extra: true }));
  }
  return `<ol class="lb">${items.join('')}</ol>`;
}

export interface YouData {
  allRank: { rank: number; messages: number } | null;
  weekRank: { rank: number; messages: number } | null;
  stats: UserStats;
  reactions: ReactionStats;
  voice: VoiceStats;
  activityMs: number;
  topActivities: ActivityAggregateRow[];
  topVoice: VoiceChannelRow[];
  emojiGiven: EmojiRow[];
  emojiReceived: EmojiRow[];
  nowPlaying: CurrentActivityRow[];
  inVoice: CurrentVoiceRow | null;
}

const miniList = (items: { label: string; value: string }[]): string =>
  `<ul class="mini">${items.map((i) => `<li><span class="name" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</span><span class="val">${escapeHtml(i.value)}</span></li>`).join('')}</ul>`;

const miniBlock = (title: string, inner: string): string => `<div><h3 class="mini-h">${escapeHtml(title)}</h3>${inner}</div>`;

// Pure: "Your stats" section for the logged-in user.
export function youSection(y: YouData, ctx: { total: number; timezone: string; channelNames: Record<string, string>; username: string }): string {
  const hasData = y.stats.messages > 0 || y.reactions.given > 0 || y.reactions.received > 0 || y.voice.sessions > 0 || y.activityMs > 0 || y.topActivities.length > 0;
  const head = `<div class="sec-head"><h2 id="h-you">Your stats</h2><span class="sub">${escapeHtml(ctx.username)}</span></div>`;
  if (!hasData) return `<section id="you" aria-labelledby="h-you">${head}${emptyState('No tracked activity for you yet.')}</section>`;

  const allPct = ctx.total > 0 ? Math.min(100, (y.stats.messages / ctx.total) * 100) : 0;
  const allNote = [y.allRank ? `#${fmt(y.allRank.rank)}` : null, ctx.total > 0 && y.stats.messages > 0 ? `${allPct.toFixed(1)}% of server` : null].filter(Boolean).join(' · ');
  const chan = (id: string): string => (ctx.channelNames[id] ? '#' + ctx.channelNames[id] : id);

  const kpis = [
    kpi(fmt(y.stats.messages), 'Messages, all time', allNote || undefined),
    kpi(fmt(y.weekRank?.messages ?? 0), 'Messages, last week', y.weekRank ? `#${fmt(y.weekRank.rank)}` : 'not ranked'),
    kpi(fmt(y.reactions.given), 'Reactions given', `${fmt(y.reactions.received)} received`),
    kpi(y.voice.totalMs > 0 ? fmtDuration(y.voice.totalMs) : '—', 'Time in voice', y.voice.totalMs > 0 ? `${fmt(y.voice.sessions)} session${y.voice.sessions === 1 ? '' : 's'}` : 'no voice time'),
    kpi(y.activityMs > 0 ? fmtDuration(y.activityMs) : '—', 'Activity time', y.topActivities[0] ? `top: ${y.topActivities[0].name}` : 'none tracked'),
  ].join('');

  const range = `<p class="muted">First message ${escapeHtml(fmtDate(y.stats.firstTs, ctx.timezone))} · last message ${escapeHtml(fmtDate(y.stats.lastTs, ctx.timezone))}</p>`;
  const live: string[] = [];
  for (const a of y.nowPlaying) live.push(`${activityTypeLabel(a.type)} ${a.name}`);
  if (y.inVoice) live.push(`🔊 In voice: ${chan(y.inVoice.channelId)}`);
  const liveHtml = live.length > 0 ? `<p class="muted">Right now: ${escapeHtml(live.join(' · '))}</p>` : '';

  const blocks: string[] = [];
  if (y.topActivities.length > 0) blocks.push(miniBlock('Top activities', miniList(y.topActivities.slice(0, 5).map((a) => ({ label: a.name, value: `${fmtDuration(a.totalMs)} · ${fmt(a.sessions)} session${a.sessions === 1 ? '' : 's'}` })))));
  if (y.topVoice.length > 0) blocks.push(miniBlock('Top voice channels', miniList(y.topVoice.slice(0, 3).map((v) => ({ label: chan(v.channelId), value: `${fmtDuration(v.totalMs)} · ${fmt(v.sessions)} session${v.sessions === 1 ? '' : 's'}` })))));
  if (y.emojiGiven.length > 0) blocks.push(miniBlock('Emoji you give', `<ul class="emojis">${y.emojiGiven.map(emojiChip).join('')}</ul>`));
  if (y.emojiReceived.length > 0) blocks.push(miniBlock('Emoji you receive', `<ul class="emojis">${y.emojiReceived.map(emojiChip).join('')}</ul>`));

  return `<section id="you" aria-labelledby="h-you">${head}<div class="kpis">${kpis}</div>${range}${liveHtml}${blocks.length > 0 ? `<div class="cols you-cols">${blocks.join('')}</div>` : ''}</section>`;
}

// Custom emoji labels look like <:name:id> / <a:name:id>; render them as images.
function emojiChip(e: EmojiRow): string {
  const custom = /^<(a?):([^:>]+):(\d+)>$/.exec(e.emojiLabel);
  const glyph = custom
    ? `<img src="https://cdn.discordapp.com/emojis/${custom[3]}.${custom[1] ? 'gif' : 'webp'}?size=48" alt="${escapeHtml(custom[2] ?? '')}" title=":${escapeHtml(custom[2] ?? '')}:" loading="lazy">`
    : escapeHtml(e.emojiLabel);
  return `<li>${glyph}<small>${fmt(e.count)}</small></li>`;
}

function embedRows(d: DashboardData): string {
  const rows = d.recentEmbeds.map((e) => {
    const channel = d.channelNames[e.channelId];
    return `<tr><td>${escapeHtml(fmtDate(e.ts, d.settings.timezone))}</td><td>${channel ? '#' + escapeHtml(channel) : escapeHtml(e.channelId)}</td><td><span class="badge">${escapeHtml(e.provider)}</span></td><td class="url"><a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(e.url)}">${escapeHtml(e.url)}</a></td></tr>`;
  });
  return `<div class="scroll"><table><thead><tr><th scope="col">Time</th><th scope="col">Channel</th><th scope="col">Provider</th><th scope="col">URL</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function embedPager(d: DashboardData): string {
  const { page, pages, total, pageSize } = d.embedPage;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, from + d.recentEmbeds.length - 1);
  const showing = `<p class="muted">Showing ${fmt(from)}–${fmt(to)} of ${fmt(total)}</p>`;
  if (pages <= 1) return `<div class="pager">${showing}</div>`;
  const step = (label: string, target: number, enabled: boolean): string =>
    enabled
      ? `<a class="pager-btn" href="/dashboard?embedsPage=${target}#h-embeds">${label}</a>`
      : `<span class="pager-btn" aria-disabled="true">${label}</span>`;
  return `<div class="pager">${showing}<nav class="pager-nav" aria-label="Embed conversions pages">${step('Previous', page - 1, page > 1)}<span>Page ${page} of ${pages}</span>${step('Next', page + 1, page < pages)}</nav></div>`;
}

function freeSection(d: DashboardData): string {
  const f = d.free;
  const s = f.settings;
  const flash = f.flash?.kind === 'saved' ? '<div class="flash" role="status">Free games settings saved.</div>' : '';
  const channelOpts = d.channels.map((c) => `<option value="${escapeHtml(c.id)}"${s.channelId === c.id ? ' selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');
  const roleOpts = f.roles.map((r) => `<option value="${escapeHtml(r.id)}"${s.pingRoleId === r.id ? ' selected' : ''}>@${escapeHtml(r.name)}</option>`).join('');
  const storeChecks = ALL_STORES.map((st) => `<label class="opt"><input type="checkbox" name="stores" value="${st}"${s.stores.includes(st) ? ' checked' : ''}><span>${escapeHtml(STORE_LABELS[st])}</span></label>`).join('');
  const inc = (name: string, on: boolean, label: string, help: string): string =>
    `<label class="opt"><input type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}><span title="${escapeHtml(help)}">${escapeHtml(label)}</span></label>`;
  const status = [
    f.webhookEnabled ? 'FreeStuff webhook enabled' : 'FreeStuff webhook disabled (set FREESTUFF_PUBLIC_KEY)',
    `${fmt(f.postedCount)} recorded as announced`,
  ].join(' · ');
  return `<section id="free" aria-labelledby="h-free"><div class="sec-head"><h2 id="h-free">Free games</h2><span class="sub">${escapeHtml(status)}</span></div>
    ${flash}
    <form class="panel" method="post" action="/free-settings">
      <div class="row">
        <div class="field"><label for="freeChannel">Announcement channel</label><span class="help">Where new free games are posted.</span>
          <select id="freeChannel" name="channel"><option value="">— disabled —</option>${channelOpts}</select></div>
        <div class="field"><label for="freeRole">Ping role</label><span class="help">Mentioned with each announcement.</span>
          <select id="freeRole" name="pingRole"><option value="">— none —</option>${roleOpts}</select></div>
      </div>
      <div class="field"><span class="lbl">Stores</span><span class="help">Applies to PC games.</span>
        <div class="checks">${storeChecks}</div></div>
      <div class="field"><span class="lbl">Also include</span>
        <div class="checks">${inc('includeDlc', s.includeDlc, 'DLC / in-game loot', 'Add-ons and loot drops')}${inc('includeBeta', s.includeBeta, 'Betas / playtests', 'Beta, playtest and demo keys')}${inc('includeMobile', s.includeMobile, 'Mobile', 'Android / iOS games')}</div></div>
      <div class="actions"><button type="submit">Save free games settings</button></div>
    </form>
  </section>`;
}

function uptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return days > 0 ? `${days}d ${h}h` : `${h}h ${m}m`;
}

// Strips the one-shot flash params so a refresh doesn't show the toast again.
const CLEAR_FLASH_SCRIPT =
  "<script>(()=>{const u=new URL(location.href);u.searchParams.delete('saved');u.searchParams.delete('freeSaved');history.replaceState(null,'',u.pathname+u.search+u.hash)})()</script>";

export function dashboardPage(d: DashboardData): string {
  const s = d.settings;
  const b = d.botStatus;
  const weekLabel = weekRangeLabel(d.week.bounds, s.timezone);
  const dayOptions = DAYS.map((name, i) => `<option value="${i}"${s.weeklyDay === i ? ' selected' : ''}>${name}</option>`).join('');
  const hourOptions = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${s.weeklyHour === h ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  const channelOptions = d.channels
    .map((c) => `<option value="${escapeHtml(c.id)}"${s.statsChannelId === c.id ? ' selected' : ''}>#${escapeHtml(c.name)}</option>`)
    .join('');
  const embedChecks = d.channels
    .map((c) => `<label class="opt"><input type="checkbox" name="embedChannels" value="${escapeHtml(c.id)}"${s.embedChannels.includes(c.id) ? ' checked' : ''}><span>#${escapeHtml(c.name)}</span></label>`)
    .join('');
  const status = [
    b.ping >= 0 ? `Online · ${b.ping} ms` : 'Connecting · Ping —',
    `up ${uptime(b.uptimeSec)}`,
    `${b.guilds} guild${b.guilds === 1 ? '' : 's'}`,
    `${(b.dbBytes / 1024 / 1024).toFixed(2)} MB`,
    `weekly stats last sent ${b.lastWeeklySent ?? 'never'}`,
  ].join(' · ');

  const body = `
  ${d.saved ? '<div class="flash" role="status">Settings saved.</div>' : ''}
  <div class="head">
    <h1 class="title">Server overview</h1>
    <p class="lede" aria-label="Bot health"><span class="dot${b.ping >= 0 ? ' ok' : ''}"></span>${escapeHtml(status)}</p>
  </div>
  <div class="kpis">
    ${kpi(fmt(d.today), 'Messages today')}
    ${kpi(fmt(d.week.total), 'Last week')}
    ${kpi(fmt(d.allTime.total), 'All time')}
    ${kpi(fmt(d.reactions.total), 'Reactions')}
    ${kpi(fmt(b.embedsConverted), 'Embeds converted')}
  </div>
  ${youSection(d.you, { total: d.allTime.total, timezone: s.timezone, channelNames: d.channelNames, username: d.user.username })}
  <div class="cols">
    <section aria-labelledby="h-week"><div class="sec-head"><h2 id="h-week">Last week</h2><span class="sub">${escapeHtml(weekLabel)} · ${fmt(d.week.total)} messages</span></div>${leaderboard(d.week.rows, d.week.total, d.members, { userId: d.user.id, rank: d.you.weekRank })}</section>
    <section aria-labelledby="h-all"><div class="sec-head"><h2 id="h-all">All time</h2><span class="sub">${fmt(d.allTime.total)} messages</span></div>${leaderboard(d.allTime.rows, d.allTime.total, d.members, { userId: d.user.id, rank: d.you.allRank })}</section>
  </div>
  <section aria-labelledby="h-react"><div class="sec-head"><h2 id="h-react">Reactions</h2><span class="sub">${fmt(d.reactions.total)} tracked</span></div>
    ${d.reactions.top.length === 0 ? emptyState('No reactions tracked yet.') : `<ul class="emojis">${d.reactions.top.map(emojiChip).join('')}</ul><p class="muted">Most used emoji server-wide. Per-member emoji are in the <code>/stats</code> command in Discord.</p>`}
  </section>
  <section aria-labelledby="h-settings"><div class="sec-head"><h2 id="h-settings">Settings</h2></div>
    <form class="panel" method="post" action="/settings">
      <fieldset>
        <legend>Weekly stats</legend>
        <p class="sub">Post last week's leaderboard to a channel on a schedule.</p>
        <label class="switch"><input type="checkbox" name="weeklyEnabled" value="1"${s.weeklyEnabled ? ' checked' : ''}><span class="track"></span><span><span class="lbl">Send weekly stats automatically</span><span class="help">Needs a channel below.</span></span></label>
        <div class="field"><label for="statsChannel">Channel</label><span class="help">Where the weekly stats are posted.</span>
          <select id="statsChannel" name="statsChannel"><option value="">— disabled —</option>${channelOptions}</select></div>
        <div class="row">
          <div class="field"><label for="weeklyDay">Day</label><select id="weeklyDay" name="weeklyDay">${dayOptions}</select></div>
          <div class="field"><label for="weeklyHour">Hour</label><select id="weeklyHour" name="weeklyHour">${hourOptions}</select></div>
        </div>
        <div class="field"><label for="timezone">Timezone</label><span class="help">IANA name, e.g. Europe/Ljubljana. Day and hour use this.</span>
          <input type="text" id="timezone" name="timezone" value="${escapeHtml(s.timezone)}" autocomplete="off" spellcheck="false"></div>
      </fieldset>
      <fieldset>
        <legend>Link embeds</legend>
        <p class="sub">Social links posted in the checked channels are converted to rich embeds.</p>
        <div class="checks">${embedChecks || '<p class="muted">No text channels found.</p>'}</div>
      </fieldset>
      <div class="actions"><button type="submit">Save settings</button></div>
    </form>
  </section>
  ${freeSection(d)}
  <section aria-labelledby="h-embeds"><div class="sec-head"><h2 id="h-embeds">Embed conversions</h2></div>
    ${d.recentEmbeds.length === 0 ? emptyState('Nothing converted yet.') : embedRows(d) + embedPager(d)}
  </section>
  ${d.saved || d.free.flash ? CLEAR_FLASH_SCRIPT : ''}`;
  return layout('Dashboard', body, d.user);
}
