// Offline smoke test: exercises the DB layer, stats math and provider
// detection without needing a Discord token. Run with: npm run smoke
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { MessageFlags } from 'discord.js';
import { renderDailyChart } from './chart.js';
import { buildWeeklyStatsMessage } from './weekly.js';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { BotDatabase } from './db.js';
import { buildActivityMessage, buildLeaderboardMessage } from './cards.js';
import { daySeries, currentWeekBounds, lastWeekBounds, leaderboardLines, startOfDay, weekKey, weekRangeLabel, zonedToUtcMs } from './stats.js';
import { cleanGiveawayTitle, filterGames, isBetaTitle, mergeFreeGames, normalizeEpic, normalizeGamerPower } from './freegames/sources.js';
import { buildFreeGameMessage, priceLine } from './freegames/cards.js';
import { ALL_STORES, type FreeSettings } from './freegames/types.js';
import { needsSeed, parseFreeForm } from './freegames/form.js';
import { leaderboard, youSection } from './web/views.js';
import { generateKeyPairSync, sign } from 'node:crypto';
import { announceInGuild, markGamesPosted, titleDedupeKey, isGamePosted } from './freegames/actions.js';
import { createReplayGuard, freeStuffTimestampValid, normalizeFreeStuffProduct, verifyFreeStuffSignature } from './freegames/freestuff.js';
import { detectProvider, extractUrl, extractUrlOutsideCode, transformUrl, isShortLink } from './embeds/providers.js';

const dir = mkdtempSync(join(tmpdir(), 'bojan-smoke-'));
const db = new BotDatabase(join(dir, 'test.db'));

const G = 'guild1';
const now = Date.now();
const H = 3_600_000;
const D = 24 * H;

// Fake messages: alice 10 this week, bob 5 this week, carol 3 last week, dave 1 long ago
db.recordMessage(G, 'c1', 'alice', now - 1 * H, 'a0');
for (let i = 0; i < 9; i++) db.recordMessage(G, 'c1', 'alice', now - (2 + i) * H, `a${i + 1}`);
for (let i = 0; i < 5; i++) db.recordMessage(G, 'c1', 'bob', now - (3 + i) * H, `b${i}`);
for (let i = 0; i < 3; i++) db.recordMessage(G, 'c1', 'carol', now - 8 * D - i * H, `c${i}`);
db.recordMessage(G, 'c1', 'dave', now - 40 * D, 'd0');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

check('total messages', db.countMessages(G) === 19, `got ${db.countMessages(G)}`);

// Dedup: re-recording the same message id must not double-count (backfill overlap)
db.recordMessage(G, 'c1', 'alice', now - 1 * H, 'a0');
check('dedup on message id', db.countMessages(G) === 19, `got ${db.countMessages(G)}`);
// Batch insert, half of them duplicates
const added = db.recordMessagesBatch([
  { guildId: G, channelId: 'c1', userId: 'erin', ts: now - 2 * H, messageId: 'e0' },
  { guildId: G, channelId: 'c1', userId: 'erin', ts: now - 3 * H, messageId: 'e1' },
  { guildId: G, channelId: 'c1', userId: 'alice', ts: now - 1 * H, messageId: 'a0' }, // duplicate
]);
check('batch insert dedup', added === 2 && db.countMessages(G) === 21, `added=${added} total=${db.countMessages(G)}`);

const week = lastWeekBounds('UTC');
const curWeek = currentWeekBounds('UTC');
check('last week total', db.countMessages(G, week.start, week.end) === 3, `got ${db.countMessages(G, week.start, week.end)}`);
check('current week total', db.countMessages(G, curWeek.start, curWeek.end) === 17, `got ${db.countMessages(G, curWeek.start, curWeek.end)}`);
check('week bounds are Mon..Mon', new Date(week.start).getUTCDay() === 1 && new Date(week.end).getUTCDay() === 1 && week.end - week.start === 7 * D);
const top = db.topUsers(G, 10);
check('leaderboard order', top[0]?.userId === 'alice' && top[0]?.messages === 10 && top[3]?.userId === 'erin' && top[4]?.userId === 'dave', JSON.stringify(top));
const ua = db.userStats(G, 'alice');
check('user stats', ua.messages === 10 && ua.firstTs !== null && ua.lastTs !== null);
check('leaderboard lines', leaderboardLines(top, 19)[0]?.includes('<@alice>') ?? false);

const s = db.getSettings(G);
check('default settings', s.weeklyEnabled && s.weeklyDay === 1 && s.weeklyHour === 9 && s.timezone === 'UTC' && s.embedChannels.length === 0);
db.saveSettings({ ...s, statsChannelId: 'chan9', weeklyDay: 5, weeklyHour: 18, timezone: 'Europe/Ljubljana', embedChannels: ['c1', 'c2'] });
const s2 = db.getSettings(G);
check('settings roundtrip', s2.statsChannelId === 'chan9' && s2.weeklyDay === 5 && s2.weeklyHour === 18 && s2.timezone === 'Europe/Ljubljana' && s2.embedChannels.join() === 'c1,c2');

db.logEmbed({ guildId: G, channelId: 'c1', messageId: 'm1', url: 'https://x.com/a/status/1', provider: 'x', ts: now });
check('embed log', db.recentEmbeds(G, 10).length === 1 && db.recentEmbeds(G, 10)[0]?.provider === 'x');
for (let i = 2; i <= 5; i++) db.logEmbed({ guildId: G, channelId: 'c1', messageId: `m${i}`, url: `https://x.com/a/status/${i}`, provider: 'x', ts: now + i });
check('embed count', db.countEmbeds(G) === 5 && db.countEmbeds('other-guild') === 0, `got ${db.countEmbeds(G)}`);
const embedPage = db.recentEmbeds(G, 2, 2);
check('embed offset', embedPage.length === 2 && embedPage[0]?.messageId === 'm3' && embedPage[1]?.messageId === 'm2' && db.recentEmbeds(G, 2, 4)[0]?.messageId === 'm1', JSON.stringify(embedPage.map((e) => e.messageId)));

// Reactions: alice's message gets 👍 x2 (bob, carol) and a custom emoji (dave); bob reacts to carol's message
db.recordReaction({ guildId: G, channelId: 'c1', messageId: 'a0', authorId: 'alice', reactorId: 'bob', emojiKey: '👍', emojiLabel: '👍', ts: now - 1 * H });
db.recordReaction({ guildId: G, channelId: 'c1', messageId: 'a0', authorId: 'alice', reactorId: 'carol', emojiKey: '👍', emojiLabel: '👍', ts: now - 2 * H });
db.recordReaction({ guildId: G, channelId: 'c1', messageId: 'a1', authorId: 'alice', reactorId: 'dave', emojiKey: '1234', emojiLabel: '<:party:1234>', ts: now - 3 * H });
db.recordReaction({ guildId: G, channelId: 'c1', messageId: 'c0', authorId: 'carol', reactorId: 'bob', emojiKey: '👍', emojiLabel: '👍', ts: now - 4 * H });
db.recordReaction({ guildId: G, channelId: 'c1', messageId: 'a0', authorId: 'alice', reactorId: 'bob', emojiKey: '👍', emojiLabel: '👍', ts: now }); // duplicate add
check('reaction dedup', db.countReactions(G) === 4, `got ${db.countReactions(G)}`);
const rs = db.reactionStats(G, 'alice');
check('reactions received', rs.received === 3, `got ${rs.received}`);
check('reactions given', db.reactionStats(G, 'bob').given === 2);
const aliceEmoji = db.topEmojiForUser(G, 'alice', 5);
check('top emoji per user', aliceEmoji.length === 0, 'alice gave none'); // alice received, gave none
const bobEmoji = db.topEmojiForUser(G, 'bob', 5);
check('top emoji for bob', bobEmoji[0]?.emojiKey === '👍' && bobEmoji[0]?.count === 2, JSON.stringify(bobEmoji));
const allEmoji = db.topEmojiAll(G, 5);
check('top emoji all', allEmoji[0]?.emojiKey === '👍' && allEmoji[0]?.count === 3 && allEmoji[1]?.emojiLabel === '<:party:1234>', JSON.stringify(allEmoji));
const rxAdded = db.recordReactionsBatch([
  { guildId: G, channelId: 'c1', messageId: 'a2', authorId: 'alice', reactorId: 'erin', emojiKey: '🔥', emojiLabel: '🔥', ts: now - 5 * H },
  { guildId: G, channelId: 'c1', messageId: 'a0', authorId: 'alice', reactorId: 'bob', emojiKey: '👍', emojiLabel: '👍', ts: now - 1 * H }, // duplicate of live-recorded
]);
check('reaction batch dedup', rxAdded === 1 && db.countReactions(G) === 5, `added=${rxAdded} total=${db.countReactions(G)}`);

