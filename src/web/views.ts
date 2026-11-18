import type { Settings, UserRow, EmbedLogRow, EmojiRow } from '../db.js';
import { fmt, fmtDate, lastWeekBounds, weekRangeLabel } from '../stats.js';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `
  :root {
    color-scheme: light dark;
    --bg: #f5f6f8; --surface: #fff; --surface-2: #f0f1f4; --border: #e1e3e8;
    --text: #1b1d22; --muted: #646b78; --accent: #5865f2; --accent-hover: #4752c4; --accent-soft: #eceefe;
    --success: #1f8a4c; --success-soft: #e5f5ec; --radius: 12px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #131417; --surface: #1c1e23; --surface-2: #25272d; --border: #2e3139;
      --text: #e8e9ed; --muted: #9096a3; --accent: #7983f5; --accent-hover: #8e97f7; --accent-soft: #272a4a;
      --success: #3ec979; --success-soft: #16301f;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  a { color: var(--accent); }
  code { background: var(--surface-2); padding: 1px 6px; border-radius: 6px; font-size: 12px; }
  .topbar { background: var(--surface); border-bottom: 1px solid var(--border); }
  .topbar-in { max-width: 1040px; margin: 0 auto; padding: 12px 20px; display: flex; align-items: center; gap: 12px; }
  .brand { margin: 0; flex: 1; font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
  .brand::before { content: ''; display: inline-block; width: 10px; height: 10px; border-radius: 3px; background: var(--accent); margin-right: 10px; }
  .me { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .me img { width: 28px; height: 28px; border-radius: 50%; }
  .me span { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
  .me a { color: var(--muted); font-size: 13px; text-decoration: none; margin-left: 4px; }
  .me a:hover { color: var(--text); text-decoration: underline; }
  main { max-width: 1040px; margin: 0 auto; padding: 24px 20px 48px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
  main > * { min-width: 0; }
  section, .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
  h2 { margin: 0; font-size: 15px; font-weight: 650; }
  .sec-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; margin-bottom: 14px; }
  .sub, .muted { color: var(--muted); font-size: 13px; }
  .muted { margin: 0; }
  .empty { margin: 0; padding: 22px 12px; text-align: center; color: var(--muted); background: var(--surface-2); border-radius: 8px; }
  .flash { background: var(--success-soft); color: var(--success); border: 1px solid var(--success); border-radius: 10px; padding: 10px 14px; font-weight: 550; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
  .kpi b { display: block; font-size: 30px; line-height: 1.15; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .kpi span { color: var(--muted); font-size: 13px; }
  .health { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 22px; padding: 12px 18px; color: var(--muted); font-size: 13px; }
  .health strong { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; margin-right: 6px; }
  .dot.ok { background: var(--success); box-shadow: 0 0 0 3px var(--success-soft); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .cols > section { min-width: 0; }
  .lb { list-style: none; margin: 0; padding: 0; }
  .lb li { display: grid; grid-template-columns: 22px 28px minmax(0, 1fr) auto; align-items: center; gap: 4px 10px; padding: 9px 0; border-top: 1px solid var(--border); }
  .lb li:first-child { border-top: 0; }
  .rank { color: var(--muted); font-size: 13px; text-align: right; font-variant-numeric: tabular-nums; }
  .top .rank { color: var(--accent); font-weight: 700; }
  .top .name { font-weight: 650; }
  .av { width: 28px; height: 28px; border-radius: 50%; background: var(--surface-2); object-fit: cover; display: grid; place-items: center; font-size: 12px; font-weight: 650; color: var(--muted); }
  .top .av { box-shadow: 0 0 0 2px var(--accent); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .share { grid-column: 3 / 5; display: flex; align-items: center; gap: 8px; }
  .bar { flex: 1; height: 4px; border-radius: 4px; background: var(--surface-2); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
  .pct { color: var(--muted); font-size: 12px; min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; padding: 0; list-style: none; }
  .chip { display: inline-flex; align-items: center; gap: 8px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px 4px 10px; font-size: 18px; line-height: 1.3; }
  .chip small { font-size: 13px; font-weight: 600; color: var(--muted); font-variant-numeric: tabular-nums; }
  .chip img { width: 20px; height: 20px; }
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  fieldset + fieldset { margin-top: 24px; padding-top: 22px; border-top: 1px solid var(--border); }
  legend { float: left; width: 100%; padding: 0; font-weight: 650; font-size: 15px; }
  legend + .sub { clear: both; margin: 2px 0 14px; }
  .field { margin-top: 14px; }
  .field > label, .lbl { display: block; font-weight: 550; margin-bottom: 2px; }
  .help { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  select, input[type=text] { width: 100%; max-width: 100%; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .switch { display: flex; align-items: center; gap: 12px; cursor: pointer; }
  .switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .track { flex: none; width: 38px; height: 22px; border-radius: 999px; background: var(--border); position: relative; transition: background .15s; }
  .track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
  .switch input:checked + .track { background: var(--accent); }
  .switch input:checked + .track::after { transform: translateX(16px); }
  .switch input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; max-height: 240px; overflow: auto; padding: 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; }
  .pill { display: flex; align-items: center; gap: 8px; padding: 6px 10px; margin: 0; font-weight: 400; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; cursor: pointer; min-width: 0; }
  .pill:hover { border-color: var(--accent); }
  .pill:has(input:checked) { background: var(--accent-soft); border-color: var(--accent); }
  .pill input { accent-color: var(--accent); margin: 0; flex: none; }
  .pill span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { margin-top: 24px; }
  button, .btn { display: inline-block; background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 10px 20px; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  button:hover, .btn:hover { background: var(--accent-hover); }
  .btn.discord { background: #5865f2; padding: 12px 26px; font-size: 15px; }
  .btn.discord:hover { background: #4752c4; }
  .btn.ghost { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); }
  .btn.ghost:hover { background: var(--border); }
  .pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
  .pager .muted, .pager-nav { font-variant-numeric: tabular-nums; }
  .pager-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
  .pager-btn { display: inline-block; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 4px 12px; font-size: 13px; font-weight: 600; text-decoration: none; }
  a.pager-btn:hover { background: var(--border); }
  .pager-btn[aria-disabled=true] { color: var(--muted); opacity: .55; }
  .scroll { overflow-x: auto; max-width: 100%; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 12px; border-top: 1px solid var(--border); white-space: nowrap; }
  th { border-top: 0; color: var(--muted); font-size: 12px; font-weight: 600; text-transform: none; }
  td.url { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
  td.url a { display: block; overflow: hidden; text-overflow: ellipsis; }
  .badge { display: inline-block; background: var(--accent-soft); color: var(--accent); border-radius: 6px; padding: 1px 8px; font-size: 12px; font-weight: 600; }
  .center { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
  .auth { width: 100%; max-width: 380px; text-align: center; padding: 32px 28px; }
  .auth h1 { margin: 0 0 8px; font-size: 20px; letter-spacing: -.01em; }
  .auth p { margin: 0 0 24px; color: var(--muted); }
  .auth .mark { width: 40px; height: 40px; border-radius: 10px; background: var(--accent); margin: 0 auto 18px; }
  @media (max-width: 800px) { .cols { grid-template-columns: 1fr; } }
  @media (max-width: 480px) {
    main { padding: 16px 12px 40px; }
    section, .card { padding: 16px; }
    .topbar-in { padding: 10px 12px; }
    .me span { max-width: 90px; }
    .row { grid-template-columns: 1fr; }
    .kpi b { font-size: 26px; }
  }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

function layout(title: string, body: string, user: { username: string; avatar: string }): string {
  const header = `<header class="topbar"><div class="topbar-in"><h1 class="brand">Bojan dashboard</h1><div class="me"><img src="${escapeHtml(user.avatar)}" alt=""><span>${escapeHtml(user.username)}</span><a href="/logout">Log out</a></div></div></header>`;
  return page(title, `${header}<main>${body}</main>`);
}

function authCard(title: string, text: string, button: string): string {
  return page(title, `<main class="center"><div class="card auth"><div class="mark"></div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${button}</div></main>`);
}

export function loginPage(discordAuthUrl: string): string {
  return authCard('Server stats dashboard', 'Sign in with Discord. Only server administrators can access this.', `<a class="btn discord" href="${escapeHtml(discordAuthUrl)}">Sign in with Discord</a>`);
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
  user: { username: string; avatar: string };
  saved: boolean;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const kpi = (value: string, label: string): string => `<div class="kpi"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`;

function emptyState(text: string): string {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

function leaderboard(rows: UserRow[], total: number, members: DashboardData['members']): string {
  if (rows.length === 0) return emptyState('No messages yet.');
  const items = rows.map((r, i) => {
    const m = members[r.userId];
    const name = m?.name ?? r.userId;
    const avatar = m?.avatar
      ? `<img class="av" src="${escapeHtml(m.avatar)}" alt="" loading="lazy">`
      : `<span class="av" aria-hidden="true">${escapeHtml(Array.from(name)[0]?.toUpperCase() ?? '?')}</span>`;
    const pct = total > 0 ? Math.min(100, (r.messages / total) * 100) : 0;
    return `<li${i < 3 ? ' class="top"' : ''}><span class="rank">${i + 1}</span>${avatar}<span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span><span class="num">${fmt(r.messages)}</span><div class="share"><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div><span class="pct">${total > 0 ? pct.toFixed(1) + '%' : '—'}</span></div></li>`;
  });
  return `<ol class="lb">${items.join('')}</ol>`;
}

// Custom emoji labels look like <:name:id> / <a:name:id>; render them as images.
function emojiChip(e: EmojiRow): string {
  const custom = /^<(a?):([^:>]+):(\d+)>$/.exec(e.emojiLabel);
  const glyph = custom
    ? `<img src="https://cdn.discordapp.com/emojis/${custom[3]}.${custom[1] ? 'gif' : 'webp'}?size=48" alt="${escapeHtml(custom[2] ?? '')}" title=":${escapeHtml(custom[2] ?? '')}:" loading="lazy">`
    : escapeHtml(e.emojiLabel);
  return `<li class="chip">${glyph}<small>${fmt(e.count)}</small></li>`;
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

function uptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return days > 0 ? `${days}d ${h}h` : `${h}h ${m}m`;
}

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
    .map((c) => `<label class="pill"><input type="checkbox" name="embedChannels" value="${escapeHtml(c.id)}"${s.embedChannels.includes(c.id) ? ' checked' : ''}><span>#${escapeHtml(c.name)}</span></label>`)
    .join('');

  const body = `
  ${d.saved ? '<div class="flash" role="status">Settings saved.</div>' : ''}
  <div class="kpis">
    ${kpi(fmt(d.today), 'Messages today')}
    ${kpi(fmt(d.week.total), 'Last week')}
    ${kpi(fmt(d.allTime.total), 'All time')}
    ${kpi(fmt(d.reactions.total), 'Reactions')}
    ${kpi(fmt(b.embedsConverted), 'Embeds converted')}
  </div>
  <div class="card health" aria-label="Bot health">
    <span><span class="dot${b.ping >= 0 ? ' ok' : ''}"></span>${b.ping >= 0 ? 'Online' : 'Connecting'}</span>
    <span>Ping <strong>${b.ping >= 0 ? `${b.ping} ms` : '—'}</strong></span>
    <span>Uptime <strong>${uptime(b.uptimeSec)}</strong></span>
    <span>Guilds <strong>${b.guilds}</strong></span>
    <span>Database <strong>${(b.dbBytes / 1024 / 1024).toFixed(2)} MB</strong></span>
    <span>Weekly stats last sent <strong>${escapeHtml(b.lastWeeklySent ?? 'never')}</strong></span>
  </div>
  <div class="cols">
    <section aria-labelledby="h-week"><div class="sec-head"><h2 id="h-week">Last week</h2><span class="sub">${escapeHtml(weekLabel)} · ${fmt(d.week.total)} messages</span></div>${leaderboard(d.week.rows, d.week.total, d.members)}</section>
    <section aria-labelledby="h-all"><div class="sec-head"><h2 id="h-all">All time</h2><span class="sub">${fmt(d.allTime.total)} messages</span></div>${leaderboard(d.allTime.rows, d.allTime.total, d.members)}</section>
  </div>
  <section aria-labelledby="h-react"><div class="sec-head"><h2 id="h-react">Reactions</h2><span class="sub">${fmt(d.reactions.total)} tracked</span></div>
    ${d.reactions.top.length === 0 ? emptyState('No reactions tracked yet.') : `<ul class="chips">${d.reactions.top.map(emojiChip).join('')}</ul><p class="muted">Most used emoji server-wide. Per-member emoji are in the <code>/stats</code> command in Discord.</p>`}
  </section>
  <section aria-labelledby="h-settings"><div class="sec-head"><h2 id="h-settings">Settings</h2></div>
    <form method="post" action="/settings">
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
  <section aria-labelledby="h-embeds"><div class="sec-head"><h2 id="h-embeds">Recent embed conversions</h2></div>
    ${d.recentEmbeds.length === 0 ? emptyState('Nothing converted yet.') : embedRows(d)}
  </section>`;
  return layout('Dashboard', body, d.user);
}
