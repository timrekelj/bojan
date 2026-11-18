import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { ChannelType, type Client } from 'discord.js';
import type { BotDatabase, Settings } from '../db.js';
import { config } from '../config.js';
import { currentWeekBounds, lastWeekBounds, weekRangeLabel } from '../stats.js';
import { dashboardPage, errorPage, loginPage } from './views.js';

interface Session {
  userId: string;
  username: string;
  avatar: string;
  accessToken: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    session: Session;
  }
}

const SID_COOKIE = 'sid';
const STATE_COOKIE = 'oauth_state';
const sessions = new Map<string, Session>(); // sid -> session
const startedAt = Date.now();

function sign(value: string): string {
  return createHmac('sha256', config.sessionSecret).update(value).digest('hex');
}

function sessionCookieValue(sid: string): string {
  return `${sid}.${sign(sid)}`;
}

function verifySessionCookie(raw: string | undefined): Session | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const sid = raw.slice(0, dot);
  const sig = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(sid));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  return sessions.get(sid) ?? null;
}

function discordAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${config.dashboardUrl}/auth/callback`,
    response_type: 'code',
    scope: 'identify guilds guilds.member',
    guild_id: config.guildId,
    state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCode(code: string): Promise<{ access_token: string }> {
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.dashboardUrl}/auth/callback`,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { access_token: string };
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

interface DiscordMember {
  roles: string[];
  permissions?: string;
}