// Weekly recap data: last week's messages spread over 7 days across two channels,
// plus last-week reactions with known givers/receivers
const lwk = lastWeekBounds('UTC');
for (let i = 0; i < 7; i++) {
  for (let j = 0; j <= i; j++) db.recordMessage(G, i % 2 === 0 ? 'c1' : 'c2', 'alice', lwk.start + i * D + j * H, `w${i}-${j}`);
}
db.recordReaction({ guildId: G, channelId: 'c1', messageId: 'w0-0', authorId: 'alice', reactorId: 'bob', emojiKey: '👍', emojiLabel: '👍', ts: lwk.start + 1 * H });
db.recordReaction({ guildId: G, channelId: 'c1', messageId: 'w1-0', authorId: 'carol', reactorId: 'bob', emojiKey: '🔥', emojiLabel: '🔥', ts: lwk.start + 2 * H });
db.recordReaction({ guildId: G, channelId: 'c2', messageId: 'w2-0', authorId: 'carol', reactorId: 'erin', emojiKey: '👍', emojiLabel: '👍', ts: lwk.start + 3 * H });

const chans = db.topChannels(G, lwk.start, lwk.end, 5);
check('top channels last week', chans[0]?.channelId === 'c1' && chans[0]?.count === 19 && chans[1]?.channelId === 'c2' && chans[1]?.count === 12, JSON.stringify(chans));
const given = db.topReactionsGiven(G, 3, lwk.start, lwk.end);
check('top reactions given (week)', given[0]?.userId === 'bob' && given[0]?.count === 2 && given[1]?.userId === 'erin', JSON.stringify(given));
const received = db.topReactionsReceived(G, 3, lwk.start, lwk.end);
check('top reactions received (week)', received[0]?.userId === 'carol' && received[0]?.count === 2, JSON.stringify(received));
const givenAll = db.topReactionsGiven(G, 10);
check('top reactions given (all time)', givenAll[0]?.userId === 'bob' && givenAll[0]?.count === 4 && givenAll[1]?.userId === 'erin' && givenAll[1]?.count === 2, JSON.stringify(givenAll));
const receivedAll = db.topReactionsReceived(G, 10);
check('top reactions received (all time)', receivedAll[0]?.userId === 'alice' && receivedAll[0]?.count === 5 && receivedAll[1]?.userId === 'carol' && receivedAll[1]?.count === 3, JSON.stringify(receivedAll));
const emojiOnAlice = db.topEmojiReceived(G, 'alice', 5);
check('emoji most used on alice\'s messages', emojiOnAlice[0]?.emojiKey === '👍' && emojiOnAlice[0]?.count === 3 && emojiOnAlice.length === 3, JSON.stringify(emojiOnAlice));
check('reaction count in range', db.countReactions(G, lwk.start, lwk.end) === 3, `got ${db.countReactions(G, lwk.start, lwk.end)}`);
const perDay = db.messageCountsPerDay(G, lwk.start, lwk.end, 'UTC');
check('per-day counts', perDay.length === 7 && perDay.reduce((s, d) => s + d.count, 0) === 31 && perDay[1]?.count === 5, JSON.stringify(perDay));

