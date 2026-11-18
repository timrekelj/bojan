// Offline smoke test: exercises the DB layer, stats math and provider
// detection without needing a Discord token. Run with: npm run smoke
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotDatabase } from './db.js';
import { currentWeekBounds, lastWeekBounds, leaderboardLines, weekKey, weekRangeLabel, zonedToUtcMs } from './stats.js';
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
console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
