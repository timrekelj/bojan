import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { ChannelType, type Client } from 'discord.js';
import type { BotDatabase, Settings } from '../db.js';
import { config } from '../config.js';
import { currentWeekBounds, lastWeekBounds, startOfDay, weekRangeLabel } from '../stats.js';
import { dashboardPage, errorPage, loginPage, logsPage, requestsPage, type DashboardData } from './views.js';
import { postWeeklyStats } from '../scheduler.js';
import { announceEverywhere } from '../freegames/actions.js';
import { createReplayGuard, FREESTUFF_COMPAT_DATE, handleFreeStuffWebhook } from '../freegames/freestuff.js';
import { parseFreeForm } from '../freegames/form.js';
import { parseBuilderForm } from '../builder/form.js';
import { sortQueue } from '../builder/queue.js';
import { probeAgent } from '../builder/opencode.js';

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
const EMBEDS_PAGE_SIZE = 10;
const REQUESTS_PAGE_SIZE = 50;

// 1-based page from a query value; garbage or < 1 -> 1, past the end -> last page.
export function parsePage(raw: string | undefined, pages: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : 1, 1), Math.max(pages, 1));
}

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
    // Note: the guilds.member scope was removed by Discord; with the plain
    // `guilds` scope we check membership via GET /users/@me/guilds/{id}/member
    // after the token exchange (see checkGuildAdmin).
    scope: 'identify guilds',
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

const ADMINISTRATOR = 0x8n;

async function checkGuildAdmin(accessToken: string): Promise<{ ok: boolean; user?: DiscordUser; reason?: string }> {
  const headers = { authorization: `Bearer ${accessToken}` };
  const meRes = await fetch('https://discord.com/api/users/@me', { headers });
  if (!meRes.ok) return { ok: false, reason: `users/@me -> ${meRes.status}` };
  const user = (await meRes.json()) as DiscordUser;

  // Preferred: member object of the configured guild (carries roles + permissions).
  const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${config.guildId}/member`, { headers });
  if (memberRes.ok) {
    const member = (await memberRes.json()) as DiscordMember;
    const perms = member.permissions ? BigInt(member.permissions) : 0n;
    const isAdmin = (perms & ADMINISTRATOR) === ADMINISTRATOR || (config.adminRoleId !== null && member.roles.includes(config.adminRoleId));
    return isAdmin
      ? { ok: true, user }
      : { ok: false, user, reason: `in guild but not admin: perms=${member.permissions ?? 'none'}, roles=${member.roles.join(',') || 'none'}, ADMIN_ROLE_ID=${config.adminRoleId ?? 'unset'}` };
  }

  // Fallback: /users/@me/guilds carries the user's permissions per guild (no roles).
  const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', { headers });
  if (guildsRes.ok) {
    const guilds = (await guildsRes.json()) as { id: string; permissions?: string; owner?: boolean }[];
    const g = guilds.find((x) => x.id === config.guildId);
    if (!g) return { ok: false, user, reason: `guild ${config.guildId} not among the user's guilds — GUILD_ID wrong?` };
    const perms = g.permissions ? BigInt(g.permissions) : 0n;
    if (g.owner || (perms & ADMINISTRATOR) === ADMINISTRATOR) return { ok: true, user };
    return { ok: false, user, reason: `guild perms=${g.permissions ?? 'none'}, owner=${g.owner} (member endpoint -> ${memberRes.status})` };
  }
  return { ok: false, user, reason: `member endpoint -> ${memberRes.status}, guilds endpoint -> ${guildsRes.status}` };
}