// Weekly message (Components V2) + PNG chart
const sampleDays = [0, 763, 1171, 639, 755, 164, 98].map((count, i) => ({ label: `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]} ${16 + i}`, count }));
const png = renderDailyChart(sampleDays);
writeFileSync('/tmp/bojan-weekly-chart.png', png);
check('chart is PNG', png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${png.length} bytes`);
check('chart handles all-zero data', renderDailyChart(sampleDays.map((d) => ({ ...d, count: 0 }))).length > 0);
const weekly = buildWeeklyStatsMessage({
  week: lwk, timeZone: 'UTC', weekTotal: 31, weekReactions: 3, activeMembers: 4, total: 21,
  topMessagers: db.topUsers(G, 5, lwk.start, lwk.end), topChannels: chans, topGiven: given, topReceived: received, perDay,
  guildIconUrl: 'https://example.com/icon.png',
});
const weeklyJson = JSON.stringify(weekly.components.map((c) => c.toJSON()));
writeFileSync('/tmp/bojan-weekly-payload.json', JSON.stringify(weekly.components.map((c) => c.toJSON()), null, 2));
check('weekly is Components V2', (weekly.flags & MessageFlags.IsComponentsV2) !== 0 && !('content' in weekly));
check('weekly has one container with chart gallery', weekly.components.length === 1 && weeklyJson.includes('attachment://weekly-chart.png') && weeklyJson.includes('"type":17'));
check('weekly does not ping', weekly.allowedMentions.parse.length === 0 && weekly.files[0]?.name === 'weekly-chart.png');
const weeklyEmpty = buildWeeklyStatsMessage({
  week: lwk, timeZone: 'UTC', weekTotal: 0, weekReactions: 0, activeMembers: 0, total: 0,
  topMessagers: [], topChannels: [], topGiven: [], topReceived: [], perDay: [],
});
check('weekly empty data', JSON.stringify(weeklyEmpty.components[0]?.toJSON()).includes('—'));

// Leaderboard + activity cards (Components V2)
function textLength(json: unknown): number {
  let n = 0;
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (o.type === 10 && typeof o.content === 'string') n += o.content.length;
      Object.values(o).forEach(walk);
    }
  };
  walk(json);
  return n;
}
const lb = buildLeaderboardMessage({
  totalMessages: 21, totalReactions: 5, topUsers: db.topUsers(G, 10), topGiven: givenAll, topReceived: receivedAll,
  guildIconUrl: 'https://example.com/icon.png',
});
const lbJson = lb.components.map((c) => c.toJSON());
check('leaderboard is V2 with one container, no pings', (lb.flags & MessageFlags.IsComponentsV2) !== 0 && lb.components.length === 1 && lbJson[0]?.type === 17 && lb.allowedMentions.parse.length === 0 && !('embeds' in lb));
const bigUsers = Array.from({ length: 50 }, (_, i) => ({ userId: `${'1'.repeat(18)}${i}`, messages: 100000 - i, firstTs: 0, lastTs: 0 })) as unknown as ReturnType<typeof db.topUsers>;
const bigReactions = Array.from({ length: 50 }, (_, i) => ({ userId: `${'2'.repeat(18)}${i}`, count: 90000 - i }));
const lbBig = buildLeaderboardMessage({ limit: 50, totalMessages: 9_999_999, totalReactions: 999_999, topUsers: bigUsers, topGiven: bigReactions, topReceived: bigReactions });
const lbBigLen = textLength(lbBig.components.map((c) => c.toJSON()));
check('leaderboard with 50 rows stays under 4000 chars', lbBigLen < 4000 && lbBigLen > 500, `${lbBigLen} chars`);

const actNow = Date.now();
const actDayStart = actNow - 6 * D;
const actDays = daySeries({ start: actDayStart, end: actNow, key: '' }, 'UTC');
const act = buildActivityMessage({
  name: 'League of Legends', username: 'alice', avatarUrl: 'https://example.com/a.png', timeZone: 'UTC',
  summary: { name: 'League of Legends', sessions: 42, totalMs: 723 * 60_000, avgMs: 17 * 60_000, firstAt: actNow - 30 * D, lastAt: actNow - H },
  breakdown: [{ label: 'Ranked', sessions: 10, totalMs: 300 * 60_000 }],
  recent: [{ startedAt: actNow - 2 * H, endedAt: actNow - H, durationMs: H, details: 'Ranked Solo', state: null, open: 0 }],
  minutes: actDays.map((d, i) => ({ day: d.key, count: [0, 45, 120, 30, 90, 15, 60][i] ?? 0 })),
  dayStart: actDayStart, now: actNow,
});
const actJson = JSON.stringify(act.components.map((c) => c.toJSON()));
const actFile = act.files[0];
writeFileSync('/tmp/bojan-activity-chart.png', (actFile as unknown as { attachment: Buffer }).attachment);
check('activity is V2 with one container, no pings', (act.flags & MessageFlags.IsComponentsV2) !== 0 && act.components.length === 1 && actJson.includes('"type":17') && act.allowedMentions.parse.length === 0);
check('activity references its chart attachment', actJson.includes('attachment://activity-chart.png') && actFile?.name === 'activity-chart.png');
const actEmpty = buildActivityMessage({
  name: 'x', username: 'u', timeZone: 'UTC', summary: { name: 'x', sessions: 1, totalMs: 0, avgMs: 0, firstAt: null, lastAt: null },
  breakdown: [], recent: [], minutes: [], dayStart: actDayStart, now: actNow,
});
const actEmptyJson = JSON.stringify(actEmpty.components.map((c) => c.toJSON()));
check('activity omits empty sections', !actEmptyJson.includes('Breakdown') && !actEmptyJson.includes('Recent sessions'));
const actBig = buildActivityMessage({
  name: 'x', username: 'u', timeZone: 'UTC', summary: { name: 'x', sessions: 1, totalMs: 0, avgMs: 0, firstAt: null, lastAt: null },
  breakdown: Array.from({ length: 50 }, (_, i) => ({ label: `L${i} ${'y'.repeat(100)}`, sessions: 1, totalMs: 1000 })),
  recent: Array.from({ length: 50 }, (_, i) => ({ startedAt: actNow - i * H, endedAt: null, durationMs: H, details: 'd'.repeat(200), state: null, open: 0 })),
  minutes: [], dayStart: actDayStart, now: actNow,
});
const actBigLen = textLength(actBig.components.map((c) => c.toJSON()));
check('activity with huge sections stays under 4000 chars', actBigLen < 4000, `${actBigLen} chars`);

db.setState('k', 'v');
check('bot state', db.getState('k') === 'v');

// timezone math: 2026-11-18 is a Wednesday; week key should be Monday 2026-11-16
const wk = weekKey('Europe/Ljubljana', new Date('2026-11-18T12:00:00Z'));
check('weekKey Ljubljana', wk === '2026-11-16', wk);
const lw = lastWeekBounds('Europe/Ljubljana', new Date('2026-11-18T12:00:00Z'));
check('lastWeek label', weekRangeLabel(lw, 'Europe/Ljubljana') === '9 Nov – 15 Nov 2026', weekRangeLabel(lw, 'Europe/Ljubljana'));
// Ljubljana is UTC+1 in November: Monday 2026-11-09 00:00 local == 2026-11-08 23:00 UTC
check('zonedToUtcMs', new Date(zonedToUtcMs('Europe/Ljubljana', 2026, 11, 9)).toISOString() === '2026-11-08T23:00:00.000Z', new Date(zonedToUtcMs('Europe/Ljubljana', 2026, 11, 9)).toISOString());
// summer: UTC+2
const summer = zonedToUtcMs('Europe/Ljubljana', 2026, 7, 1);
check('zonedToUtcMs DST', new Date(summer).toISOString() === '2026-06-30T22:00:00.000Z', new Date(summer).toISOString());
check('currentWeekBounds', currentWeekBounds('UTC', new Date('2026-11-18T12:00:00Z')).key === '2026-11-16');
const sod = new Date(startOfDay('Europe/Ljubljana', new Date('2026-11-23T10:30:00Z'))).toISOString();
check('startOfDay Ljubljana', sod === '2026-11-22T23:00:00.000Z', sod);

// countMessages with a lone bound (deterministic: own guild, fixed timestamps)
const GB = 'guild-bounds';
db.recordMessage(GB, 'c1', 'u', 1000, 'x0');
db.recordMessage(GB, 'c1', 'u', 2000, 'x1');
db.recordMessage(GB, 'c1', 'u', 3000, 'x2');
check('countMessages lone fromTs', db.countMessages(GB, 2000) === 2, `got ${db.countMessages(GB, 2000)}`);
check('countMessages lone toTs', db.countMessages(GB, undefined, 2000) === 1, `got ${db.countMessages(GB, undefined, 2000)}`);
check('countMessages both bounds', db.countMessages(GB, 1000, 3000) === 2, `got ${db.countMessages(GB, 1000, 3000)}`);
check('countMessages no bounds', db.countMessages(GB) === 3, `got ${db.countMessages(GB)}`);

check('extractUrl', extractUrl('check this https://x.com/foo/status/123 out') === 'https://x.com/foo/status/123');
check('extractUrl strips punctuation', extractUrl('look https://youtu.be/abc123.') === 'https://youtu.be/abc123');
check('url in inline code ignored', extractUrlOutsideCode('see `https://x.com/foo/status/123` lol') === null);
check('url in code block ignored', extractUrlOutsideCode('```\nhttps://x.com/foo/status/123\n```') === null);
check('url outside code found', extractUrlOutsideCode('ahoj https://x.com/foo/status/123 `code`') === 'https://x.com/foo/status/123');
check('bare url found', extractUrlOutsideCode('https://x.com/foo/status/123') === 'https://x.com/foo/status/123');
check('code url plus real url', extractUrlOutsideCode('`https://x.com/a/status/1` and https://vm.tiktok.com/ZN8aa1dqy/') === 'https://vm.tiktok.com/ZN8aa1dqy/');
check('detect x', detectProvider('https://x.com/foo/status/123')?.name === 'x');
check('detect twitter', detectProvider('https://twitter.com/foo/status/123')?.name === 'x');
check('detect mobile.twitter', detectProvider('https://mobile.twitter.com/foo/status/123')?.name === 'x');
check('detect tiktok', detectProvider('https://www.tiktok.com/@foo/video/7312345678901234567')?.name === 'tiktok');
check('detect tiktok share link (vm.)', detectProvider('https://vm.tiktok.com/ZN8aa1dqy/')?.name === 'tiktok');
check('detect instagram', detectProvider('https://www.instagram.com/reel/ABC123/')?.name === 'instagram');
check('detect instagr.am', detectProvider('https://instagr.am/p/ABC123/')?.name === 'instagram');
check('detect reddit', detectProvider('https://www.reddit.com/r/test/comments/abc123/title/')?.name === 'reddit');
check('short link flags', isShortLink('https://vm.tiktok.com/ZN8aa1dqy/') && isShortLink('https://t.co/abc123') && !isShortLink('https://www.tiktok.com/@foo/video/123') && !isShortLink('https://x.com/a/status/1'));
check('ignore youtube (native embed)', detectProvider('https://youtu.be/dQw4w9WgXcQ') === null);
check('ignore spotify (native embed)', detectProvider('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC') === null);
check('ignore plain link', detectProvider('https://example.com/article') === null);

// embeddo-style mirror rewrites (path and query preserved)
check('transform x', transformUrl('https://x.com/GameJoker_/status/2122004700644200505?a=wGngWqYCkNzMmNE29c&s=20') === 'https://fxtwitter.com/GameJoker_/status/2122004700644200505?a=wGngWqYCkNzMmNE29c&s=20');
check('transform twitter', transformUrl('https://twitter.com/foo/status/123') === 'https://fxtwitter.com/foo/status/123');
check('transform instagram (www dropped, like embeddo)', transformUrl('https://www.instagram.com/reel/ABC123/') === 'https://kkinstagram.com/reel/ABC123/');
check('transform tiktok (www dropped)', transformUrl('https://www.tiktok.com/@foo/video/7312345678901234567') === 'https://kktiktok.com/@foo/video/7312345678901234567');
check('transform tiktok share link', transformUrl('https://vm.tiktok.com/ZN8aa1dqy/') === 'https://kktiktok.com/ZN8aa1dqy/');
check('transform reddit (www dropped)', transformUrl('https://www.reddit.com/r/test/comments/abc123/title/') === 'https://vxreddit.com/r/test/comments/abc123/title/');
check('no transform for plain link', transformUrl('https://example.com/a') === null);

db.close();
rmSync(dir, { recursive: true, force: true });
// ---- activity session overlap fixes ----
{
  const dir2 = mkdtempSync(join(tmpdir(), 'bojan-smoke-act-'));
  const db = new BotDatabase(join(dir2, 'test.db'));
  const MIN = 60_000;
  const T0 = Date.UTC(2026, 0, 10, 12, 0);
  const act = (details: string): { name: string; type: number; details: string | null; state: string | null; applicationId: string | null; startedAt: number | null } =>
    ({ name: 'OverlapGame', type: 0, details, state: null, applicationId: 'app1', startedAt: T0 });
  db.recordPresence(G, 'ovl', [act('m0')], T0);
  db.recordPresence(G, 'ovl', [act('m1')], T0 + 10 * MIN);
  db.recordPresence(G, 'ovl', [act('m2')], T0 + 20 * MIN);
  db.recordPresence(G, 'ovl', [act('m3')], T0 + 30 * MIN);
  db.recordPresence(G, 'ovl', [], T0 + 40 * MIN);
  const sum = db.activitySummary(G, 'ovl', 'OverlapGame', T0 + 50 * MIN);
  check('split sessions do not overlap', sum?.totalMs === 40 * MIN && sum.sessions === 4, `totalMs=${sum?.totalMs} sessions=${sum?.sessions}`);

  // Hand-inserted overlapping rows (legacy data), repaired idempotently
  const raw = new DatabaseSync(join(dir2, 'test.db'));
  const ins = raw.prepare('INSERT INTO activity_sessions (guild_id, user_id, name, type, details, state, application_id, started_at, ended_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run(G, 'rep', 'Legacy', 0, 'a', null, null, T0, T0 + 10 * MIN, T0 + 10 * MIN);
  ins.run(G, 'rep', 'Legacy', 0, 'b', null, null, T0, T0 + 20 * MIN, T0 + 20 * MIN);
  ins.run(G, 'rep', 'Legacy', 0, 'c', null, null, T0, T0 + 30 * MIN, T0 + 30 * MIN);
  raw.close();
  const before = db.activitySummary(G, 'rep', 'Legacy', T0 + H)?.totalMs ?? 0;
  const fixed1 = db.repairActivityOverlaps();
  const after = db.activitySummary(G, 'rep', 'Legacy', T0 + H)?.totalMs ?? 0;
  const fixed2 = db.repairActivityOverlaps();
  check('repair fixes overlaps', before === 60 * MIN && after === 30 * MIN && fixed1 === 2, `before=${before / MIN}m after=${after / MIN}m fixed=${fixed1}`);
  check('repair is idempotent', fixed2 === 0, `second run changed ${fixed2}`);

  // Per-day split across local midnight
  const tz = 'UTC';
  const mid = Date.UTC(2026, 0, 20);
  db.recordPresence(G, 'day', [{ name: 'Night', type: 0, details: null, state: null, applicationId: null, startedAt: mid - 2 * H }], mid - 2 * H);
  db.recordPresence(G, 'day', [], mid + 3 * H);
  const days = db.activityMinutesPerDay(G, 'day', 'Night', mid - 2 * D, mid + 2 * D, tz);
  check('session spanning midnight splits', days.length === 2 && days[0]?.count === 120 && days[1]?.count === 180, JSON.stringify(days));
  const longStart = Date.UTC(2026, 1, 1, 0);
  db.recordPresence(G, 'day', [{ name: 'Long', type: 0, details: null, state: null, applicationId: null, startedAt: longStart }], longStart);
  db.recordPresence(G, 'day', [], longStart + 30 * H);
  const longDays = db.activityMinutesPerDay(G, 'day', 'Long', longStart - D, longStart + 3 * D, tz);
  check('30h session never exceeds 1440 min/day', longDays.length === 2 && longDays[0]?.count === 1440 && longDays[1]?.count === 360 && longDays.every((d) => d.count <= 1440) && longDays.reduce((s, d) => s + d.count, 0) === 1800, JSON.stringify(longDays));
  db.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ---- free games (offline fixtures) ----------------------------------------
{
  const NOW = Date.UTC(2026, 10, 23, 12);
  const iso = (ms: number): string => new Date(ms).toISOString();
  const epicJson = {
    data: { Catalog: { searchStore: { elements: [
      {
        id: 'e1', title: 'Free Epic Game', description: 'Desc', keyImages: [{ type: 'Thumbnail', url: 'https://img/t.jpg' }, { type: 'OfferImageWide', url: 'https://img/w.jpg' }],
        price: { totalPrice: { fmtPrice: { originalPrice: '$19.99' } } },
        offerMappings: [{ pageSlug: 'free-epic-game' }], catalogNs: { mappings: [] }, productSlug: null,
        promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: iso(NOW - H), endDate: iso(NOW + D), discountSetting: { discountPercentage: 0 } }] }], upcomingPromotionalOffers: [] },
      },
      {
        id: 'e2', title: 'Next Week Game', description: null, keyImages: [], price: null, offerMappings: null, catalogNs: { mappings: [{ pageSlug: '[]' }] }, productSlug: 'next-week',
        promotions: { promotionalOffers: [], upcomingPromotionalOffers: [{ promotionalOffers: [{ startDate: iso(NOW + 2 * D), endDate: iso(NOW + 9 * D), discountSetting: { discountPercentage: 0 } }] }] },
      },
      { id: 'e3', title: 'Discounted 50%', promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: iso(NOW - H), endDate: iso(NOW + D), discountSetting: { discountPercentage: 50 } }] }], upcomingPromotionalOffers: [] } },
      { id: 'e4', title: 'Mystery', promotions: null, keyImages: null },
      null,
    ] } } },
  };
  const epic = normalizeEpic(epicJson, NOW);
  check('epic: one current free game', epic.current.length === 1 && epic.current[0]?.key === 'epic:e1', JSON.stringify(epic.current.map((g) => g.key)));
  check('epic: url, image, worth', epic.current[0]?.url === 'https://store.epicgames.com/p/free-epic-game' && epic.current[0]?.imageUrl === 'https://img/w.jpg' && epic.current[0]?.worth === '$19.99');
  check('epic: upcoming with junk slug falls back to productSlug', epic.upcoming.length === 1 && epic.upcoming[0]?.url === 'https://store.epicgames.com/p/next-week' && epic.upcoming[0]?.worth === null);
  check('epic: handles garbage input', normalizeEpic(null).current.length === 0 && normalizeEpic({ data: null }).upcoming.length === 0);

  const gpJson = [
    { id: 1, title: 'Cool Game (Steam) Giveaway', worth: '$4.99', image: 'https://img/1.jpg', description: 'x', open_giveaway_url: 'https://gp/1', published_date: '2026-11-20 10:00:00', type: 'Game', platforms: 'PC, Steam', end_date: '2026-11-30 23:59:00', status: 'Active' },
    { id: 2, title: 'Epic Dup Giveaway', worth: 'N/A', image: '', description: '', open_giveaway_url: 'https://gp/2', published_date: '2026-11-20 10:00:00', type: 'Game', platforms: 'PC, Epic Games Store', end_date: 'N/A', status: 'Active' },
    { id: 3, title: 'Shiny DLC Giveaway', worth: '$9.99', image: '', description: '', open_giveaway_url: 'https://gp/3', published_date: '2026-11-20 10:00:00', type: 'DLC', platforms: 'PC, GOG', end_date: 'N/A', status: 'Active' },
    { id: 4, title: 'Phone Game Giveaway', worth: '$1.99', image: '', description: '', open_giveaway_url: 'https://gp/4', published_date: '2026-11-20 10:00:00', type: 'Game', platforms: 'Android', end_date: 'N/A', status: 'Active' },
    { id: 5, title: 'Console Game Giveaway', worth: 'N/A', image: '', description: '', open_giveaway_url: 'https://gp/5', published_date: '2026-11-20 10:00:00', type: 'Game', platforms: 'PS5, Xbox One', end_date: 'N/A', status: 'Active' },
    { id: 6, title: 'Early Thing Giveaway', worth: 'N/A', image: '', description: '', open_giveaway_url: 'https://gp/6', published_date: '2026-11-20 10:00:00', type: 'Early Access', platforms: 'PC, Itch.io', end_date: 'N/A', status: 'Active' },
    { id: 7, title: 'Expired Giveaway', worth: 'N/A', image: '', description: '', open_giveaway_url: 'https://gp/7', published_date: '2026-10-01 10:00:00', type: 'Game', platforms: 'PC, Steam', end_date: '2026-11-01 00:00:00', status: 'Active' },
    { id: 8, title: 'Done Giveaway', worth: 'N/A', image: '', description: '', open_giveaway_url: 'https://gp/8', published_date: '2026-10-01 10:00:00', type: 'Game', platforms: 'PC, Steam', end_date: 'N/A', status: 'Expired' },
  ];
  const gp = normalizeGamerPower(gpJson, NOW);
  const byKey = new Map(gp.map((g) => [g.key, g]));
  check('gamerpower: expired/inactive dropped', gp.length === 6 && !byKey.has('gp:7') && !byKey.has('gp:8'), `got ${gp.length}`);
  check('gamerpower: title suffix stripped', byKey.get('gp:1')?.title === 'Cool Game' && cleanGiveawayTitle('Foo Giveaway') === 'Foo');
  check('gamerpower: store/kind/platform classification',
    byKey.get('gp:1')?.store === 'steam' && byKey.get('gp:2')?.store === 'epic' && byKey.get('gp:3')?.kind === 'dlc' && byKey.get('gp:3')?.store === 'gog' &&
    byKey.get('gp:4')?.platform === 'mobile' && byKey.get('gp:5')?.platform === 'console' && byKey.get('gp:6')?.kind === 'game' && byKey.get('gp:6')?.store === 'itch');
  check('gamerpower: worth/endsAt parsing', byKey.get('gp:1')?.worth === '$4.99' && byKey.get('gp:2')?.worth === null && byKey.get('gp:1')?.endsAt === Date.UTC(2026, 10, 30, 23, 59) && byKey.get('gp:2')?.endsAt === null);
  check('gamerpower: non-array (empty 201 object) → []', normalizeGamerPower({ status: 0, status_message: 'No active giveaways' }, NOW).length === 0);

  const merged = mergeFreeGames(epic.current, gp);
  check('merge: epic authoritative drops GP epic PC game', !merged.some((g) => g.key === 'gp:2') && merged.some((g) => g.key === 'epic:e1'));
  check('merge: epic down keeps GP epic game', mergeFreeGames(null, gp).some((g) => g.key === 'gp:2'));
  const dupGp = normalizeGamerPower([{ ...gpJson[0], id: 99, title: 'cool game giveaway' }], NOW);
  check('merge: dedupe by title+store', mergeFreeGames(null, [...gp, ...dupGp]).filter((g) => g.title.toLowerCase() === 'cool game').length === 1);

  const defaults: FreeSettings = { guildId: G, channelId: null, pingRoleId: null, stores: [...ALL_STORES], includeDlc: false, includeBeta: false, includeMobile: false, includeConsole: false };
  const keys = (f: FreeSettings): string => filterGames(merged, f).map((g) => g.key).sort().join(',');
  check('filter: defaults = PC full games only', keys(defaults) === 'epic:e1,gp:1,gp:6', keys(defaults));
  check('filter: includeDlc', keys({ ...defaults, includeDlc: true }) === 'epic:e1,gp:1,gp:3,gp:6');
  check('filter: mobile + console', keys({ ...defaults, includeMobile: true, includeConsole: true }) === 'epic:e1,gp:1,gp:4,gp:5,gp:6');
  check('filter: store disabled', keys({ ...defaults, stores: ['epic'] }) === 'epic:e1', keys({ ...defaults, stores: ['epic'] }));

  const cool = byKey.get('gp:1')!;
  check('price line', priceLine(cool).startsWith('~~$4.99~~ **FREE** until <t:') && priceLine({ ...cool, worth: null, endsAt: null }) === '**FREE**');
  const card = buildFreeGameMessage(cool, { pingRoleId: '123' });
  const cardJson = JSON.stringify(card.components.map((c) => c.toJSON()));
  check('announcement card: V2 flag, role ping, attribution, link button',
    card.flags === MessageFlags.IsComponentsV2 && cardJson.includes('<@&123>') && cardJson.includes('via GamerPower') && cardJson.includes('Open on Steam') && JSON.stringify(card.allowedMentions) === '{"roles":["123"]}');
  const plain = buildFreeGameMessage(epic.current[0]!);
  check('announcement card: no ping → no mentions, no attribution', !JSON.stringify(plain.components.map((c) => c.toJSON())).includes('GamerPower') && JSON.stringify(plain.allowedMentions) === '{"parse":[]}');

  const fdir = mkdtempSync(join(tmpdir(), 'bojan-free-'));
  const fdb = new BotDatabase(join(fdir, 'free.db'));
  const fs0 = fdb.getFreeSettings(G);
  check('free settings defaults', fs0.channelId === null && fs0.stores.length === ALL_STORES.length && !fs0.includeDlc && !fs0.includeBeta && !fs0.includeMobile && !fs0.includeConsole);
  fdb.saveFreeSettings({ ...fs0, channelId: 'ch1', pingRoleId: 'r1', stores: ['epic', 'steam'], includeDlc: true, includeBeta: true });
  const fs1 = fdb.getFreeSettings(G);
  check('free settings round-trip', fs1.channelId === 'ch1' && fs1.pingRoleId === 'r1' && fs1.stores.join() === 'epic,steam' && fs1.includeDlc && fs1.includeBeta && !fs1.includeMobile);
  fdb.saveFreeSettings({ ...fs1, channelId: null, pingRoleId: null });
  check('free settings update/clear', fdb.getFreeSettings(G).channelId === null && fdb.getFreeSettings(G).pingRoleId === null);
  check('free_posted: mark + dedupe', fdb.markFreePosted(G, ['epic:e1', 'gp:1']) === 2 && fdb.markFreePosted(G, ['epic:e1', 'gp:3']) === 1 && fdb.isFreePosted(G, 'gp:3') && !fdb.isFreePosted(G, 'gp:9') && !fdb.isFreePosted('other', 'gp:3') && fdb.countFreePosted(G) === 3);
  fdb.close();

  // beta classification
  const gpBeta = (id: number, title: string, type = 'Game') => ({ id, title, worth: 'N/A', image: '', description: '', open_giveaway_url: `https://gp/${id}`, published_date: '2026-11-20 10:00:00', type, platforms: 'PC, Steam', end_date: 'N/A', status: 'Active' });
  const betaGp = normalizeGamerPower([
    gpBeta(101, 'Scallywags Playtest Steam Key'),
    gpBeta(102, 'Chop Shop Playtest (Steam) Key'),
    gpBeta(103, 'Zero King (Beta) Steam Key'),
    gpBeta(104, 'DungeonLoot: Open Beta Has Arrived!'),
    gpBeta(105, 'Cozy Farm Giveaway', 'Early Access'),
    gpBeta(106, 'Betrayal at Club Low Giveaway'),
    gpBeta(107, 'Alphabet Adventure Key'),
    gpBeta(108, 'Fathom Reach Playtest Steam Key Giveaway', 'Early Access'),
    gpBeta(109, 'Odd Bundle Beta', 'Other'),
  ], NOW);
  const bk = new Map(betaGp.map((g) => [g.key, g]));
  check('beta: playtest/beta titles classified beta', ['gp:101', 'gp:102', 'gp:103', 'gp:104'].every((k) => bk.get(k)?.kind === 'beta'), betaGp.map((g) => `${g.key}=${g.kind}`).join(' '));
  check('beta: Early Access normal title → game, Early Access playtest → beta, Other → dlc', bk.get('gp:105')?.kind === 'game' && bk.get('gp:108')?.kind === 'beta' && bk.get('gp:109')?.kind === 'dlc');
  check('beta: word boundary false positives stay game', bk.get('gp:106')?.kind === 'game' && bk.get('gp:107')?.kind === 'game' && !isBetaTitle('Betrayal at Club Low') && isBetaTitle('Foo DEMO') && isBetaTitle('Bar Test Key') && isBetaTitle('Baz Closed Beta'));
  check('beta: key suffix stripped from titles', bk.get('gp:101')?.title === 'Scallywags Playtest' && bk.get('gp:102')?.title === 'Chop Shop Playtest' && bk.get('gp:103')?.title === 'Zero King (Beta)' && cleanGiveawayTitle('Foo (Steam) Giveaway') === 'Foo' && cleanGiveawayTitle('Keyboard Hero') === 'Keyboard Hero');
  const betaKeys = (f: FreeSettings): string => filterGames(betaGp, f).map((g) => g.key).join(',');
  check('beta: excluded by default', betaKeys(defaults) === 'gp:105,gp:106,gp:107', betaKeys(defaults));
  check('beta: includeBeta admits them (platform rules still apply)', betaKeys({ ...defaults, includeBeta: true }).split(',').length === 8 && betaKeys({ ...defaults, includeBeta: true, stores: ['epic'] }) === '');
  check('beta: label on card', JSON.stringify(buildFreeGameMessage(bk.get('gp:101')!).components.map((c) => c.toJSON())).includes('Beta / playtest'));

  // migration: free_settings created before include_beta existed
  const mdir = mkdtempSync(join(tmpdir(), 'bojan-freemig-'));
  const mpath = join(mdir, 'old.db');
  const raw = new DatabaseSync(mpath);
  raw.exec(`CREATE TABLE free_settings (guild_id TEXT PRIMARY KEY, channel_id TEXT, ping_role_id TEXT, stores TEXT NOT NULL, include_dlc INTEGER NOT NULL DEFAULT 0, include_mobile INTEGER NOT NULL DEFAULT 0, include_console INTEGER NOT NULL DEFAULT 0)`);
  raw.exec(`INSERT INTO free_settings (guild_id, channel_id, stores, include_dlc) VALUES ('${G}', 'chOld', '["steam"]', 1)`);
  raw.close();
  const mdb = new BotDatabase(mpath);
  const ms = mdb.getFreeSettings(G);
  check('migration: old free_settings gains include_beta (default off, data kept)', ms.channelId === 'chOld' && ms.includeDlc && !ms.includeBeta && ms.stores.join() === 'steam');
  mdb.saveFreeSettings({ ...ms, includeBeta: true });
  check('migration: includeBeta saves after migration', mdb.getFreeSettings(G).includeBeta);
  mdb.close();
  rmSync(mdir, { recursive: true, force: true });
  rmSync(fdir, { recursive: true, force: true });

  // dashboard form parsing + backlog-seed decision
  const chans = new Set(['c1', 'c2']);
  const roles = new Set(['r1']);
  const pf = parseFreeForm({ channel: 'c1', pingRole: 'r1', stores: ['steam', 'bogus', 'epic'], includeDlc: '1' }, G, chans, roles);
  check('form: parses valid input', pf.channelId === 'c1' && pf.pingRoleId === 'r1' && pf.stores.join() === 'epic,steam' && pf.includeDlc && !pf.includeBeta && !pf.includeMobile && !pf.includeConsole);
  const pbad = parseFreeForm({ channel: 'nope', pingRole: 'nope', stores: 'gog' }, G, chans, roles);
  check('form: unknown channel/role -> null, single store string ok', pbad.channelId === null && pbad.pingRoleId === null && pbad.stores.join() === 'gog');
  check('form: empty form = disabled, no stores', parseFreeForm({}, G, chans, roles).stores.length === 0 && parseFreeForm({}, G, chans, roles).channelId === null);
  const base: FreeSettings = { guildId: G, channelId: 'c1', pingRoleId: null, stores: ['epic'], includeDlc: false, includeBeta: false, includeMobile: false, includeConsole: false };
  check('seed: unchanged -> no', !needsSeed(base, { ...base }));
  check('seed: ping role change only -> no', !needsSeed(base, { ...base, pingRoleId: 'r1' }));
  check('seed: channel changed -> yes', needsSeed(base, { ...base, channelId: 'c2' }));
  check('seed: disabled -> set -> yes', needsSeed({ ...base, channelId: null }, base));
  check('seed: set -> disabled -> no', !needsSeed(base, { ...base, channelId: null }));
  check('seed: store added -> yes', needsSeed(base, { ...base, stores: ['epic', 'gog'] }));
  check('seed: store removed -> no', !needsSeed({ ...base, stores: ['epic', 'gog'] }, base));
  check('seed: include flag enabled -> yes', needsSeed(base, { ...base, includeBeta: true }) && needsSeed(base, { ...base, includeMobile: true }) && needsSeed(base, { ...base, includeConsole: true }) && needsSeed(base, { ...base, includeDlc: true }));
  check('seed: include flag disabled -> no', !needsSeed({ ...base, includeDlc: true }, base));
}

