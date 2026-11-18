import type { Settings, UserRow, EmbedLogRow, EmojiRow } from '../db.js';
import { fmt, fmtDate, lastWeekBounds, weekRangeLabel } from '../stats.js';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: #1e1f22; color: #dbdee1; margin: 0; }
  header { background: #2b2d31; padding: 14px 24px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #1e1f22; }
  header h1 { font-size: 18px; margin: 0; flex: 1; }
  header img { width: 32px; height: 32px; border-radius: 50%; }
  main { max-width: 1000px; margin: 24px auto; padding: 0 16px; display: grid; gap: 20px; }
  .card { background: #2b2d31; border-radius: 10px; padding: 18px 20px; }
  .card h2 { margin: 0 0 12px; font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: #b5bac1; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 6px 10px; border-bottom: 1px solid #3f4147; font-size: 14px; }
  th { color: #b5bac1; font-weight: 600; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
  .stat { font-size: 26px; font-weight: 700; }
  .stat small { display: block; font-size: 12px; color: #b5bac1; font-weight: 400; }
  .stats-row { display: flex; gap: 28px; flex-wrap: wrap; }
  label { display: block; font-size: 13px; color: #b5bac1; margin: 12px 0 4px; }
  input[type=text], input[type=number], select { background: #1e1f22; border: 1px solid #3f4147; color: #dbdee1; border-radius: 6px; padding: 8px 10px; width: 100%; max-width: 320px; font-size: 14px; }
  .checks { display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow: auto; background: #1e1f22; border: 1px solid #3f4147; border-radius: 6px; padding: 10px; }
  .checks label { display: flex; align-items: center; gap: 8px; margin: 0; color: #dbdee1; }
  button, .btn { background: #5865f2; color: #fff; border: 0; border-radius: 6px; padding: 10px 18px; font-size: 14px; cursor: pointer; text-decoration: none; display: inline-block; }
  button:hover, .btn:hover { background: #4752c4; }
  .btn.secondary { background: #4e5058; }
  .flash { background: #2f6b3a; color: #d7ffdd; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; }
  .muted { color: #949ba4; font-size: 13px; }
  .login-wrap { max-width: 380px; margin: 80px auto; text-align: center; }
  .login-wrap .btn { background: #5865f2; padding: 12px 26px; font-size: 16px; }
`;

function layout(title: string, body: string, user?: { username: string; avatar: string }): string {
  const header = user
    ? `<header><img src="${escapeHtml(user.avatar)}" alt=""><h1>${escapeHtml(title)}</h1><span class="muted">${escapeHtml(user.username)}</span><a class="btn secondary" href="/logout">Log out</a></header>`
    : `<header><h1>${escapeHtml(title)}</h1></header>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${header}<main>${body}</main></body></html>`;
}

export function loginPage(discordAuthUrl: string): string {
  return layout('Sign in', `<div class="card login-wrap"><h2>Server stats dashboard</h2><p class="muted">Sign in with Discord. Only server administrators can access this.</p><a class="btn" href="${escapeHtml(discordAuthUrl)}">Sign in with Discord</a></div>`);
}

export function errorPage(message: string): string {
  return layout('Access denied', `<div class="card login-wrap"><h2>Access denied</h2><p class="muted">${escapeHtml(message)}</p><a class="btn secondary" href="/login">Try again</a></div>`);
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
  user: { username: string; avatar: string };
  saved: boolean;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function dashboardPage(d: DashboardData): string {
  const s = d.settings;
  const weekLabel = weekRangeLabel(d.week.bounds, s.timezone);
  const dayOptions = DAYS.map((name, i) => `<option value="${i}"${s.weeklyDay === i ? ' selected' : ''}>${name}</option>`).join('');
  const hourOptions = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${s.weeklyHour === h ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  const channelOptions = d.channels
    .map((c) => `<option value="${c.id}"${s.statsChannelId === c.id ? ' selected' : ''}>#${escapeHtml(c.name)}</option>`)
    .join('');
  const embedChecks = d.channels
    .map((c) => `<label><input type="checkbox" name="embedChannels" value="${c.id}"${s.embedChannels.includes(c.id) ? ' checked' : ''}> #${escapeHtml(c.name)}</label>`)
    .join('');
  const topTable = (rows: UserRow[], total: number): string =>
    rows.length === 0
      ? '<p class="muted">No messages yet.</p>'
      : `<table><tr><th>#</th><th>Member</th><th>Messages</th><th>Share</th></tr>${rows
          .map((r, i) => `<tr><td>${i + 1}</td><td>&lt;@${r.userId}&gt;</td><td>${fmt(r.messages)}</td><td>${total > 0 ? ((r.messages / total) * 100).toFixed(1) + '%' : '—'}</td></tr>`)
          .join('')}</table>`;

  const body = `
  ${d.saved ? '<div class="flash">Settings saved.</div>' : ''}
  <div class="card"><h2>Bot status</h2>
    <div class="stats-row">
      <div class="stat">${d.botStatus.ping} ms<small>websocket ping</small></div>
      <div class="stat">${Math.floor(d.botStatus.uptimeSec / 3600)}h ${Math.floor((d.botStatus.uptimeSec % 3600) / 60)}m<small>uptime</small></div>
      <div class="stat">${d.botStatus.guilds}<small>guilds</small></div>
      <div class="stat">${fmt(d.botStatus.totalMessages)}<small>messages tracked</small></div>
      <div class="stat">${(d.botStatus.dbBytes / 1024 / 1024).toFixed(2)} MB<small>database size</small></div>
      <div class="stat">${d.botStatus.embedsConverted}<small>embeds converted</small></div>
    </div>
    <p class="muted">Last weekly stats sent: ${escapeHtml(d.botStatus.lastWeeklySent ?? 'never')}</p>
  </div>
  <div class="grid2">
    <div class="card"><h2>This week (${escapeHtml(weekLabel)}) — ${fmt(d.week.total)} messages</h2>${topTable(d.week.rows, d.week.total)}</div>
    <div class="card"><h2>All time — ${fmt(d.allTime.total)} messages</h2>${topTable(d.allTime.rows, d.allTime.total)}</div>
  </div>
  <div class="card"><h2>Reactions — ${fmt(d.reactions.total)} tracked</h2>
    ${d.reactions.top.length === 0 ? '<p class="muted">No reactions tracked yet.</p>' : `<p style="font-size:22px">${d.reactions.top.map((e) => `${escapeHtml(e.emojiLabel)} ×${fmt(e.count)}`).join(' &nbsp; ')}</p><p class="muted">Most used emoji server-wide. Per-member emoji are in the <code>/stats</code> command in Discord.</p>`}
  </div>
  <div class="card"><h2>Settings</h2>
    <form method="post" action="/settings">
      <label for="statsChannel">Channel for weekly stats</label>
      <select id="statsChannel" name="statsChannel"><option value="">— disabled —</option>${channelOptions}</select>
      <label><input type="checkbox" name="weeklyEnabled" value="1"${s.weeklyEnabled ? ' checked' : ''}> Send weekly stats automatically</label>
      <label for="weeklyDay">Day</label><select id="weeklyDay" name="weeklyDay">${dayOptions}</select>
      <label for="weeklyHour">Hour (local)</label><select id="weeklyHour" name="weeklyHour">${hourOptions}</select>
      <label for="timezone">Timezone (IANA, e.g. Europe/Ljubljana)</label>
      <input type="text" id="timezone" name="timezone" value="${escapeHtml(s.timezone)}">
      <label>Channels where social links get converted to rich embeds</label>
      <div class="checks">${embedChecks || '<p class="muted">No text channels found.</p>'}</div>
      <div style="margin-top:16px"><button type="submit">Save settings</button></div>
    </form>
  </div>
  <div class="card"><h2>Recent embed conversions</h2>
    ${d.recentEmbeds.length === 0 ? '<p class="muted">Nothing converted yet.</p>' : `<table><tr><th>Time</th><th>Channel</th><th>Provider</th><th>URL</th></tr>${d.recentEmbeds
      .map((e) => `<tr><td>${escapeHtml(fmtDate(e.ts, s.timezone))}</td><td>&lt;#${e.channelId}&gt;</td><td>${escapeHtml(e.provider)}</td><td><a style="color:#00a8fc" href="${escapeHtml(e.url)}">${escapeHtml(e.url.slice(0, 80))}</a></td></tr>`)
      .join('')}</table>`}
  </div>`;
  return layout('Dashboard', body, d.user);
}