export function createWebApp(client: Client, db: BotDatabase, opts: { freestuffPublicKey?: string | null } = {}): Hono {
  const app = new Hono();
  const freestuffKey = opts.freestuffPublicKey === undefined ? config.freestuffPublicKey : opts.freestuffPublicKey;
  const freestuffReplay = createReplayGuard();

  app.get('/health', (c) => c.json({ ok: true, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) }));

  // FreeStuff webhook: public (authenticated by Ed25519 signature, not the dashboard session).
  app.post('/webhooks/freestuff', async (c) => {
    c.header('X-Set-Compatibility-Date', FREESTUFF_COMPAT_DATE);
    const rawBody = await c.req.text();
    const result = handleFreeStuffWebhook(
      { getHeader: (name) => c.req.header(name), rawBody },
      { publicKey: freestuffKey, replay: freestuffReplay },
    );
    if (result.status === 401) console.warn('[web] freestuff webhook rejected: bad signature or timestamp');
    if (result.status === 409) console.warn('[web] freestuff webhook rejected: unsupported compatibility date');
    if (result.games.length > 0) {
      console.log(`[freegames] freestuff webhook: ${result.games.length} announceable product(s)`);
      void announceEverywhere(client, db, result.games).catch((err) => console.error('[freegames] freestuff announce failed:', err));
    }
    return c.body(null, result.status);
  });

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
      if (!check.ok || !check.user) {
        console.error(`[web] access denied for user ${check.user?.id ?? 'unknown'}: ${check.reason ?? 'unknown reason'}`);
        return c.html(errorPage('You are not an administrator of this server.'), 403);
      }

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

  const listChannels = (): { id: string; name: string }[] => {
    const guild = client.guilds.cache.get(config.guildId);
    return guild
      ? guild.channels.cache
          .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
          .map((ch) => ({ id: ch.id, name: ch.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
  };
  // Pingable roles: not @everyone, not bot-managed; highest position first.
  const listRoles = (): { id: string; name: string }[] => {
    const guild = client.guilds.cache.get(config.guildId);
    return guild
      ? guild.roles.cache
          .filter((r) => r.id !== guild.id && !r.managed)
          .sort((a, b) => b.position - a.position)
          .map((r) => ({ id: r.id, name: r.name }))
      : [];
  };

  app.get('/dashboard', requireAdmin, async (c) => {
    const session = c.get('session');
    const guild = client.guilds.cache.get(config.guildId);
    const settings = db.getSettings(config.guildId);
    const week = lastWeekBounds(settings.timezone);
    const channels = listChannels();
    const freeSettings = db.getFreeSettings(config.guildId);
    const freeFlash: DashboardData['free']['flash'] = c.req.query('freeSaved') === '1' ? { kind: 'saved' } : null;
    const total = db.countMessages(config.guildId);
    const weekRows = db.topUsers(config.guildId, 10, week.start, week.end);
    const allRows = db.topUsers(config.guildId, 10);
    const embedTotal = db.countEmbeds(config.guildId);
    const embedPages = Math.max(1, Math.ceil(embedTotal / EMBEDS_PAGE_SIZE));
    const embedPage = parsePage(c.req.query('embedsPage'), embedPages);
    const recentEmbeds = db.recentEmbeds(config.guildId, EMBEDS_PAGE_SIZE, (embedPage - 1) * EMBEDS_PAGE_SIZE);

    // Cache-only lookups: guild member -> global user -> raw id (handled in the view).
    const members: Record<string, { name: string; avatar: string | null }> = {};
    for (const userId of [session.userId, ...weekRows.map((r) => r.userId), ...allRows.map((r) => r.userId)]) {
      if (members[userId]) continue;
      const m = guild?.members.cache.get(userId);
      const u = m?.user ?? client.users.cache.get(userId);
      if (m) members[userId] = { name: m.displayName, avatar: m.displayAvatarURL({ size: 64 }) };
      else if (u) members[userId] = { name: u.displayName, avatar: u.displayAvatarURL({ size: 64 }) };
    }
    const channelNames: Record<string, string> = {};
    for (const { channelId } of recentEmbeds) {
      const name = guild?.channels.cache.get(channelId)?.name;
      if (name) channelNames[channelId] = name;
    }

    const builderFlash: DashboardData['builder']['flash'] =
      c.req.query('builderSaved') === '1' ? { kind: 'saved' } : c.req.query('builderError') ? { kind: 'error', reason: (c.req.query('builderError') ?? '').slice(0, 200) } : null;
    const agent = config.opencodePassword ? await probeAgent(config.opencodeUrl, config.opencodePassword, 3000) : null;

    const you: DashboardData['you'] = {
      allRank: db.userRank(config.guildId, session.userId),
      weekRank: db.userRank(config.guildId, session.userId, week.start, week.end),
      xp: db.getUserXp(config.guildId, session.userId)?.xp ?? null,
      stats: db.userStats(config.guildId, session.userId),
      reactions: db.reactionStats(config.guildId, session.userId),
      voice: db.voiceStats(config.guildId, session.userId),
      activityMs: db.totalActivityMs(config.guildId, session.userId),
      topActivities: db.topActivities(config.guildId, session.userId, 5),
      topVoice: db.topVoiceChannels(config.guildId, session.userId, 3),
      emojiGiven: db.topEmojiForUser(config.guildId, session.userId, 5),
      emojiReceived: db.topEmojiReceived(config.guildId, session.userId, 5),
      nowPlaying: db.currentActivities(config.guildId, session.userId),
      inVoice: db.currentVoiceChannel(config.guildId, session.userId),
    };
    for (const channelId of [...you.topVoice.map((v) => v.channelId), ...(you.inVoice ? [you.inVoice.channelId] : [])]) {
      const name = guild?.channels.cache.get(channelId)?.name;
      if (name) channelNames[channelId] = name;
    }

    return c.html(
      dashboardPage({
        you,
        settings,
        channels,
        botStatus: {
          ping: client.ws.ping,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          guilds: client.guilds.cache.size,
          totalMessages: total,
          dbBytes: db.sizeBytes,
          lastWeeklySent: db.getState(`weekly:${config.guildId}`),
          embedsConverted: embedTotal,
          errors24h: db.countLogErrorsSince(Date.now() - 24 * 3600 * 1000),
        },
        today: db.countMessages(config.guildId, startOfDay(settings.timezone)),
        week: { bounds: week, total: db.countMessages(config.guildId, week.start, week.end), rows: weekRows },
        allTime: { total, rows: allRows },
        reactions: { total: db.countReactions(config.guildId), top: db.topEmojiAll(config.guildId, 8) },
        recentEmbeds,
        embedPage: { page: embedPage, pages: embedPages, total: embedTotal, pageSize: EMBEDS_PAGE_SIZE },
        members,
        channelNames,
        xpByUser: db.getUserXpTotals(config.guildId),
        user: { id: session.userId, username: session.username, avatar: session.avatar },
        saved: c.req.query('saved') === '1',
        weeklyFlash:
          c.req.query('weekly') === 'sent'
            ? { kind: 'sent' }
            : c.req.query('weekly') === 'error'
              ? { kind: 'error', reason: (c.req.query('reason') ?? '').slice(0, 200) }
              : null,
        free: {
          settings: freeSettings,
          roles: listRoles(),
          webhookEnabled: !!config.freestuffPublicKey,
          postedCount: db.countFreePosted(config.guildId),
          flash: freeFlash,
        },
        builder: { settings: db.getBuilderSettings(), passwordSet: !!config.opencodePassword, agent, flash: builderFlash },
      }),
    );
  });

  app.get('/dashboard/logs', requireAdmin, (c) => {
    const session = c.get('session');
    const settings = db.getSettings(config.guildId);
    const levelQ = c.req.query('level');
    const level = levelQ === 'warn' || levelQ === 'error' ? levelQ : 'all';
    const tag = c.req.query('tag')?.trim().slice(0, 64) || null;
    return c.html(
      logsPage({
        rows: db.recentLogs({ limit: 300, level, tag }),
        tags: db.logTags(),
        level,
        tag,
        timezone: settings.timezone,
        user: { username: session.username, avatar: session.avatar },
      }),
    );
  });

  app.get('/dashboard/requests', requireAdmin, (c) => {
    const session = c.get('session');
    const guild = client.guilds.cache.get(config.guildId);
    const totals = db.buildUsageTotals(config.guildId);
    const pages = Math.max(1, Math.ceil(totals.jobs / REQUESTS_PAGE_SIZE));
    const page = parsePage(c.req.query('page'), pages);
    const jobs = db.recentBuildJobs(config.guildId, REQUESTS_PAGE_SIZE, (page - 1) * REQUESTS_PAGE_SIZE);
    const members: Record<string, string> = {};
    const chats = db.recentChatThreads(config.guildId, REQUESTS_PAGE_SIZE);
    for (const id of [...jobs.map((j) => j.requesterId), ...chats.map((ch) => ch.startedBy)]) {
      if (members[id]) continue;
      const name = guild?.members.cache.get(id)?.displayName ?? client.users.cache.get(id)?.displayName;
      if (name) members[id] = name;
    }
    return c.html(
      requestsPage({ queuePositions: Object.fromEntries(sortQueue(db.listBuildJobsByStatus(['queued'])).map((j, i) => [j.id, i + 1])), jobs, totals, chatTotals: db.chatUsageTotals(config.guildId), chats, page, pages, pageSize: REQUESTS_PAGE_SIZE, guildId: config.guildId, timezone: db.getSettings(config.guildId).timezone, members, user: { username: session.username, avatar: session.avatar } }),
    );
  });

  app.post('/builder-settings', requireAdmin, async (c) => {
    const form = await c.req.parseBody();
    const { settings, modelError } = parseBuilderForm(form, db.getBuilderSettings());
    db.setBuilderSettings(settings);
    console.log(`[web] AI assistant settings updated by ${c.get('session').username} (chat=${settings.chatEnabled} chatModel=${settings.chatModel} decisionModel=${settings.chatDecisionModel} chatLangs=${settings.chatLanguages.join(',') || 'any'} builds=${settings.enabled} model=${settings.model})`);
    return c.redirect(modelError ? `/dashboard?builderError=${encodeURIComponent(`${modelError} — model not changed`)}#builder` : '/dashboard?builderSaved=1#builder');
  });

  app.post('/free-settings', requireAdmin, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const next = parseFreeForm(form, config.guildId, new Set(listChannels().map((ch) => ch.id)), new Set(listRoles().map((r) => r.id)));
    db.saveFreeSettings(next);
    console.log(`[web] free games settings updated by ${c.get('session').username}`);
    return c.redirect('/dashboard?freeSaved=1#free');
  });

  app.post('/settings', requireAdmin, async (c) => {
    // all: true — repeated checkbox values (embedChannels) arrive as an array
    // instead of only the last one overwriting the rest.
    const form = await c.req.parseBody({ all: true });
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
      levelingEnabled: form.levelingEnabled === '1',
      levelupChannelId: str(form.levelupChannel) || null,
    };
    db.saveSettings(next);
    console.log(`[web] settings updated by ${c.get('session').username}`);
    return c.redirect('/dashboard?saved=1');
  });

  // Manual test send. Deliberately does not touch the `weekly:<guild>` state key,
  // so it never suppresses the scheduled post. Same auth/CSRF model as /settings
  // (admin session cookie, SameSite=Lax).
  app.post('/weekly/send-now', requireAdmin, async (c) => {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      console.error(`[web] weekly stats send-now failed: guild ${config.guildId} not in cache`);
      return c.redirect(`/dashboard?weekly=error&reason=${encodeURIComponent('guild not available')}`);
    }
    const result = await postWeeklyStats(guild, db, db.getSettings(config.guildId));
    if (!result.ok) {
      console.error(`[web] weekly stats send-now failed: ${result.reason} (guild ${config.guildId})`);
      return c.redirect(`/dashboard?weekly=error&reason=${encodeURIComponent(result.reason.slice(0, 200))}`);
    }
    console.log(`[web] weekly stats sent manually by ${c.get('session').username} to channel ${result.channelId} (guild ${config.guildId})`);
    return c.redirect('/dashboard?weekly=sent');
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
      freeGames: db.getFreeSettings(config.guildId),
      bot: { ping: client.ws.ping, guilds: client.guilds.cache.size, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) },
    });
  });

  return app;
}

export function startWebServer(client: Client, db: BotDatabase): void {
  const app = createWebApp(client, db);
  serve({ fetch: app.fetch, port: config.dashboardPort, hostname: '0.0.0.0' }, (info) => {
    console.log(`[web] dashboard on http://localhost:${info.port} (register ${config.dashboardUrl}/auth/callback as the OAuth redirect)`);
    console.log(
      config.freestuffPublicKey
        ? `[web] FreeStuff webhook enabled at ${config.dashboardUrl}/webhooks/freestuff`
        : '[web] FreeStuff webhook disabled (set FREESTUFF_PUBLIC_KEY to enable)',
    );
  });
}