// ---- FreeStuff webhook ------------------------------------------------------
{
  const fsDir = mkdtempSync(join(tmpdir(), 'bojan-smoke-fs-'));
  const kp = generateKeyPairSync('ed25519');
  const pub = (kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
  const other = (generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
  const mk = (id: string, ts: string, body: string): string => `v1a,${sign(null, Buffer.from(`${id}.${ts}.${body}`), kp.privateKey).toString('base64')}`;
  const tsNow = String(Math.floor(Date.now() / 1000));
  const tsCustom = String(Math.floor((Date.now() - 1735689600000) / 1000));
  const body = '{"type":"fsb:event:ping","timestamp":1,"data":{}}';
  const v = (o: Partial<Parameters<typeof verifyFreeStuffSignature>[0]> = {}): boolean =>
    verifyFreeStuffSignature({ publicKey: pub, id: 'w1', timestamp: tsNow, signature: mk('w1', tsNow, body), rawBody: body, ...o });
  check('freestuff sig: valid', v());
  check('freestuff sig: valid among several entries', v({ signature: `v1,abc v1a,@@@ ${mk('w1', tsNow, body)}` }));
  check('freestuff sig: tampered body', !v({ rawBody: body + ' ' }));
  check('freestuff sig: wrong key', !v({ publicKey: other }));
  check('freestuff sig: garbage key', !v({ publicKey: 'not-a-key' }));
  check('freestuff sig: missing header', !v({ signature: undefined }) && !v({ id: undefined }) && !v({ timestamp: undefined }));
  check('freestuff sig: garbled header', !v({ signature: 'garbage' }) && !v({ signature: 'v1a,' }) && !v({ signature: 'v1,' + mk('w1', tsNow, body).slice(4) }));
  const stale = String(Math.floor(Date.now() / 1000) - 3600);
  check('freestuff sig: stale timestamp rejected', !v({ timestamp: stale, signature: mk('w1', stale, body) }));
  check('freestuff ts: unix seconds accepted', freeStuffTimestampValid(tsNow));
  check('freestuff ts: custom-epoch seconds accepted', freeStuffTimestampValid(tsCustom) && v({ timestamp: tsCustom, signature: mk('w1', tsCustom, body) }));
  check('freestuff ts: garbage rejected', !freeStuffTimestampValid('abc') && !freeStuffTimestampValid('') && !freeStuffTimestampValid(undefined));
  const rg = createReplayGuard(1000);
  check('freestuff replay guard', !rg.seen('a', 0) && rg.seen('a', 500) && !rg.seen('a', 2000));

  const prod = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 1, title: 'Cool Game', kind: 'game', type: 'keep', store: 'epic', flags: 0,
    prices: [{ currency: 'EUR', oldValue: 599, newValue: 0 }, { currency: 'USD', oldValue: 499, newValue: 0 }],
    images: [{ url: 'https://i/sq.png', flags: 0, priority: 9 }, { url: 'https://i/wide.png', flags: 2, priority: 1 }],
    description: [{ lang: 'de', text: 'Hallo', priority: 9 }, { lang: 'en-US', text: 'Hello', priority: 1 }],
    urls: [{ url: 'https://s/low', priority: 1 }, { url: 'https://s/high', priority: 5 }],
    until: 1800000000000, ...o,
  });
  const g1 = normalizeFreeStuffProduct(prod());
  check('freestuff normalize: keep game', !!g1 && g1.key === 'fs:1' && g1.source === 'freestuff' && g1.kind === 'game' && g1.store === 'epic' && g1.platform === 'pc' && g1.url === 'https://s/high' && g1.imageUrl === 'https://i/wide.png' && g1.worth === '$4.99' && g1.endsAt === 1800000000000 && g1.description === 'Hello', JSON.stringify(g1));
  check('freestuff normalize: EUR worth when no USD', normalizeFreeStuffProduct(prod({ prices: [{ currency: 'EUR', oldValue: 599 }] }))?.worth === '€5.99');
  check('freestuff normalize: no until / no wide image / no prices', (() => { const g = normalizeFreeStuffProduct(prod({ until: 0, images: [{ url: 'x', flags: 0 }], prices: [] })); return !!g && g.endsAt === null && g.imageUrl === null && g.worth === null; })());
  check('freestuff normalize: dlc/loot/storeitem -> dlc', ['dlc', 'loot', 'storeitem'].every((k) => normalizeFreeStuffProduct(prod({ kind: k }))?.kind === 'dlc'));
  check('freestuff normalize: bundle -> game, playtest -> beta', normalizeFreeStuffProduct(prod({ kind: 'bundle' }))?.kind === 'game' && normalizeFreeStuffProduct(prod({ title: 'X Playtest Steam Key' }))?.kind === 'beta');
  check('freestuff normalize: mobile', normalizeFreeStuffProduct(prod({ type: 'mobile', store: 'gplay' }))?.platform === 'mobile' && normalizeFreeStuffProduct(prod({ urls: [{ url: 'u', platforms: ['ios'] }] }))?.platform === 'mobile');
  check('freestuff normalize: console', normalizeFreeStuffProduct(prod({ store: 'playstation' }))?.platform === 'console' && normalizeFreeStuffProduct(prod({ urls: [{ url: 'u', platforms: ['xbox'] }] }))?.platform === 'console');
  check('freestuff normalize: store mapping', normalizeFreeStuffProduct(prod({ store: 'ubi' }))?.store === 'ubisoft' && normalizeFreeStuffProduct(prod({ store: 'origin' }))?.store === 'ea' && normalizeFreeStuffProduct(prod({ store: 'humble' }))?.store === 'other' && normalizeFreeStuffProduct(prod({ store: 'gog' }))?.store === 'gog');
  check('freestuff normalize: skips timed/prime/gamepass/assets/unknown type', ['timed', 'prime', 'gamepass', 'playstation', 'assets', 'news', 'unknown', 'debug', 'zzz'].every((t) => normalizeFreeStuffProduct(prod({ type: t })) === null));
  check('freestuff normalize: skips TRASH / FIRSTPARTY flags', normalizeFreeStuffProduct(prod({ flags: 1 })) === null && normalizeFreeStuffProduct(prod({ flags: 16 })) === null);
  check('freestuff normalize: skips unknown kind, missing url/title/id, junk', normalizeFreeStuffProduct(prod({ kind: 'software' })) === null && normalizeFreeStuffProduct(prod({ urls: [] })) === null && normalizeFreeStuffProduct(prod({ urls: undefined })) === null && normalizeFreeStuffProduct(prod({ title: '' })) === null && normalizeFreeStuffProduct(prod({ id: undefined })) === null && normalizeFreeStuffProduct(null) === null && normalizeFreeStuffProduct('x') === null);
  const card = JSON.stringify(buildFreeGameMessage(g1!).components.map((c) => c.toJSON()));
  check('freestuff card: via FreeStuff attribution (and none for epic)', card.includes('via FreeStuff') && !card.includes('via GamerPower') && !JSON.stringify(buildFreeGameMessage({ ...g1!, source: 'epic' }).components.map((c) => c.toJSON())).includes('via FreeStuff'));

  // cross-source dedupe
  const epicCopy = { ...g1!, key: 'epic:x', source: 'epic' as const, title: 'COOL game!' };
  check('titleDedupeKey: same game across sources', titleDedupeKey(epicCopy) === titleDedupeKey(g1!) && titleDedupeKey(g1!) === 't:pc:epic:coolgame');
  check('titleDedupeKey: differs by store/platform/title', titleDedupeKey({ ...g1!, store: 'steam' }) !== titleDedupeKey(g1!) && titleDedupeKey({ ...g1!, platform: 'mobile' }) !== titleDedupeKey(g1!) && titleDedupeKey({ ...g1!, title: 'Other' }) !== titleDedupeKey(g1!));
  const ddb = new BotDatabase(join(fsDir, 'dedupe.db'));
  markGamesPosted(ddb, 'gd', [epicCopy]);
  check('dedupe: posted via epic -> freestuff copy counts as posted', isGamePosted(ddb, 'gd', g1!) && !isGamePosted(ddb, 'gd', { ...g1!, title: 'Another' }));

  // announce helper with fake discord objects
  const sent: unknown[] = [];
  const fakeClient = {
    guilds: { cache: new Map([['gd', { channels: { fetch: async () => ({ isSendable: () => true, send: async (m: unknown) => { sent.push(m); } }) } }]]) },
  } as never;
  const fs0: FreeSettings = { guildId: 'gd', channelId: 'ch', pingRoleId: null, stores: [...ALL_STORES], includeDlc: false, includeBeta: false, includeMobile: false, includeConsole: false };
  const fresh2 = { ...g1!, key: 'fs:2', title: 'Brand New' };
  const n = await announceInGuild(fakeClient, ddb, 'gd', fs0, [g1!, fresh2, { ...fresh2, key: 'gp:9', source: 'gamerpower' }]);
  check('announceInGuild: skips title-posted game, sends new once, marks both keys', n === 1 && sent.length === 1 && ddb.isFreePosted('gd', 'fs:2') && ddb.isFreePosted('gd', titleDedupeKey(fresh2)), `n=${n}`);
  check('announceInGuild: second run sends nothing', (await announceInGuild(fakeClient, ddb, 'gd', fs0, [fresh2])) === 0 && sent.length === 1);
  ddb.close();

  // real HTTP route through the Hono app
  process.env.DISCORD_TOKEN ??= 't'; process.env.CLIENT_ID ??= 'c'; process.env.CLIENT_SECRET ??= 's'; process.env.GUILD_ID ??= 'gd';
  process.env.DASHBOARD_URL ??= 'http://localhost:3000'; process.env.SESSION_SECRET ??= 'x';
  const { createWebApp } = await import('./web/server.js');
  const wdb = new BotDatabase(join(fsDir, 'web.db'));
  wdb.saveFreeSettings(fs0);
  const wsent: unknown[] = [];
  const wClient = { guilds: { cache: new Map([['gd', { id: 'gd', channels: { fetch: async () => ({ isSendable: () => true, send: async (m: unknown) => { wsent.push(m); } }) } }]]) } } as never;
  const app = createWebApp(wClient, wdb, { freestuffPublicKey: pub });
  const post = (b: string, id: string, o: { ts?: string; sig?: string; compat?: string | null } = {}) => {
    const ts = o.ts ?? tsNow;
    const headers: Record<string, string> = { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': o.sig ?? mk(id, ts, b), 'content-type': 'application/json' };
    if (o.compat !== null) headers['x-compatibility-date'] = o.compat ?? '2026-11-15';
    return app.request('/webhooks/freestuff', { method: 'POST', body: b, headers });
  };
  const rPing = await post(body, 'p1');
  check('route: valid ping -> 204, empty body, X-Set-Compatibility-Date', rPing.status === 204 && (await rPing.text()) === '' && rPing.headers.get('x-set-compatibility-date') === '2026-11-15', `status=${rPing.status}`);
  const rBad = await post(body, 'p2', { sig: mk('p2', tsNow, body + 'x') });
  check('route: bad signature -> 401', rBad.status === 401, `status=${rBad.status}`);
  check('route: missing signature -> 401', (await app.request('/webhooks/freestuff', { method: 'POST', body })).status === 401);
  const rCompat = await post(body, 'p3', { compat: '2025-01-01' });
  check('route: wrong compatibility date -> 409 with header', rCompat.status === 409 && rCompat.headers.get('x-set-compatibility-date') === '2026-11-15', `status=${rCompat.status}`);
  check('route: missing compatibility date -> 409', (await post(body, 'p3b', { compat: null })).status === 409);
  const annBody = JSON.stringify({ type: 'fsb:event:announcement_created', timestamp: 1, data: { resolvedProducts: [prod({ id: 77, title: 'Webhook Game' }), prod({ id: 78, type: 'timed' })] } });
  const rAnn = await post(annBody, 'a1');
  await new Promise((r) => setTimeout(r, 100));
  check('route: announcement -> 204 then announced once (timed skipped)', rAnn.status === 204 && wsent.length === 1 && wdb.isFreePosted('gd', 'fs:77'), `status=${rAnn.status} sent=${wsent.length}`);
  const rRep = await post(annBody, 'a1');
  await new Promise((r) => setTimeout(r, 100));
  check('route: replayed Webhook-Id -> 204, nothing new sent', rRep.status === 204 && wsent.length === 1);
  const rAnn2 = await post(annBody, 'a2');
  await new Promise((r) => setTimeout(r, 100));
  check('route: resend with new id -> deduped by key, still one message', rAnn2.status === 204 && wsent.length === 1);
  const upd = JSON.stringify({ type: 'fsb:event:product_updated', timestamp: 1, data: {} });
  check('route: product_updated / unknown / invalid JSON -> 204', (await post(upd, 'u1')).status === 204 && (await post('{"type":"x"}', 'u2')).status === 204 && (await post('not json', 'u3')).status === 204);
  const off = createWebApp(wClient, wdb, { freestuffPublicKey: null });
  const rOff = await off.request('/webhooks/freestuff', { method: 'POST', body, headers: { 'webhook-id': 'p1', 'webhook-timestamp': tsNow, 'webhook-signature': mk('p1', tsNow, body), 'x-compatibility-date': '2026-11-15' } });
  check('route: no public key configured -> 404', rOff.status === 404, `status=${rOff.status}`);
  wdb.close();
  rmSync(fsDir, { recursive: true, force: true });
}

// ---- userRank + dashboard "you" highlight --------------------------------
{
  const rdir = mkdtempSync(join(tmpdir(), 'bojan-rank-'));
  const rdb = new BotDatabase(join(rdir, 'rank.db'));
  const T0 = 1_000_000;
  // zed 3, amy 3 (tie -> amy ranks before zed), bob 5, cat 1
  for (let i = 0; i < 5; i++) rdb.recordMessage(G, 'c1', 'bob', T0 + i, `rb${i}`);
  for (let i = 0; i < 3; i++) rdb.recordMessage(G, 'c1', 'zed', T0 + i, `rz${i}`);
  for (let i = 0; i < 3; i++) rdb.recordMessage(G, 'c1', 'amy', T0 + i, `ra${i}`);
  rdb.recordMessage(G, 'c1', 'cat', T0, 'rc0');
  rdb.recordMessage(G, 'c1', 'cat', T0 + 500, 'rc1'); // cat: 2 total, 1 in [T0+100, T0+1000)
  const order = rdb.topUsers(G, 10).map((u) => u.userId);
  const ranks = order.map((u) => rdb.userRank(G, u)?.rank);
  check('userRank: consistent with topUsers order', ranks.join() === '1,2,3,4,5'.split(',').slice(0, order.length).join() && order.join() === 'bob,amy,zed,cat', `${order.join()} -> ${ranks.join()}`);
  check('userRank: tie broken by user_id ASC', rdb.userRank(G, 'amy')?.rank === 2 && rdb.userRank(G, 'zed')?.rank === 3 && rdb.userRank(G, 'zed')?.messages === 3);
  check('userRank: null when no messages', rdb.userRank(G, 'nobody') === null);
  check('userRank: ranged', rdb.userRank(G, 'cat', T0 + 100, T0 + 1000)?.rank === 1 && rdb.userRank(G, 'cat', T0 + 100, T0 + 1000)?.messages === 1 && rdb.userRank(G, 'bob', T0 + 100, T0 + 1000) === null && rdb.userRank(G, 'amy', T0, T0 + 2)?.rank === 1 && rdb.userRank(G, 'bob', T0, T0 + 2)?.rank === 2);
  rdb.close();
  rmSync(rdir, { recursive: true, force: true });

  const rows = [{ userId: 'u1', messages: 10 }, { userId: 'u2', messages: 5 }, { userId: 'u3', messages: 1 }];
  const mem = { u1: { name: 'One <b>', avatar: null }, u2: { name: 'Two', avatar: null }, u9: { name: 'Nine', avatar: null } };
  const inTop = leaderboard(rows, 16, mem, { userId: 'u2', rank: { rank: 2, messages: 5 } });
  check('leaderboard: user in top is highlighted once with badge + aria-current', (inTop.match(/class="top you"/g) ?? []).length === 1 && (inTop.match(/aria-current/g) ?? []).length === 1 && inTop.includes('aria-current="true"') && inTop.includes('>You</span>') && !inTop.includes('extra'));
  const outTop = leaderboard(rows, 100, mem, { userId: 'u9', rank: { rank: 42, messages: 3 } });
  check('leaderboard: user outside top gets extra row with real rank', outTop.includes('you extra') && outTop.includes('<span class="rank">42</span>') && outTop.includes('>Nine<') && outTop.includes('3.0%') && (outTop.match(/<li/g) ?? []).length === 4);
  const noYou = leaderboard(rows, 16, mem, { userId: 'u9', rank: null });
  check('leaderboard: no extra row when user has no messages; no highlight', !noYou.includes('you') && (noYou.match(/<li/g) ?? []).length === 3 && !leaderboard(rows, 16, mem).includes('aria-current'));
  check('leaderboard: names escaped', inTop.includes('One &lt;b&gt;') && !inTop.includes('One <b>'));
  const emptyYou = youSection(
    { allRank: null, weekRank: null, stats: { userId: 'u9', messages: 0, firstTs: null, lastTs: null }, reactions: { given: 0, received: 0 }, voice: { totalMs: 0, sessions: 0 }, activityMs: 0, topActivities: [], topVoice: [], emojiGiven: [], emojiReceived: [], nowPlaying: [], inVoice: null },
    { total: 10, timezone: 'UTC', channelNames: {}, username: 'Nine' },
  );
  check('youSection: empty state', emptyYou.includes('id="h-you"') && emptyYou.includes('No tracked activity'));
}

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
