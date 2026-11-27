import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono, type Context, type Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { ChannelType, PermissionFlagsBits, type Client, type ForumChannel, type SendableChannels } from 'discord.js';
import type { BotDatabase, ChallengeFilter, ChallengeSort, Settings, WebSessionRow } from '../db.js';
import { config } from '../config.js';
import { currentWeekBounds, lastWeekBounds, startOfDay, weekRangeLabel } from '../stats.js';
import { challengeDetailPage, challengesPage, chromeParts, dashboardPage, errorPage, faviconSvg, loginPage, logsPage, logsParts, overviewParts, parsePageSize, pickEmoji, requestsPage, requestsParts, sessionPage, sessionParts, settingsPage, type ChallengeDetailData, type ChallengesPageData, type ChallengeTab, type LogsPageData, type OverviewData, type PageFlash, type RequestsPageData, type SessionPageData, type SettingsPageData } from './views.js';
import { cachedDeployments, dokployEnabled, fetchDeployments, type DeployResult, type DeployStatus, type DokployConfig } from '../dokploy.js';
import { postMonthlyRecap, postWeeklyStats } from '../scheduler.js';
import { announceEverywhere } from '../freegames/actions.js';
import { createReplayGuard, FREESTUFF_COMPAT_DATE, handleFreeStuffWebhook } from '../freegames/freestuff.js';
import { parseFreeForm } from '../freegames/form.js';
import { parseBuilderForm } from '../builder/form.js';
import { sortQueue } from '../builder/queue.js';
import type { BuilderRunner } from '../builder/runner.js';
import { OpenCodeAgent, probeAgent, type AgentStatus } from '../builder/opencode.js';
import { fetchTranscript } from '../builder/transcript.js';
import { buildColorMessage, COLOR_MARKER, sortColorRoles } from '../colors.js';
import { challengeStatus, challengeWindow, emptyDraft, formatChallengeTarget, MAX_CHALLENGE_GOALS, MAX_SET_VALUE, parseEntryValue, parseGoal, parseWizardStep, rankProgress, shouldFlagEntry, type ChallengeDraft, type ChallengeWizardStep } from '../challenges/form.js';
import { createAndPostChallenge, finalizeChallenge, isForumChannelType, refreshChallengeCard } from '../challenges/actions.js';
import { goalName, isManualMetric } from '../challenges/types.js';

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
const SESSION_TTL_MS = 7 * 86400_000; // session lifetime, matched by the cookie's maxAge
const sessions = new Map<string, Session>(); // sid -> session (runtime cache; the DB is the source of truth)
const startedAt = Date.now();
const DEPLOY_PAGE_WAIT_MS = 1200; // a page render waits this long for Dokploy, then shows "unavailable"
const DEPLOY_LIVE_WAIT_MS = 4000;
const FAVICON = faviconSvg();

/** Where /bot-avatar redirects: the bot's Discord avatar, or the cloud mark when it has none. Pure. */
export function botAvatarTarget(avatarUrl: string | null): string {
  return avatarUrl || '/favicon.svg';
}

// Static assets live next to this module: src/web/assets under tsx, dist/web/assets after
// `npm run build` (which copies them). The second path covers `node dist/...` in a checkout
// whose dist predates the copy step.
function loadAsset(name: string): Uint8Array | null {
  for (const rel of [`./assets/${name}`, `../../src/web/assets/${name}`]) {
    try {
      return new Uint8Array(readFileSync(new URL(rel, import.meta.url)));
    } catch {
      // try the next location
    }
  }
  console.error(`[web] asset ${name} not found; the dashboard background will be plain`);
  return null;
}

// Cloud background: a 1-bit ordered-dithered (Bayer 4x4, 2x upscaled) white-on-transparent
// rendering of "Cumulus congestus clouds (27075262952)" by HO JJ (Taipei, Taiwan), mirrored.
// Source: https://commons.wikimedia.org/wiki/File:Cumulus_congestus_clouds_(27075262952).jpg
// License: CC0 1.0 Universal (public domain dedication); no attribution required.
const CLOUDS = loadAsset('clouds.png');

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