async function checkGuildAdmin(accessToken: string): Promise<{ ok: boolean; user?: DiscordUser }> {
  const headers = { authorization: `Bearer ${accessToken}` };
  const meRes = await fetch('https://discord.com/api/users/@me', { headers });
  if (!meRes.ok) return { ok: false };
  const user = (await meRes.json()) as DiscordUser;

  const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${config.guildId}/member`, { headers });
  if (!memberRes.ok) return { ok: false };
  const member = (await memberRes.json()) as DiscordMember;

  const ADMINISTRATOR = 0x8n;
  const perms = member.permissions ? BigInt(member.permissions) : 0n;
  const isAdmin = (perms & ADMINISTRATOR) === ADMINISTRATOR || (config.adminRoleId !== null && member.roles.includes(config.adminRoleId));
  return { ok: isAdmin, user };
}

export function createWebApp(client: Client, db: BotDatabase): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) }));

  app.get('/', (c) => c.redirect(verifySessionCookie(getCookie(c)[SID_COOKIE]) ? '/dashboard' : '/login'));

  app.get('/login', (c) => {
    if (verifySessionCookie(getCookie(c)[SID_COOKIE])) return c.redirect('/dashboard');
    const state = randomBytes(16).toString('hex');
    setCookie(c, STATE_COOKIE, `${state}.${sign(state)}`, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600 });
    return c.html(loginPage(discordAuthUrl(state)));
  });

  app.get('/auth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const savedState = getCookie(c)[STATE_COOKIE];
    if (!code || !state || !savedState) return c.html(errorPage('Missing OAuth parameters.'), 400);
    if (savedState !== `${state}.${sign(state)}`) return c.html(errorPage('Invalid OAuth state — please try again.'), 400);
    deleteCookie(c, STATE_COOKIE, { path: '/' });

    try {
      const token = await exchangeCode(code);
      const check = await checkGuildAdmin(token.access_token);
      if (!check.ok || !check.user) return c.html(errorPage('You are not an administrator of this server.'), 403);

      const sid = randomBytes(24).toString('hex');
      const avatar = check.user.avatar
        ? `https://cdn.discordapp.com/avatars/${check.user.id}/${check.user.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(check.user.id) % 6n)}.png`;
      sessions.set(sid, {
        userId: check.user.id,
        username: check.user.global_name ?? check.user.username,
        avatar,
        accessToken: token.access_token,
      });
      setCookie(c, SID_COOKIE, sessionCookieValue(sid), { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 7 * 86400 });
      return c.redirect('/dashboard');
    } catch (err) {
      console.error('[web] oauth callback failed:', err);
      return c.html(errorPage('Discord login failed. Please try again.'), 500);
    }
  });

  app.get('/logout', (c) => {
    const session = verifySessionCookie(getCookie(c)[SID_COOKIE]);
    if (session) {
      for (const [sid, s] of sessions) if (s.userId === session.userId) sessions.delete(sid);
    }
    deleteCookie(c, SID_COOKIE, { path: '/' });
    return c.redirect('/login');
  });

  const requireAdmin = async (c: Context, next: Next) => {
    const session = verifySessionCookie(getCookie(c)[SID_COOKIE]);
    if (!session) return c.redirect('/login');
    c.set('session', session);
    await next();
  };

  app.get('/dashboard', requireAdmin, (c) => {
    const session = c.get('session');
    const guild = client.guilds.cache.get(config.guildId);
    const settings = db.getSettings(config.guildId);
    const week = lastWeekBounds(settings.timezone);
    const channels = guild
      ? guild.channels.cache
          .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
          .map((ch) => ({ id: ch.id, name: ch.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
    const total = db.countMessages(config.guildId);

    return c.html(
      dashboardPage({
        settings,
        channels,
        botStatus: {
          ping: client.ws.ping,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          guilds: client.guilds.cache.size,
          totalMessages: total,
          dbBytes: db.sizeBytes,
          lastWeeklySent: db.getState(`weekly:${config.guildId}`),
          embedsConverted: db.recentEmbeds(config.guildId, 10_000).length,
        },
        today: db.countMessages(config.guildId, Date.now() - 86_400_000),
        week: { bounds: week, total: db.countMessages(config.guildId, week.start, week.end), rows: db.topUsers(config.guildId, 10, week.start, week.end) },
        allTime: { total, rows: db.topUsers(config.guildId, 10) },
        recentEmbeds: db.recentEmbeds(config.guildId, 15),
        user: { username: session.username, avatar: session.avatar },
        saved: c.req.query('saved') === '1',
      }),
    );
  });

  app.post('/settings', requireAdmin, async (c) => {
    const form = await c.req.parseBody();
    const current = db.getSettings(config.guildId);
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const num = (v: unknown, fallback: number, min: number, max: number): number => {
      const n = Number(str(v));
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(n)));
    };
    const rawChannels = form.embedChannels;
    let timezone = str(form.timezone).trim() || 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      timezone = current.timezone; // reject invalid IANA names, keep the old value
    }

    const next: Settings = {
      guildId: config.guildId,
      statsChannelId: str(form.statsChannel) || null,
      weeklyEnabled: form.weeklyEnabled === '1',
      weeklyDay: num(form.weeklyDay, current.weeklyDay, 0, 6),
      weeklyHour: num(form.weeklyHour, current.weeklyHour, 0, 23),
      timezone,
      embedChannels: Array.isArray(rawChannels) ? rawChannels.map(String) : rawChannels ? [String(rawChannels)] : [],
    };
    db.saveSettings(next);
    console.log(`[web] settings updated by ${c.get('session').username}`);
    return c.redirect('/dashboard?saved=1');
  });

  app.get('/api/stats.json', requireAdmin, (c) => {
    const settings = db.getSettings(config.guildId);
    const week = lastWeekBounds(settings.timezone);
    return c.json({
      guildId: config.guildId,
      totalMessages: db.countMessages(config.guildId),
      lastWeek: { ...week, label: weekRangeLabel(week, settings.timezone), total: db.countMessages(config.guildId, week.start, week.end), top: db.topUsers(config.guildId, 10, week.start, week.end) },
      currentWeek: currentWeekBounds(settings.timezone).key,
      allTimeTop: db.topUsers(config.guildId, 10),
      settings,
      bot: { ping: client.ws.ping, guilds: client.guilds.cache.size, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) },
    });
  });

  return app;
}

export function startWebServer(client: Client, db: BotDatabase): void {
  const app = createWebApp(client, db);
  serve({ fetch: app.fetch, port: config.dashboardPort, hostname: '0.0.0.0' }, (info) => {
    console.log(`[web] dashboard on http://localhost:${info.port} (register ${config.dashboardUrl}/auth/callback as the OAuth redirect)`);
  });
}
