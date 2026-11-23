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
import { daySeries, currentWeekBounds, lastWeekBounds, leaderboardLines, weekKey, weekRangeLabel, zonedToUtcMs } from './stats.js';
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

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