export function createWebApp(client: Client, db: BotDatabase, opts: { freestuffPublicKey?: string | null; builder?: Pick<BuilderRunner, 'cancelJob' | 'retryJob'> } = {}): Hono {
  const app = new Hono();
  const freestuffKey = opts.freestuffPublicKey === undefined ? config.freestuffPublicKey : opts.freestuffPublicKey;
  const freestuffReplay = createReplayGuard();
  const dokploy: DokployConfig = { url: config.dokployUrl, apiKey: config.dokployApiKey, composeId: config.dokployComposeId };

  // Sessions live in the DB, so a redeploy/restart doesn't log anyone out.
  // The signed cookie is still the gate; this map is just the runtime cache.
  // Expired rows are pruned by loadWebSessions.
  const restored = db.loadWebSessions();
  for (const s of restored) sessions.set(s.sid, { userId: s.userId, username: s.username, avatar: s.avatar, accessToken: s.accessToken });
  if (restored.length > 0) console.log(`[web] restored ${restored.length} dashboard session(s), no re-login needed`);

  app.get('/favicon.svg', (c) => c.body(FAVICON, 200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=2592000' }));
  app.get('/bot-avatar', (c) => {
    const url = client.user?.avatarURL({ extension: 'png', size: 128 }) ?? null;
    c.header('cache-control', 'public, max-age=3600');
    return c.redirect(botAvatarTarget(url), 302);
  });
  app.get('/favicon.ico', (c) => c.redirect('/bot-avatar', 302));
  // Public and immutable: the URL in the CSS carries a content hash (CLOUDS_URL in views.ts).
  app.get('/assets/clouds.png', (c) => (CLOUDS ? c.body(CLOUDS.slice().buffer, 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' }) : c.notFound()));

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
      const session: Session = {
        userId: check.user.id,
        username: check.user.global_name ?? check.user.username,
        avatar,
        accessToken: token.access_token,
      };
      sessions.set(sid, session);
      db.saveWebSession({ sid, ...session, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
      setCookie(c, SID_COOKIE, sessionCookieValue(sid), { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_MS / 1000 });
      return c.redirect('/dashboard');
    } catch (err) {
      console.error('[web] oauth callback failed:', err);
      return c.html(errorPage('Discord login failed. Please try again.'), 500);
    }
  });

  app.get('/logout', (c) => {
    const session = verifySessionCookie(getCookie(c)[SID_COOKIE]);
    if (session) {
      db.deleteWebSessionsForUser(session.userId);
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
  // Same gate for JSON endpoints polled by the dashboard: 401 instead of a redirect to /login.
  const requireAdminJson = async (c: Context, next: Next) => {
    const session = verifySessionCookie(getCookie(c)[SID_COOKIE]);
    if (!session) return c.json({ error: 'unauthorized' }, 401);
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
  // Channels a challenge card can be posted to: text/announcement (a message each)
  // or forum/media (one post each).
  const listChallengeChannels = (): { id: string; name: string }[] => {
    const guild = client.guilds.cache.get(config.guildId);
    return guild
      ? guild.channels.cache
          .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement || isForumChannelType(ch.type))
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

  // Channel a picker message can be posted in, or null when it is missing or not sendable.
  const sendableChannel = async (channelId: string) => {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return null;
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    return channel && channel.isSendable() ? channel : null;
  };

  // Channel a challenge card can be posted in: sendable text, or a forum/media channel.
  const challengePostChannel = async (channelId: string): Promise<SendableChannels | ForumChannel | null> => {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return null;
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel) return null;
    if (isForumChannelType(channel.type)) return channel as ForumChannel;
    return channel.isSendable() ? channel : null;
  };

  // Best-effort removal of an old picker message (the channel or message may be gone).
  const deletePickerMessage = async (channelId: string | null, messageId: string | null): Promise<void> => {
    if (!channelId || !messageId) return;
    const channel = await sendableChannel(channelId);
    if (!channel) return;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) await message.delete().catch(() => undefined);
  };

  // Deployment status for the shell/health pills: null when Dokploy isn't configured. Waits at
  // most `waitMs` so a slow Dokploy never holds a page; the live refresh fills it in afterwards.
  const deployStatus = async (waitMs: number): Promise<DeployStatus> => {
    if (!dokployEnabled(dokploy)) return null;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<DeployResult>((resolve) => {
      timer = setTimeout(() => resolve(cachedDeployments() ?? { ok: false, error: 'pending' }), waitMs);
      timer.unref();
    });
    const result = await Promise.race([fetchDeployments(dokploy), late]);
    clearTimeout(timer);
    return result;
  };

  // One loader for the Overview page and its live refresh. `embedsPage: null` skips the embed
  // table (the live endpoint doesn't render it).
  const EMOJI_CAP = 500; // most emoji the expanded usage list shows
  const loadOverview = (session: Session, opts: { week: string | undefined; embedsPage: string | undefined | null; embedsSize?: string | undefined; emoji?: string | undefined; all?: string | undefined; deploy: DeployStatus }): OverviewData => {
    const guild = client.guilds.cache.get(config.guildId);
    const settings = db.getSettings(config.guildId);
    const nowMs = Date.now();
    const week = lastWeekBounds(settings.timezone);
    const curWeek = currentWeekBounds(settings.timezone);
    const curEnd = Math.min(curWeek.end, nowMs);
    const weekSel: OverviewData['week']['selected'] = opts.week === 'last' ? 'last' : 'current';
    const total = db.countMessages(config.guildId);
    const weekRows = db.topUsers(config.guildId, 10, week.start, week.end);
    const curWeekRows = db.topUsers(config.guildId, 10, curWeek.start, curEnd);
    const allRows = db.topUsers(config.guildId, 10);
    const lastWeekTotal = db.countMessages(config.guildId, week.start, week.end);
    const curWeekTotal = db.countMessages(config.guildId, curWeek.start, curEnd);
    const weekChannelRows = db.topChannels(config.guildId, week.start, week.end, 10);
    const curWeekChannelRows = db.topChannels(config.guildId, curWeek.start, curEnd, 10);
    const allChannelRows = db.topChannelsAll(config.guildId, 10);
    const embedTotal = db.countEmbeds(config.guildId);
    const embedSize = parsePageSize(opts.embedsSize);
    const embedPages = Math.max(1, Math.ceil(embedTotal / embedSize));
    const embedPage = parsePage(opts.embedsPage ?? undefined, embedPages);
    const recentEmbeds = opts.embedsPage === null ? [] : db.recentEmbeds(config.guildId, embedSize, (embedPage - 1) * embedSize);
    // Emoji usage: all-time ranking (top 10, expandable to EMOJI_CAP) and the selected emoji's reactors.
    const emojiAll = opts.all === '1';
    const emojiRows = db.topEmojiAll(config.guildId, emojiAll ? EMOJI_CAP : 10);
    const selectedEmoji = pickEmoji(emojiRows, opts.emoji);
    const emojiUsers = selectedEmoji ? db.topEmojiUsers(config.guildId, selectedEmoji.emojiKey, 10) : [];

    // Cache-only lookups: guild member -> global user -> raw id (handled in the view).
    const members: OverviewData['members'] = {};
    for (const userId of [session.userId, ...weekRows.map((r) => r.userId), ...curWeekRows.map((r) => r.userId), ...allRows.map((r) => r.userId), ...emojiUsers.map((r) => r.userId)]) {
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
    for (const { channelId } of [...weekChannelRows, ...curWeekChannelRows, ...allChannelRows]) {
      const name = guild?.channels.cache.get(channelId)?.name;
      if (name) channelNames[channelId] = name;
    }

    const you: OverviewData['you'] = {
      allRank: db.userRank(config.guildId, session.userId),
      currentWeekRank: db.userRank(config.guildId, session.userId, curWeek.start, curEnd),
      lastWeekRank: db.userRank(config.guildId, session.userId, week.start, week.end),
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

    return {
      you,
      timezone: settings.timezone,
      deploy: opts.deploy,
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
      week: {
        selected: weekSel,
        current: { bounds: curWeek, total: curWeekTotal, rows: curWeekRows },
        last: { bounds: week, total: lastWeekTotal, rows: weekRows },
      },
      allTime: { total, rows: allRows },
      channelWeek: {
        current: { bounds: curWeek, total: curWeekTotal, rows: curWeekChannelRows },
        last: { bounds: week, total: lastWeekTotal, rows: weekChannelRows },
      },
      channelAllTime: { total, rows: allChannelRows },
      reactions: { total: db.countReactions(config.guildId), top: db.topEmojiAll(config.guildId, 8) },
      emojis: {
        count: db.countEmojiKeys(config.guildId),
        rows: emojiRows,
        all: emojiAll,
        selected: selectedEmoji,
        users: emojiUsers,
        userCount: selectedEmoji ? db.countEmojiUsers(config.guildId, selectedEmoji.emojiKey) : 0,
        members,
      },
      recentEmbeds,
      embedPage: { page: embedPage, pages: embedPages, total: embedTotal, pageSize: embedSize },
      members,
      channelNames,
      xpByUser: db.getUserXpTotals(config.guildId),
      user: { id: session.userId, username: session.username, avatar: session.avatar },
    };
  };

  const loadLogs = (session: Session, q: { level: string | undefined; tag: string | undefined; page: string | undefined; size?: string | undefined }, deploy: DeployStatus): LogsPageData => {
    const level = q.level === 'warn' || q.level === 'error' ? q.level : 'all';
    const tag = q.tag?.trim().slice(0, 64) || null;
    const total = db.countLogs({ level, tag });
    const pageSize = parsePageSize(q.size);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = parsePage(q.page, pages);
    return {
      rows: db.recentLogs({ limit: pageSize, offset: (page - 1) * pageSize, level, tag }),
      tags: db.logTags(),
      level,
      tag,
      page,
      pages,
      pageSize,
      total,
      timezone: db.getSettings(config.guildId).timezone,
      user: { username: session.username, avatar: session.avatar },
      deploy,
    };
  };

  const loadRequests = (session: Session, pageQ: string | undefined, chatPageQ: string | undefined, sizeQ: string | undefined, chatSizeQ: string | undefined, deploy: DeployStatus): RequestsPageData => {
    const guild = client.guilds.cache.get(config.guildId);
    const totals = db.buildUsageTotals(config.guildId);
    const chatTotals = db.chatUsageTotals(config.guildId);
    const pageSize = parsePageSize(sizeQ);
    const chatPageSize = parsePageSize(chatSizeQ);
    const chatPages = Math.max(1, Math.ceil((chatTotals.threads + chatTotals.oneOffs) / chatPageSize));
    const chatPage = parsePage(chatPageQ, chatPages);
    const pages = Math.max(1, Math.ceil(totals.jobs / pageSize));
    const page = parsePage(pageQ, pages);
    const jobs = db.recentBuildJobs(config.guildId, pageSize, (page - 1) * pageSize);
    const members: Record<string, string> = {};
    const chats = db.recentChatThreads(config.guildId, chatPageSize, (chatPage - 1) * chatPageSize);
    for (const id of [...jobs.map((j) => j.requesterId), ...chats.map((ch) => ch.startedBy)]) {
      if (members[id]) continue;
      const name = guild?.members.cache.get(id)?.displayName ?? client.users.cache.get(id)?.displayName;
      if (name) members[id] = name;
    }
    return { queuePositions: Object.fromEntries(sortQueue(db.listBuildJobsByStatus(['queued'])).map((j, i) => [j.id, i + 1])), jobs, totals, chatTotals, chats, page, pages, pageSize, chatPage, chatPages, chatPageSize, guildId: config.guildId, timezone: db.getSettings(config.guildId).timezone, members, user: { username: session.username, avatar: session.avatar }, deploy };
  };

  const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;
  // Session detail page data; null when the id is unknown (404). A failed or unconfigured
  // transcript fetch becomes `error` on the page instead of throwing.
  const loadSession = async (session: Session, id: string, cursorQ: string | undefined, deploy: DeployStatus): Promise<SessionPageData | null> => {
    if (!SESSION_ID_RE.test(id)) return null;
    const owner = db.findSessionOwner(config.guildId, id);
    if (!owner) return null;
    const guild = client.guilds.cache.get(config.guildId);
    const members: Record<string, string> = {};
    const memberId = owner.kind === 'job' ? owner.job.requesterId : owner.thread.startedBy;
    const name = guild?.members.cache.get(memberId)?.displayName ?? client.users.cache.get(memberId)?.displayName;
    if (name) members[memberId] = name;
    const cursor = cursorQ && cursorQ.length <= 512 ? cursorQ : null;
    let entries: SessionPageData['entries'] = [];
    let olderCursor: string | null = null;
    let error: string | null = null;
    if (!config.opencodePassword) error = 'The agent server is not configured (OPENCODE_PASSWORD is not set), so the transcript cannot be loaded.';
    else {
      try {
        const agent = new OpenCodeAgent(config.opencodeUrl, config.opencodePassword);
        ({ entries, olderCursor } = await fetchTranscript(agent.client, id, cursor ? { cursor } : {}));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[web] session transcript ${id} failed: ${reason}`);
        error = `Could not load the transcript from the agent server: ${reason}`;
      }
    }
    return { sessionId: id, owner, entries, olderCursor, cursor, error, guildId: config.guildId, timezone: db.getSettings(config.guildId).timezone, members, user: { username: session.username, avatar: session.avatar }, deploy };
  };

  app.get('/dashboard', requireAdmin, async (c) => {
    const deploy = await deployStatus(DEPLOY_PAGE_WAIT_MS);
    return c.html(dashboardPage(loadOverview(c.get('session'), { week: c.req.query('week'), embedsPage: c.req.query('embedsPage'), embedsSize: c.req.query('embedsSize'), emoji: c.req.query('emoji'), all: c.req.query('all'), deploy })));
  });

  // Old Emojis page: the section now lives on the Overview.
  app.get('/dashboard/emojis', requireAdmin, (c) => {
    const q = new URLSearchParams();
    const emoji = c.req.query('emoji');
    const all = c.req.query('all');
    if (emoji) q.set('emoji', emoji);
    if (all === '1') q.set('all', '1');
    const qs = q.toString();
    return c.redirect(`/dashboard${qs ? '?' + qs : ''}#h-emoji-users`, 302);
  });

  // Live refresh: the regions of a page as HTML, rendered by the same view functions as the
  // full page. `view` picks the page; the other query params are that page's own.
  app.get('/dashboard/live', requireAdminJson, async (c) => {
    const session = c.get('session');
    const deploy = await deployStatus(DEPLOY_LIVE_WAIT_MS);
    c.header('cache-control', 'no-store');
    switch (c.req.query('view')) {
      case 'overview':
        return c.json({ parts: overviewParts(loadOverview(session, { week: c.req.query('week'), embedsPage: null, emoji: c.req.query('emoji'), all: c.req.query('all'), deploy })) });
      case 'logs':
        return c.json({ parts: logsParts(loadLogs(session, { level: c.req.query('level'), tag: c.req.query('tag'), page: c.req.query('page'), size: c.req.query('size') }, deploy)) });
      case 'requests':
        return c.json({ parts: requestsParts(loadRequests(session, c.req.query('page'), c.req.query('chatPage'), c.req.query('size'), c.req.query('chatSize'), deploy)) });
      case 'session': {
        if (c.req.query('cursor')) return c.json({ error: 'older pages do not refresh' }, 400);
        const data = await loadSession(session, c.req.query('id') ?? '', undefined, deploy);
        return data ? c.json({ parts: sessionParts(data) }) : c.json({ error: 'not found' }, 404);
      }
      case 'settings':
      case 'challenges':
        return c.json({ parts: chromeParts(deploy) }); // forms are never refreshed
      default:
        return c.json({ error: 'unknown view' }, 400);
    }
  });

  // Challenges: the list page (status filters + 3-step wizard) and one challenge's
  // overview / progress / activity tabs. POSTs redirect back here with a query flash.
  const CHALLENGE_FILTERS = ['all', 'upcoming', 'active', 'ended'] as const;
  const challengeFilter = (raw: string | undefined): ChallengeFilter =>
    (CHALLENGE_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as ChallengeFilter) : 'all';
  const CHALLENGE_SORTS = ['newest', 'ending', 'name'] as const;
  const challengeSort = (raw: string | undefined): ChallengeSort => ((CHALLENGE_SORTS as readonly string[]).includes(raw ?? '') ? (raw as ChallengeSort) : 'newest');

  const challengeFlash = (q: Record<string, string | undefined>): ChallengesPageData['flash'] => {
    if (q.challengeCreated) return { kind: 'saved', message: `Challenge "${q.challengeCreated.slice(0, 100)}" created and posted.` };
    if (q.challengeError) return { kind: 'error', message: q.challengeError.slice(0, 300) };
    if (q.challengeEnded && /^\d+$/.test(q.challengeEnded)) return { kind: 'saved', message: `Challenge #${q.challengeEnded} ended; the top 3 by overall goal share got the reward role.` };
    if (q.challengeDeleted && /^\d+$/.test(q.challengeDeleted)) return { kind: 'saved', message: `Challenge #${q.challengeDeleted} deleted.` };
    if (q.challengeUpdated) return { kind: 'saved', message: q.challengeUpdated.slice(0, 200) };
    return null;
  };

  const challengeNames = (): { channels: { id: string; name: string }[]; roles: { id: string; name: string }[] } => ({ channels: listChallengeChannels(), roles: listRoles() });

  const loadChallengesPage = (session: Session, q: Record<string, string | undefined>, deploy: DeployStatus, now = Date.now()): ChallengesPageData => {
    const status = challengeFilter(q.status);
    const sort = challengeSort(q.sort);
    const counts = db.challengeStatusCounts(config.guildId, now);
    const total = counts[status];
    const pageSize = parsePageSize(q.size);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = parsePage(q.page, pages);
    const list = db
      .listChallenges(config.guildId, { status, sort, limit: pageSize, offset: (page - 1) * pageSize, now })
      .map((challenge) => ({ challenge, status: challengeStatus(challenge, now), joined: db.challengeParticipantCount(challenge.id) }));
    const guild = client.guilds.cache.get(config.guildId);
    return {
      wizard: { step: 1, draft: emptyDraft(now), errors: [] },
      list,
      counts,
      status,
      sort,
      page,
      pages,
      pageSize,
      total,
      ...challengeNames(),
      activityNames: db.activityNames(config.guildId, '', 100),
      canManageRoles: guild?.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false,
      timezone: db.getSettings(config.guildId).timezone,
      challengeChannelId: db.getSettings(config.guildId).challengeChannelId,
      flash: challengeFlash(q),
      user: { username: session.username, avatar: session.avatar },
      deploy,
    };
  };

  const loadChallengeDetail = (session: Session, rawId: string, q: Record<string, string | undefined>, deploy: DeployStatus, now = Date.now()): ChallengeDetailData | null => {
    const id = Number(rawId);
    const challenge = Number.isSafeInteger(id) && id > 0 ? db.getChallenge(id) : null;
    if (!challenge || challenge.guildId !== config.guildId) return null;
    const participants = db.challengeParticipants(challenge.id);
    const names = new Map(participants.map((p) => [p.userId, p.displayName]));
    const goals = db.challengeGoals(challenge.id);
    const goalsWithRows = goals.map((goal) => {
      const totals = isManualMetric(goal.metric)
        ? db.challengeEntryTotals(goal.id, challenge.startsAt, challenge.endsAt)
        : db.challengeTotals(challenge.guildId, goal.metric, goal.activityName, challenge.startsAt, challenge.endsAt, now);
      return { goal, rows: rankProgress(participants, totals).map((r) => ({ ...r, name: names.get(r.userId) ?? r.userId })) };
    });
    const pageSize = parsePageSize(q.size);
    const progressPages = Math.max(1, Math.ceil(participants.length / pageSize));
    const progressPage = parsePage(q.page, progressPages);
    const flaggedOnly = q.flagged === '1';
    const entryTotal = db.countChallengeEntries(challenge.id, { flaggedOnly });
    const entryPages = Math.max(1, Math.ceil(entryTotal / pageSize));
    const entryPage = parsePage(q.page, entryPages);
    const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
    const entryRows = db
      .challengeEntries(challenge.id, { flaggedOnly, limit: pageSize, offset: (entryPage - 1) * pageSize })
      .flatMap((entry) => {
        const goal = goalsById.get(entry.goalId);
        return goal ? [{ entry, goal }] : [];
      });
    const eventTotal = db.countChallengeEvents(challenge.id);
    const eventPages = Math.max(1, Math.ceil(eventTotal / pageSize));
    const eventPage = parsePage(q.page, eventPages);
    const tab: ChallengeTab = q.tab === 'progress' || q.tab === 'entries' || q.tab === 'activity' ? q.tab : 'overview';
    const guild = client.guilds.cache.get(config.guildId);
    return {
      challenge,
      status: challengeStatus(challenge, now),
      tab,
      joined: participants.length,
      goals: goalsWithRows,
      progress: { page: progressPage, pages: progressPages, pageSize, total: participants.length },
      entries: { rows: entryRows, page: entryPage, pages: entryPages, pageSize, total: entryTotal, flaggedOnly },
      events: { rows: db.challengeEvents(challenge.id, pageSize, (eventPage - 1) * pageSize), page: eventPage, pages: eventPages, pageSize, total: eventTotal },
      timezone: db.getSettings(config.guildId).timezone,
      channelName: guild?.channels.cache.get(challenge.channelId)?.name ?? challenge.channelId,
      canManageRoles: guild?.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false,
      flash: challengeFlash(q),
      user: { username: session.username, avatar: session.avatar },
      deploy,
    };
  };
  // Shared by the settings page and the wizard POSTs (which render the page again on error or
  // for the next step). POSTs pass agent/deploy null so they never wait on OpenCode or Dokploy.
  const settingsPageData = (
    session: Session,
    q: Record<string, string | undefined>,
    opts: { agent: AgentStatus | null; deploy: DeployStatus },
  ): SettingsPageData => {
    const colorSettings = db.getColorSettings(config.guildId);
    const colorRoles = db.getColorRoles(config.guildId);
    const guild = client.guilds.cache.get(config.guildId);
    return {
      settings: db.getSettings(config.guildId),
      channels: listChannels(),
      challengeChannels: listChallengeChannels(),
      user: { username: session.username, avatar: session.avatar },
      deploy: opts.deploy,
      saved: q.saved === '1',
      weeklyFlash:
        q.weekly === 'sent'
          ? { kind: 'sent' }
          : q.weekly === 'error'
            ? { kind: 'error', reason: (q.reason ?? '').slice(0, 200) }
            : null,
      monthlyFlash:
        q.monthly === 'sent'
          ? { kind: 'sent' }
          : q.monthly === 'error'
            ? { kind: 'error', reason: (q.reason ?? '').slice(0, 200) }
            : null,
      free: {
        settings: db.getFreeSettings(config.guildId),
        roles: listRoles(),
        webhookEnabled: !!config.freestuffPublicKey,
        postedCount: db.countFreePosted(config.guildId),
        flash: q.freeSaved === '1' ? { kind: 'saved' } : null,
      },
      builder: {
        settings: db.getBuilderSettings(),
        passwordSet: !!config.opencodePassword,
        agent: opts.agent,
        flash: q.builderSaved === '1' ? { kind: 'saved' } : q.builderError ? { kind: 'error', reason: (q.builderError ?? '').slice(0, 200) } : null,
      },
      color: {
        channelId: colorSettings.channelId,
        roles: listRoles(),
        selected: colorRoles.map((r) => r.roleId),
        posted: colorRoles.filter((r) => r.messageId !== null).length,
        canManage: guild?.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false,
        flash:
          q.colorSaved === '1'
            ? ({ kind: 'saved' } as const)
            : q.colorError
              ? ({ kind: 'error', reason: (q.colorError ?? '').slice(0, 200) } as const)
              : null,
      },
    };
  };

  app.get('/dashboard/settings', requireAdmin, async (c) => {
    const session = c.get('session');
    const [agent, deploy] = await Promise.all([config.opencodePassword ? probeAgent(config.opencodeUrl, config.opencodePassword, 3000) : null, deployStatus(DEPLOY_PAGE_WAIT_MS)]);
    return c.html(settingsPage(settingsPageData(session, c.req.query(), { agent, deploy })));
  });

  app.get('/dashboard/challenges', requireAdmin, async (c) => {
    const deploy = await deployStatus(DEPLOY_PAGE_WAIT_MS);
    return c.html(challengesPage(loadChallengesPage(c.get('session'), c.req.query(), deploy)));
  });

  app.get('/dashboard/challenges/:id', requireAdmin, async (c) => {
    const deploy = await deployStatus(DEPLOY_PAGE_WAIT_MS);
    const data = loadChallengeDetail(c.get('session'), c.req.param('id') ?? '', c.req.query(), deploy);
    return data ? c.html(challengeDetailPage(data)) : c.text('Challenge not found.', 404);
  });

  const CHALLENGE_FIELDS = ['step', 'name', 'description', 'metric', 'activityName', 'label', 'target', 'startDate', 'endDate', 'rewardRoleId', 'nav'] as const;

  const challengeForm = (form: Record<string, unknown>): Record<string, string | undefined> => {
    const out: Record<string, string | undefined> = {};
    for (const key of CHALLENGE_FIELDS) {
      const value = form[key];
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  };

  const challengeWizardPage = (c: Context, step: ChallengeWizardStep, draft: ChallengeDraft, errors: string[], status: 200 | 400 = 200) =>
    c.html(
      challengesPage(
        { ...loadChallengesPage(c.get('session'), {}, null), wizard: { step, draft, errors } },
      ),
      status,
    );

  app.post('/challenge-wizard', requireAdmin, async (c) => {
    const raw = challengeForm(await c.req.parseBody());
    const stepNum = Number(raw.step);
    const step: ChallengeWizardStep = stepNum === 2 ? 2 : stepNum === 3 ? 3 : 1;
    const ctx = { roles: new Set(listRoles().map((r) => r.id)) };
    if (raw.nav === 'back') {
      const prev = (step > 1 ? step - 1 : 1) as ChallengeWizardStep;
      return challengeWizardPage(c, prev, parseWizardStep(raw, prev, ctx).draft, []);
    }
    const parsed = parseWizardStep(raw, step, ctx);
    if (parsed.errors.length > 0) return challengeWizardPage(c, step, parsed.draft, parsed.errors, 400);
    if (step < 3) return challengeWizardPage(c, (step + 1) as ChallengeWizardStep, parsed.draft, []);

    const now = Date.now();
    const window = challengeWindow(parsed.draft.startDate, parsed.draft.endDate, now);
    if (!window.ok) return challengeWizardPage(c, 3, parsed.draft, [window.reason], 400);
    const challengeChannelId = db.getSettings(config.guildId).challengeChannelId;
    if (!challengeChannelId) return challengeWizardPage(c, 3, parsed.draft, ['Set the challenges channel in Settings first.'], 400);
    const channel = await challengePostChannel(challengeChannelId);
    if (!channel) return challengeWizardPage(c, 3, parsed.draft, ['The challenges channel from Settings is missing or the bot cannot post in it.'], 400);

    const session = c.get('session');
    const result = await createAndPostChallenge(
      db,
      {
        guildId: config.guildId,
        name: parsed.draft.name,
        description: parsed.draft.description,
        metric: parsed.draft.metric,
        activityName: parsed.draft.metric === 'activity' ? parsed.draft.activityName : null,
        label: parsed.draft.label || null,
        target: parsed.draft.target,
        startsAt: window.window.startsAt,
        endsAt: window.window.endsAt,
        channelId: challengeChannelId,
        rewardRoleId: parsed.draft.rewardRoleId || null,
        createdBy: session.userId,
        createdByName: session.username,
      },
      channel,
      now,
    );
    if (!result.ok) return challengeWizardPage(c, 3, parsed.draft, [`Could not post the card: ${result.reason}`], 400);
    console.log(`[web] challenge #${result.challenge.id} "${result.challenge.name}" created by ${session.username}`);
    return c.redirect(`/dashboard/challenges?challengeCreated=${encodeURIComponent(parsed.draft.name)}`);
  });

  app.post('/challenge-goal-add', requireAdmin, async (c) => {
    const form = await c.req.parseBody();
    const challengeId = Number(typeof form.challengeId === 'string' ? form.challengeId : '');
    const challenge = Number.isSafeInteger(challengeId) ? db.getChallenge(challengeId) : null;
    if (!challenge || challenge.guildId !== config.guildId) return c.redirect(`/dashboard/challenges?challengeError=${encodeURIComponent('Challenge not found.')}`);
    const now = Date.now();
    if (challengeStatus(challenge, now) === 'ended') return c.redirect(`/dashboard/challenges/${challenge.id}?challengeError=${encodeURIComponent('This challenge has ended; goals cannot be added.')}`);
    if (db.challengeGoals(challenge.id).length >= MAX_CHALLENGE_GOALS) {
      return c.redirect(`/dashboard/challenges/${challenge.id}?challengeError=${encodeURIComponent(`A challenge can have at most ${MAX_CHALLENGE_GOALS} goals.`)}`);
    }
    const parsed = parseGoal({ metric: typeof form.metric === 'string' ? form.metric : undefined, activityName: typeof form.activityName === 'string' ? form.activityName : undefined, label: typeof form.label === 'string' ? form.label : undefined, target: typeof form.target === 'string' ? form.target : undefined });
    if (!parsed.ok) return c.redirect(`/dashboard/challenges/${challenge.id}?challengeError=${encodeURIComponent(parsed.reason)}`);
    const goal = db.addChallengeGoal({
      challengeId: challenge.id,
      metric: parsed.goal.metric,
      activityName: parsed.goal.metric === 'activity' ? parsed.goal.activityName : null,
      label: parsed.goal.label || null,
      target: parsed.goal.target,
      createdAt: now,
    });
    const session = c.get('session');
    db.addChallengeEvent({
      challengeId: challenge.id,
      ts: now,
      kind: 'goal_added',
      actorId: session.userId,
      actorName: session.username,
      detail: `${goalName(goal)} · ${goal.target > 0 ? `target ${formatChallengeTarget(goal.metric, goal.target)}` : 'no target'}`,
    });
    await refreshChallengeCard(client, db, challenge, now);
    console.log(`[web] challenge #${challenge.id} goal #${goal.id} (${goal.metric}) added by ${session.username}`);
    return c.redirect(`/dashboard/challenges/${challenge.id}?challengeUpdated=${encodeURIComponent('Goal added.')}`);
  });

  app.post('/challenge-entry', requireAdmin, async (c) => {
    const form = await c.req.parseBody();
    const challengeId = Number(typeof form.challengeId === 'string' ? form.challengeId : '');
    const entryId = Number(typeof form.entryId === 'string' ? form.entryId : '');
    const challenge = Number.isSafeInteger(challengeId) ? db.getChallenge(challengeId) : null;
    const entry = Number.isSafeInteger(entryId) ? db.getChallengeEntry(entryId) : null;
    if (!challenge || challenge.guildId !== config.guildId || !entry || entry.challengeId !== challenge.id) {
      return c.redirect(`/dashboard/challenges?challengeError=${encodeURIComponent('Entry not found.')}`);
    }
    const goal = db.getChallengeGoal(entry.goalId);
    if (!goal || goal.challengeId !== challenge.id) {
      return c.redirect(`/dashboard/challenges/${challenge.id}?tab=entries&challengeError=${encodeURIComponent('Entry not found.')}`);
    }
    const session = c.get('session');
    const now = Date.now();
    const reason = (typeof form.reason === 'string' ? form.reason : '').trim().slice(0, 300);
    const reasonText = reason ? ` · reason: ${reason}` : '';
    const op = typeof form.op === 'string' ? form.op : '';
    if (op === 'delete') {
      db.deleteChallengeEntry(entry.id);
      db.addChallengeEvent({ challengeId: challenge.id, ts: now, kind: 'entry_deleted', actorId: session.userId, actorName: session.username, detail: `${entry.displayName}: ${entry.value}${reasonText}` });
      await refreshChallengeCard(client, db, challenge, now);
      console.log(`[web] challenge #${challenge.id} entry #${entry.id} deleted by ${session.username}`);
      return c.redirect(`/dashboard/challenges/${challenge.id}?tab=entries&challengeUpdated=${encodeURIComponent('Entry deleted.')}`);
    }
    const value = parseEntryValue(typeof form.value === 'string' ? form.value : '');
    if (value === null) {
      return c.redirect(`/dashboard/challenges/${challenge.id}?tab=entries&challengeError=${encodeURIComponent(`The value must be a whole number between 1 and ${MAX_SET_VALUE}.`)}`);
    }
    const flagged = shouldFlagEntry(goal.metric, value);
    db.updateChallengeEntry(entry.id, value, flagged);
    db.addChallengeEvent({
      challengeId: challenge.id,
      ts: now,
      kind: 'entry_edited',
      actorId: session.userId,
      actorName: session.username,
      detail: `${entry.displayName}: ${entry.value} → ${value}${flagged ? ' · flagged for review' : ''}${reasonText}`,
    });
    await refreshChallengeCard(client, db, challenge, now);
    console.log(`[web] challenge #${challenge.id} entry #${entry.id} edited by ${session.username}`);
    return c.redirect(`/dashboard/challenges/${challenge.id}?tab=entries&challengeUpdated=${encodeURIComponent('Entry updated.')}`);
  });

  app.post('/challenge-end', requireAdmin, async (c) => {
    const form = await c.req.parseBody();
    const id = Number(typeof form.id === 'string' ? form.id : '');
    const challenge = Number.isSafeInteger(id) ? db.getChallenge(id) : null;
    if (!challenge || challenge.guildId !== config.guildId) return c.redirect(`/dashboard/challenges?challengeError=${encodeURIComponent('Challenge not found.')}`);
    const session = c.get('session');
    if (!(await finalizeChallenge(client, db, challenge, Date.now(), { id: session.userId, name: session.username }))) {
      return c.redirect(`/dashboard/challenges/${challenge.id}?challengeError=${encodeURIComponent('That challenge was already ended.')}`);
    }
    console.log(`[web] challenge #${challenge.id} ended by ${session.username}`);
    return c.redirect(`/dashboard/challenges/${challenge.id}?challengeEnded=${challenge.id}`);
  });

  app.post('/challenge-delete', requireAdmin, async (c) => {
    const form = await c.req.parseBody();
    const id = Number(typeof form.id === 'string' ? form.id : '');
    const challenge = Number.isSafeInteger(id) ? db.getChallenge(id) : null;
    if (!challenge || challenge.guildId !== config.guildId) return c.redirect(`/dashboard/challenges?challengeError=${encodeURIComponent('Challenge not found.')}`);
    // The card lives in the forum thread when there is one; archived threads are
    // not "sendable" but client.channels.fetch still resolves them.
    const cardChannel = await client.channels.fetch(challenge.threadId ?? challenge.channelId).catch(() => null);
    if (cardChannel?.isTextBased() && challenge.messageId) {
      const message = await cardChannel.messages.fetch(challenge.messageId).catch(() => null);
      if (message) await message.delete().catch(() => undefined);
    }
    db.deleteChallenge(challenge.id);
    console.log(`[web] challenge #${challenge.id} deleted by ${c.get('session').username}`);
    return c.redirect(`/dashboard/challenges?challengeDeleted=${challenge.id}`);
  });

  app.get('/dashboard/logs', requireAdmin, async (c) => {
    return c.html(logsPage(loadLogs(c.get('session'), { level: c.req.query('level'), tag: c.req.query('tag'), page: c.req.query('page'), size: c.req.query('size') }, await deployStatus(DEPLOY_PAGE_WAIT_MS))));
  });

  // One-shot toast after a cancel/retry redirect: `done` is a fixed code, `error` a short message.
  const actionFlash = (c: Context): PageFlash | undefined => {
    const done = c.req.query('done');
    const error = c.req.query('error');
    if (error) return { kind: 'error', text: error.slice(0, 200) };
    if (done === 'cancelled') return { kind: 'ok', text: 'Request cancelled.' };
    if (done === 'retried') return { kind: 'ok', text: 'Retry started.' };
    return undefined;
  };

  app.get('/dashboard/requests', requireAdmin, async (c) => {
    return c.html(requestsPage({ ...loadRequests(c.get('session'), c.req.query('page'), c.req.query('chatPage'), c.req.query('size'), c.req.query('chatSize'), await deployStatus(DEPLOY_PAGE_WAIT_MS)), flash: actionFlash(c) }));
  });

  app.get('/dashboard/sessions/:id', requireAdmin, async (c) => {
    const data = await loadSession(c.get('session'), c.req.param('id') ?? '', c.req.query('cursor'), await deployStatus(DEPLOY_PAGE_WAIT_MS));
    return data ? c.html(sessionPage({ ...data, flash: actionFlash(c) })) : c.html(errorPage('Session not found.'), 404);
  });

  // Cancel / retry a feature request. Same auth/CSRF model as the other forms (admin session cookie, SameSite=Lax, POST only).
  for (const action of ['cancel', 'retry'] as const) {
    app.post(`/dashboard/requests/:id/${action}`, requireAdmin, async (c) => {
      const admin = c.get('session').username;
      const id = Number(c.req.param('id'));
      const job = Number.isInteger(id) ? db.getBuildJob(id) : null;
      const back = c.req.query('back') === 'session' && job?.sessionId ? `/dashboard/sessions/${encodeURIComponent(job.sessionId)}` : '/dashboard/requests';
      const to = (q: string) => c.redirect(`${back}?${q}`);
      if (!job || job.guildId !== config.guildId) return to(`error=${encodeURIComponent('Request not found.')}`);
      if (!opts.builder) return to(`error=${encodeURIComponent('The builder is not available.')}`);
      try {
        const result = action === 'cancel' ? await opts.builder.cancelJob(id, admin) : await opts.builder.retryJob(id, admin);
        if (!result.ok) return to(`error=${encodeURIComponent(result.reason)}`);
      } catch (err) {
        console.error(`[web] guild=${config.guildId} job=${id} ${action} failed:`, err);
        return to(`error=${encodeURIComponent(`Could not ${action} the request.`)}`);
      }
      console.log(`[web] guild=${config.guildId} job=${id} ${action === 'cancel' ? 'cancelled' : 'retried'} by ${admin}`);
      return to(`done=${action === 'cancel' ? 'cancelled' : 'retried'}`);
    });
  }

  app.post('/builder-settings', requireAdmin, async (c) => {
    const form = await c.req.parseBody();
    const { settings, modelError } = parseBuilderForm(form, db.getBuilderSettings());
    db.setBuilderSettings(settings);
    console.log(`[web] AI assistant settings updated by ${c.get('session').username} (chat=${settings.chatEnabled} chatModel=${settings.chatModel} decisionModel=${settings.chatDecisionModel} chatLangs=${settings.chatLanguages.join(',') || 'any'} builds=${settings.enabled} model=${settings.model} limit=${settings.limitThreshold}%)`);
    return c.redirect(modelError ? `/dashboard/settings?builderError=${encodeURIComponent(`${modelError} — model not changed`)}#builder` : '/dashboard/settings?builderSaved=1#builder');
  });

  app.post('/free-settings', requireAdmin, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const next = parseFreeForm(form, config.guildId, new Set(listChannels().map((ch) => ch.id)), new Set(listRoles().map((r) => r.id)));
    db.saveFreeSettings(next);
    console.log(`[web] free games settings updated by ${c.get('session').username}`);
    return c.redirect('/dashboard/settings?freeSaved=1#free');
  });

  app.post('/color-settings', requireAdmin, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const channelId = typeof form.channel === 'string' && form.channel.length > 0 ? form.channel : null;
    const raw = form.colorRoles;
    const picked = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    const known = new Set(listRoles().map((r) => r.id));
    const roleIds = [...new Set(picked.filter((id) => known.has(id)))];
    const previous = db.getColorSettings(config.guildId).channelId;
    db.saveColorSettings({ guildId: config.guildId, channelId });

    // Roles removed from the selection lose their picker message.
    for (const dropped of db.saveColorSelection(config.guildId, roleIds)) {
      await deletePickerMessage(previous, dropped.messageId);
    }
    // A new channel moves every picker: forget the old message ids and delete the old posts.
    if (previous !== channelId) {
      for (const old of db.clearColorMessages(config.guildId)) {
        await deletePickerMessage(previous, old.messageId);
      }
    }

    const errors: string[] = [];
    let posted = 0;
    if (channelId) {
      const channel = await sendableChannel(channelId);
      const guild = client.guilds.cache.get(config.guildId);
      if (!channel || !guild) {
        errors.push('channel not found or not writable');
      } else {
        const rows = new Map(db.getColorRoles(config.guildId).map((r) => [r.roleId, r]));
        for (const role of sortColorRoles([...guild.roles.cache.values()].filter((r) => rows.has(r.id)))) {
          if (rows.get(role.id)?.messageId) continue;
          try {
            const message = await channel.send(buildColorMessage(role.id));
            await message.react(COLOR_MARKER).catch(() => undefined);
            db.setColorMessage(config.guildId, role.id, message.id);
            posted++;
          } catch (err) {
            errors.push(`${role.name}: ${err instanceof Error ? err.message : 'send failed'}`);
          }
        }
      }
    }

    console.log(`[web] name colours updated by ${c.get('session').username}: ${roleIds.length} roles, ${posted} new message(s), ${errors.length} error(s)`);
    if (errors.length > 0) {
      return c.redirect(`/dashboard/settings?colorError=${encodeURIComponent(errors.slice(0, 3).join('; '))}#colors`);
    }
    return c.redirect('/dashboard/settings?colorSaved=1#colors');
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
      monthlyEnabled: form.monthlyEnabled === '1',
      weeklyEnabled: form.weeklyEnabled === '1',
      weeklyDay: num(form.weeklyDay, current.weeklyDay, 0, 6),
      weeklyHour: num(form.weeklyHour, current.weeklyHour, 0, 23),
      timezone,
      embedChannels: Array.isArray(rawChannels) ? rawChannels.map(String) : rawChannels ? [String(rawChannels)] : [],
      levelingEnabled: form.levelingEnabled === '1',
      levelupChannelId: str(form.levelupChannel) || null,
      challengeChannelId: 'challengeChannel' in form ? str(form.challengeChannel) || null : current.challengeChannelId,
    };
    db.saveSettings(next);
    console.log(`[web] settings updated by ${c.get('session').username}`);
    return c.redirect('/dashboard/settings?saved=1');
  });

  // Manual test send. Deliberately does not touch the `weekly:<guild>` state key,
  // so it never suppresses the scheduled post. Same auth/CSRF model as /settings
  // (admin session cookie, SameSite=Lax).
  app.post('/weekly/send-now', requireAdmin, async (c) => {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      console.error(`[web] weekly stats send-now failed: guild ${config.guildId} not in cache`);
      return c.redirect(`/dashboard/settings?weekly=error&reason=${encodeURIComponent('guild not available')}`);
    }
    const result = await postWeeklyStats(guild, db, db.getSettings(config.guildId));
    if (!result.ok) {
      console.error(`[web] weekly stats send-now failed: ${result.reason} (guild ${config.guildId})`);
      return c.redirect(`/dashboard/settings?weekly=error&reason=${encodeURIComponent(result.reason.slice(0, 200))}`);
    }
    console.log(`[web] weekly stats sent manually by ${c.get('session').username} to channel ${result.channelId} (guild ${config.guildId})`);
    return c.redirect('/dashboard/settings?weekly=sent');
  });

  // Manual monthly recap (last month's). Like the weekly one, never touches the
  // `monthly:<guild>` state key, so the scheduled post is unaffected.
  app.post('/monthly/send-now', requireAdmin, async (c) => {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      console.error(`[web] monthly recap send-now failed: guild ${config.guildId} not in cache`);
      return c.redirect(`/dashboard/settings?monthly=error&reason=${encodeURIComponent('guild not available')}`);
    }
    const result = await postMonthlyRecap(guild, db, db.getSettings(config.guildId));
    if (!result.ok) {
      console.error(`[web] monthly recap send-now failed: ${result.reason} (guild ${config.guildId})`);
      return c.redirect(`/dashboard/settings?monthly=error&reason=${encodeURIComponent(result.reason.slice(0, 200))}`);
    }
    console.log(`[web] monthly recap sent manually by ${c.get('session').username} to channel ${result.channelId} (guild ${config.guildId})`);
    return c.redirect('/dashboard/settings?monthly=sent');
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

export function startWebServer(client: Client, db: BotDatabase, builder?: BuilderRunner): void {
  const app = createWebApp(client, db, { builder });
  serve({ fetch: app.fetch, port: config.dashboardPort, hostname: '0.0.0.0' }, (info) => {
    console.log(`[web] dashboard on http://localhost:${info.port} (register ${config.dashboardUrl}/auth/callback as the OAuth redirect)`);
    console.log(
      config.freestuffPublicKey
        ? `[web] FreeStuff webhook enabled at ${config.dashboardUrl}/webhooks/freestuff`
        : '[web] FreeStuff webhook disabled (set FREESTUFF_PUBLIC_KEY to enable)',
    );
  });
}
