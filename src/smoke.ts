// Offline smoke test: exercises the DB layer, stats math and provider
// detection without needing a Discord token. Run with: npm run smoke
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { MessageFlags } from 'discord.js';
import { renderDailyChart } from './chart.js';
import { buildWeeklyStatsMessage } from './weekly.js';
import { isWeeklyDue } from './scheduler.js';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { BotDatabase, clampLimitThreshold, type WebSessionRow } from './db.js';
import { buildActivityMessage, buildLeaderboardMessage } from './cards.js';
import { awardMessageXp, awardReactionXp, awardVoiceXp, buildLevelUpMessage, levelFromXp, levelProgress, levelTag, levelUpText, reactXpAmount, REACT_XP_CHANCE, rollXp, totalXpForLevel, voiceXpBlocks, VOICE_XP_BLOCK_MS, XP_BACKFILL_PER_MESSAGE, XP_COOLDOWN_MS } from './levels.js';
import { daySeries, currentWeekBounds, lastWeekBounds, leaderboardLines, startOfDay, weekKey, weekRangeLabel, zonedToUtcMs } from './stats.js';
import { filterGames, isBetaTitle } from './freegames/filters.js';
import { buildFreeGameMessage, priceLine } from './freegames/cards.js';
import { ALL_STORES, type FreeGame, type FreeSettings } from './freegames/types.js';
import { parseFreeForm } from './freegames/form.js';
import { builderSection, chromeParts, CLOUDS_URL, CLOUDS_VERSION, dashboardPage, deployPill, errorPage, faviconSvg, fmtAgo, healthPills, leaderboard, LIVE_SCRIPT, loginPage, logsPage, logsParts, medalFor, overviewParts, requestsParts, settingsPage, weekTabs, youSection, type OverviewData, type SettingsPageData } from './web/views.js';
import { summarizeDeployments, dokployEnabled, fetchDeployments } from './dokploy.js';
import { createHash, createHmac } from 'node:crypto';
import { generateKeyPairSync, sign } from 'node:crypto';
import { announceInGuild, markGamesPosted, titleDedupeKey, isGamePosted } from './freegames/actions.js';
import { createReplayGuard, freeStuffTimestampValid, normalizeFreeStuffProduct, verifyFreeStuffSignature } from './freegames/freestuff.js';
import {
  branchName, formatCost, formatTokens, formatUsage, isAdminLike, normalizeBuildResult, normalizePlanResult, parseAgentReply,
  parseModelRef, parsePrUrl, prInfoFromJson, prStateFromJson, stripBotMention, worktreeDirFor,
} from './builder/parse.js';
import {
  buildBuildingCard, buildCancelledCard, buildClosedCard, buildConflictFixCard, buildConflictFixedCard, buildConflictManualCard, buildQueuedCard, buildResumingCard, buildFailedCard, buildMergedCard, buildNoteCard, buildPlanCard, buildPrOpenedCard,
  type BuilderMessage,
} from './builder/cards.js';
import { extractReply, lastConversationIsAssistant } from './builder/opencode.js';
import { addUsage, estimateCostUsd, goPriceFor, parseGoPrices } from './builder/pricing.js';
import { parseBuilderForm, parseChatLanguages, parseLimitThreshold } from './builder/form.js';
import { blockingLimit, formatLimitDenial, LimitGate } from './builder/limits.js';
import { BUILD_RESUME_PROMPT, buildPrompt, CONFLICT_SETTLE_MS, FOLLOW_UP_HEADER, followUpPrompt, formatPlannerMessage, shouldHoldPlanReply, buildingActivity, reactionChannelFor, conflictAction, conflictFixPrompt, decideRecovery, freeSlots, guardPlanStatus, pickJobsToStart, planChanged, queuePosition, sortQueue } from './builder/queue.js';
import { chatThreadNameFor, chunkMessage, FEATURE_REQUEST_QUESTION, formatChatMessage, featureRequestText, formatDecisionInput, formatInitialPrompt, formatJobStatus, formatThreadContext, sinceLastBotMessage, formatTranscript, isFeatureRequest, languageDirective, parseChatReply, pickReplyTarget, replaceBotMention, shouldRunDecision, formatBuildNote, withLanguageRule, withNotes, selectImages } from './builder/chat-parse.js';
import { requestsPage } from './web/views.js';
import { logsHref, pagerHtml, parsePageSize, rangeSummary } from './web/views.js';
import { cachePercent, fmtMs, sessionParts, tokensCell, type SessionPageData } from './web/views.js';
import { clipText, fetchTranscript, MAX_TEXT_CHARS, MAX_TOOL_INPUT_CHARS, MAX_TOOL_OUTPUT_CHARS, normalizeTranscript } from './builder/transcript.js';
import { detectProvider, extractUrl, extractUrlOutsideCode, transformUrl, isShortLink } from './embeds/providers.js';
import { buildColorMessage, rolesToSwap, sortColorRoles } from './colors.js';

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
const lbTagged = leaderboardLines(top, 19, { alice: 650, bob: 242_000 });
const bobLine = lbTagged.find((l) => l.includes('<@bob>'));
const cathyLine = lbTagged.find((l) => l.includes('<@cathy>'));
check(
  'leaderboard lines carry level tags',
  (lbTagged[0]?.includes('lvl 3 · 50/400') ?? false) && (bobLine?.includes('lvl 69 · 500/7,000') ?? false) && !(cathyLine?.includes('lvl') ?? false),
  JSON.stringify(lbTagged.slice(0, 3)),
);

const s = db.getSettings(G);
check('default settings', s.weeklyEnabled && s.weeklyDay === 1 && s.weeklyHour === 9 && s.timezone === 'UTC' && s.embedChannels.length === 0);
db.saveSettings({ ...s, statsChannelId: 'chan9', weeklyDay: 5, weeklyHour: 18, timezone: 'Europe/Ljubljana', embedChannels: ['c1', 'c2'] });
const s2 = db.getSettings(G);
check('settings roundtrip', s2.statsChannelId === 'chan9' && s2.weeklyDay === 5 && s2.weeklyHour === 18 && s2.timezone === 'Europe/Ljubljana' && s2.embedChannels.join() === 'c1,c2');
check('default leveling settings', s.levelingEnabled && s.levelupChannelId === null);

// ---- leveling (MEE6-style XP) ------------------------------------------
check('level thresholds', totalXpForLevel(0) === 0 && totalXpForLevel(1) === 100 && totalXpForLevel(2) === 300 && totalXpForLevel(3) === 600);
check('level from xp', levelFromXp(0) === 0 && levelFromXp(99) === 0 && levelFromXp(100) === 1 && levelFromXp(599) === 2 && levelFromXp(600) === 3);
let levelRoundTrip = true;
for (const xp of [0, 5, 99, 100, 101, 299, 300, 599, 600, 12345, 1_000_000, 10_000_000]) {
  const l = levelFromXp(xp);
  if (totalXpForLevel(l) > xp || totalXpForLevel(l + 1) <= xp) levelRoundTrip = false;
}
check('level/xp round trip', levelRoundTrip);
let levelCostsGrow = true;
for (let l = 1; l < 50; l++) {
  if (totalXpForLevel(l + 1) - totalXpForLevel(l) <= totalXpForLevel(l) - totalXpForLevel(l - 1)) levelCostsGrow = false;
}
check('each level costs more xp than the previous', levelCostsGrow);
check('xp roll bounds', rollXp(() => 0) === 5 && rollXp(() => 0.999999) === 10);
const prog = levelProgress(650);
check('level progress', prog.level === 3 && prog.intoLevel === 50 && prog.needed === 350 && prog.nextLevelXp === 1000, JSON.stringify(prog));
check(
  'level tag',
  levelTag(null) === null &&
    levelTag(0) === 'lvl 0 · 0/100' &&
    levelTag(100) === 'lvl 1 · 0/200' &&
    levelTag(600) === 'lvl 3 · 0/400' && // exactly at a level boundary: progress restarts from 0
    levelTag(650) === 'lvl 3 · 50/400' &&
    levelTag(242_000) === 'lvl 69 · 500/7,000',
  `${levelTag(242_000)}`,
);
const x1 = awardMessageXp(db, G, 'gamer', now);
check('first message earns 5-10 xp', x1 !== null && x1.xpGained >= 5 && x1.xpGained <= 10 && x1.xp === x1.xpGained && x1.newLevel === 0 && !x1.leveledUp, JSON.stringify(x1));
check('no xp row for a stranger', db.getUserXp(G, 'stranger') === null);
check('cooldown blocks a second award', awardMessageXp(db, G, 'gamer', now + 5_000) === null);
const x3 = awardMessageXp(db, G, 'gamer', now + XP_COOLDOWN_MS + 5_000);
check('xp accrues after the cooldown', x3 !== null && x1 !== null && x3.xp === x1.xp + x3.xpGained && !x3.leveledUp, JSON.stringify({ x1, x3 }));
// 95 xp is exactly one roll (5-10) short of level 1 (100 xp)
db.addUserXp(G, 'speedrunner', 95, now);
const up = awardMessageXp(db, G, 'speedrunner', now + XP_COOLDOWN_MS + 6_000);
check('level-up detected at the crossing', up !== null && up.leveledUp && up.newLevel === 1 && up.xp >= 100 && up.xp <= 105, JSON.stringify(up));
const up2 = awardMessageXp(db, G, 'speedrunner', now + 2 * XP_COOLDOWN_MS + 7_000);
check('no level-up without a crossing', up2 !== null && !up2.leveledUp && up2.newLevel === 1, JSON.stringify(up2));
const xpTotals = db.getUserXpTotals(G);
check(
  'xp totals map matches per-user rows',
  xpTotals.gamer === db.getUserXp(G, 'gamer')?.xp && xpTotals.speedrunner === db.getUserXp(G, 'speedrunner')?.xp && xpTotals.stranger === undefined && Object.keys(xpTotals).length === 2,
  JSON.stringify(xpTotals),
);
db.saveSettings({ ...s2, levelingEnabled: false, levelupChannelId: 'chan-lvl' });
const s4 = db.getSettings(G);
check('leveling settings roundtrip', s4.levelingEnabled === false && s4.levelupChannelId === 'chan-lvl');
const lvlData = { userId: 'u1', username: 'gamer', level: 3, xp: 650, nextLevelXp: 1000 };
const lvlMsg = buildLevelUpMessage(lvlData);
const lvlJson = JSON.stringify(lvlMsg.components.map((c) => c.toJSON()));
check(
  'level-up message is V2 with no pings',
  (lvlMsg.flags & MessageFlags.IsComponentsV2) !== 0 && lvlMsg.components.length === 1 && lvlMsg.allowedMentions.parse.length === 0 && lvlJson.includes('<@u1>') && lvlJson.includes('level 3') && !('embeds' in lvlMsg),
);
check('level-up text fits the text budget', levelUpText(lvlData).length < 4000);

// ---- reaction XP (1% chance, level + 1 XP per win) ------------------------
check('react xp amount is level + 1', reactXpAmount(0) === 1 && reactXpAmount(3) === 4 && reactXpAmount(49) === 50);
check('react xp chance is 1%', REACT_XP_CHANCE === 0.01);
check(
  'missed react roll awards nothing and writes no row',
  awardReactionXp(db, G, 'reactor', now, () => 0.5) === null && awardReactionXp(db, G, 'reactor', now, () => 0.01) === null && db.getUserXp(G, 'reactor') === null,
);
const rWin = awardReactionXp(db, G, 'reactor', now + 1_000, () => 0);
check('first winning react awards level + 1 xp', rWin !== null && rWin.xpGained === 1 && rWin.xp === 1 && rWin.newLevel === 0 && !rWin.leveledUp, JSON.stringify(rWin));
const rWin2 = awardReactionXp(db, G, 'reactor', now + 2_000, () => 0.001);
check('react xp has no cooldown', rWin2 !== null && rWin !== null && rWin2.xp === 2 && rWin2.xpGained === 1 && !rWin2.leveledUp, JSON.stringify(rWin2));
db.addUserXp(G, 'reactorLucky', 99, now); // 1 xp short of level 1 (100 xp)
const rUp = awardReactionXp(db, G, 'reactorLucky', now + 3_000, () => 0.009);
check('react level-up detected at the crossing', rUp !== null && rUp.leveledUp && rUp.newLevel === 1 && rUp.xp === 100 && rUp.xpGained === 1, JSON.stringify(rUp));
db.addUserXp(G, 'reactorGrind', totalXpForLevel(49), now);
const rHigh = awardReactionXp(db, G, 'reactorGrind', now + 4_000, () => 0);
check('level 49 member wins 50 xp per react', rHigh !== null && rHigh.xpGained === 50 && rHigh.xp === totalXpForLevel(49) + 50 && rHigh.newLevel === 49 && !rHigh.leveledUp, JSON.stringify(rHigh));
const rWin3 = awardReactionXp(db, G, 'gamer', now + 5 * XP_COOLDOWN_MS, () => 0);
check(
  'react win refreshes the message xp window',
  rWin3 !== null && rWin3.xpGained === 1 && awardMessageXp(db, G, 'gamer', now + 5 * XP_COOLDOWN_MS + 5_000) === null,
  JSON.stringify(rWin3),
);


// ---- voice XP (10 xp per 10 min in voice) --------------------------------
check('voice xp blocks: partial blocks are dropped', voiceXpBlocks(0) === 0 && voiceXpBlocks(599_999) === 0 && voiceXpBlocks(VOICE_XP_BLOCK_MS) === 1 && voiceXpBlocks(1_800_000) === 3);
db.recordVoiceState(G, 'voiceGuy', 'vc1', now);
const voiceOpen = db.openVoiceSessions(G).find((r) => r.userId === 'voiceGuy');
check('voice session starts with no awarded blocks', voiceOpen !== undefined && voiceOpen.channelId === 'vc1' && voiceOpen.awardedBlocks === 0, JSON.stringify(voiceOpen));
check('no voice xp before a full block', voiceOpen !== undefined && awardVoiceXp(db, G, 'voiceGuy', voiceOpen, now + 599_999) === null);
const voiceOpen2 = db.openVoiceSessions(G).find((r) => r.userId === 'voiceGuy');
const vFirst = voiceOpen2 ? awardVoiceXp(db, G, 'voiceGuy', voiceOpen2, now + 600_000) : null;
check('10 xp at the first complete block', vFirst !== null && vFirst.xpGained === 10 && vFirst.xp === 10 && !vFirst.leveledUp, JSON.stringify(vFirst));
const voiceOpen3 = db.openVoiceSessions(G).find((r) => r.userId === 'voiceGuy');
check('a paid block is not paid twice', voiceOpen3 !== undefined && voiceOpen3.awardedBlocks === 1 && awardVoiceXp(db, G, 'voiceGuy', voiceOpen3, now + 600_000) === null);
const voiceOpen4 = db.openVoiceSessions(G).find((r) => r.userId === 'voiceGuy');
const vLate = voiceOpen4 ? awardVoiceXp(db, G, 'voiceGuy', voiceOpen4, now + 1_860_000) : null;
check('late blocks pay the missed ones', vLate !== null && vLate.xpGained === 20 && vLate.xp === 30, JSON.stringify(vLate));
db.addUserXp(G, 'voiceLucky', 95, now); // 5 xp short of level 1
db.recordVoiceState(G, 'voiceLucky', 'vc1', now);
const voiceLucky = db.openVoiceSessions(G).find((r) => r.userId === 'voiceLucky');
const vUp = voiceLucky ? awardVoiceXp(db, G, 'voiceLucky', voiceLucky, now + 600_000) : null;
check('voice xp level-up detected at the crossing', vUp !== null && vUp.leveledUp && vUp.newLevel === 1 && vUp.xp === 105, JSON.stringify(vUp));
db.recordVoiceState(G, 'voiceGuy', null, now + 2_000_000);
check('closed voice session drops out of the ticker', !db.openVoiceSessions(G).some((r) => r.userId === 'voiceGuy'));

// ---- one-time XP backfill (/backfill xp) ---------------------------------
// G has 21 recorded messages (alice 10, bob 5, carol 3, dave 1, erin 2).
// alice gets 50 earned XP first, gamer/speedrunner have roll XP but no messages.
db.recordMessage('guild2', 'c1', 'alice', now, 'g2a');
db.recordMessage('guild2', 'c1', 'alice', now + 1, 'g2b');
const bfTs = now + 3 * XP_COOLDOWN_MS;
db.addUserXp(G, 'alice', 50, bfTs);
const gamerXpBefore = db.getUserXp(G, 'gamer')?.xp ?? 0;
const bf = db.backfillMessageXp(G, bfTs);
check('xp backfill counts all recorded messages', bf.members === 5 && bf.messages === 21 && bf.xpGranted === 21 * XP_BACKFILL_PER_MESSAGE, JSON.stringify(bf));
check('xp backfill adds on top of earned xp', db.getUserXp(G, 'alice')?.xp === 50 + 10 * XP_BACKFILL_PER_MESSAGE, `${db.getUserXp(G, 'alice')?.xp}`);
check(
  'xp backfill creates rows and never touches xp earned without messages',
  db.getUserXp(G, 'bob')?.xp === 5 * XP_BACKFILL_PER_MESSAGE && db.getUserXp(G, 'erin')?.xp === 2 * XP_BACKFILL_PER_MESSAGE && db.getUserXp(G, 'gamer')?.xp === gamerXpBefore,
  JSON.stringify(db.getUserXpTotals(G)),
);
check('xp backfill sets last_xp_at', db.getUserXp(G, 'bob')?.lastXpAt === bfTs, `${db.getUserXp(G, 'bob')?.lastXpAt}`);
check('xp backfill stays within its guild', db.getUserXp('guild2', 'alice') === null, JSON.stringify(db.getUserXpTotals('guild2')));
const bfEmpty = db.backfillMessageXp('guild-empty', bfTs);
check('xp backfill without recorded messages is a no-op', bfEmpty.members === 0 && bfEmpty.messages === 0 && bfEmpty.xpGranted === 0 && db.getUserXp('guild-empty', 'alice') === null, JSON.stringify(bfEmpty));
// The one-time guard the command handler checks before running.
db.setState(`xpbackfill:${G}`, 'done');
check('xp backfill one-time flag roundtrip', db.getState(`xpbackfill:${G}`) === 'done');

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
const weeklyLvl = buildWeeklyStatsMessage({
  week: lwk, timeZone: 'UTC', weekTotal: 5, weekReactions: 0, activeMembers: 1, total: 5,
  topMessagers: [{ userId: 'alice', messages: 5 }], xpByUser: { alice: 650, bob: 100 },
  topChannels: [], topGiven: [], topReceived: [], perDay: [],
});
check('weekly shows level tags', JSON.stringify(weeklyLvl.components.map((c) => c.toJSON())).includes('lvl 3 · 50/400'));

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
  xpByUser: { alice: 650, bob: 242_000 },
  guildIconUrl: 'https://example.com/icon.png',
});
const lbJson = lb.components.map((c) => c.toJSON());
check('leaderboard is V2 with one container, no pings', (lb.flags & MessageFlags.IsComponentsV2) !== 0 && lb.components.length === 1 && lbJson[0]?.type === 17 && lb.allowedMentions.parse.length === 0 && !('embeds' in lb));
const lbJsonStr = JSON.stringify(lbJson);
check('leaderboard tags messages and reaction rows', lbJsonStr.includes('lvl 3 · 50/400') && lbJsonStr.includes('lvl 69 · 500/7,000'));
const bigUsers = Array.from({ length: 50 }, (_, i) => ({ userId: `${'1'.repeat(18)}${i}`, messages: 100000 - i, firstTs: 0, lastTs: 0 })) as unknown as ReturnType<typeof db.topUsers>;
const bigReactions = Array.from({ length: 50 }, (_, i) => ({ userId: `${'2'.repeat(18)}${i}`, count: 90000 - i }));
const lbBig = buildLeaderboardMessage({ limit: 50, totalMessages: 9_999_999, totalReactions: 999_999, topUsers: bigUsers, topGiven: bigReactions, topReceived: bigReactions });
const lbBigLen = textLength(lbBig.components.map((c) => c.toJSON()));
check('leaderboard with 50 rows stays under 4000 chars', lbBigLen < 4000 && lbBigLen > 500, `${lbBigLen} chars`);
const bigXp = Object.fromEntries(bigUsers.map((u) => [u.userId, 242_000]));
const lbBigLvl = buildLeaderboardMessage({ limit: 50, totalMessages: 9_999_999, totalReactions: 999_999, topUsers: bigUsers, topGiven: bigReactions, topReceived: bigReactions, xpByUser: bigXp });
const lbBigLvlLen = textLength(lbBigLvl.components.map((c) => c.toJSON()));
check('leaderboard with 50 rows and level tags still fits the budget', lbBigLvlLen < 4000 && lbBigLvlLen > 500, `${lbBigLvlLen} chars`);

const actNow = Date.now();
const actDayStart = actNow - 6 * D;
const actDays = daySeries({ start: actDayStart, end: actNow, key: '' }, 'UTC');
const act = buildActivityMessage({
  name: 'League of Legends', username: 'alice', avatarUrl: 'https://example.com/a.png', timeZone: 'UTC',
  xp: 650,
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
check('activity header shows the level tag', actJson.includes('lvl 3 · 50/400'));
const actEmpty = buildActivityMessage({
  name: 'x', username: 'u', timeZone: 'UTC', summary: { name: 'x', sessions: 1, totalMs: 0, avgMs: 0, firstAt: null, lastAt: null },
  breakdown: [], recent: [], minutes: [], dayStart: actDayStart, now: actNow,
});
const actEmptyJson = JSON.stringify(actEmpty.components.map((c) => c.toJSON()));
check('activity omits empty sections', !actEmptyJson.includes('Breakdown') && !actEmptyJson.includes('Recent sessions'));
check('activity header has no level tag without xp', !actEmptyJson.includes('lvl '));
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
// isWeeklyDue: Monday 10:00 Ljubljana (UTC+1 in Nov) == 09:00 UTC; weeklyDay 1 = Monday
{
  const tz = 'Europe/Ljubljana';
  const d = (s: string): Date => new Date(s);
  check('isWeeklyDue before time', !isWeeklyDue(tz, 1, 10, d('2026-11-23T08:59:00Z'), '2026-11-16'));
  check('isWeeklyDue at hour', isWeeklyDue(tz, 1, 10, d('2026-11-23T09:00:00Z'), '2026-11-16'));
  check('isWeeklyDue catch-up Wednesday', isWeeklyDue(tz, 1, 10, d('2026-11-25T15:00:00Z'), '2026-11-16'));
  check('isWeeklyDue already sent', !isWeeklyDue(tz, 1, 10, d('2026-11-25T15:00:00Z'), '2026-11-23'));
  check('isWeeklyDue never sent', isWeeklyDue(tz, 1, 10, d('2026-11-23T09:30:00Z'), null));
  // Sunday schedule: last day of the Monday-based week (2026-11-29 10:00 local == 09:00 UTC)
  check('isWeeklyDue Sunday before', !isWeeklyDue(tz, 0, 10, d('2026-11-29T08:59:00Z'), '2026-11-16'));
  check('isWeeklyDue Sunday mid-week not due', !isWeeklyDue(tz, 0, 10, d('2026-11-25T15:00:00Z'), '2026-11-16'));
  check('isWeeklyDue Sunday at hour', isWeeklyDue(tz, 0, 10, d('2026-11-29T09:00:00Z'), '2026-11-16'));
}
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
  const mk = (key: string, title: string, o: Partial<FreeGame> = {}): FreeGame => ({
    key, title, description: '', store: 'steam', kind: 'game', platform: 'pc', url: `https://x/${key}`, imageUrl: null, worth: null, endsAt: null, ...o,
  });
  const fixtures: FreeGame[] = [
    mk('fs:e1', 'Free Epic Game', { store: 'epic', worth: '$19.99', imageUrl: 'https://img/w.jpg' }),
    mk('fs:1', 'Cool Game', { worth: '$4.99', endsAt: Date.UTC(2026, 10, 30, 23, 59) }),
    mk('fs:3', 'Shiny DLC', { store: 'gog', kind: 'dlc' }),
    mk('fs:4', 'Phone Game', { store: 'other', platform: 'mobile' }),
    mk('fs:6', 'Early Thing', { store: 'itch' }),
  ];
  const byKey = new Map(fixtures.map((g) => [g.key, g]));

  const defaults: FreeSettings = { guildId: G, channelId: null, pingRoleId: null, stores: [...ALL_STORES], includeDlc: false, includeBeta: false, includeMobile: false };
  const keys = (f: FreeSettings): string => filterGames(fixtures, f).map((g) => g.key).sort().join(',');
  check('filter: defaults = PC full games only', keys(defaults) === 'fs:1,fs:6,fs:e1', keys(defaults));
  check('filter: includeDlc', keys({ ...defaults, includeDlc: true }) === 'fs:1,fs:3,fs:6,fs:e1');
  check('filter: mobile', keys({ ...defaults, includeMobile: true }) === 'fs:1,fs:4,fs:6,fs:e1');
  check('filter: store disabled', keys({ ...defaults, stores: ['epic'] }) === 'fs:e1', keys({ ...defaults, stores: ['epic'] }));

  const cool = byKey.get('fs:1')!;
  check('price line', priceLine(cool).startsWith('~~$4.99~~ **FREE** until <t:') && priceLine({ ...cool, worth: null, endsAt: null }) === '**FREE**');
  const card = buildFreeGameMessage(cool, { pingRoleId: '123' });
  const cardJson = JSON.stringify(card.components.map((c) => c.toJSON()));
  check('announcement card: V2 flag, role ping, attribution, link button',
    card.flags === MessageFlags.IsComponentsV2 && cardJson.includes('<@&123>') && cardJson.includes('via FreeStuff') && cardJson.includes('Open on Steam') && JSON.stringify(card.allowedMentions) === '{"roles":["123"]}');
  const plain = buildFreeGameMessage(fixtures[0]!);
  check('announcement card: no ping → no mentions', 'parse' in plain.allowedMentions && plain.allowedMentions.parse.length === 0);

  // ---- name colours ---------------------------------------------------
  const swap = rolesToSwap(['r1', 'x'], ['r1', 'r2', 'r3'], 'r2');
  check('colors: rolesToSwap drops other colour roles and adds the chosen one', swap.remove.join() === 'r1' && swap.add.join() === 'r2');
  const same = rolesToSwap(['r2'], ['r1', 'r2'], 'r2');
  check('colors: rolesToSwap is a no-op when the colour is already worn', same.remove.length === 0 && same.add.length === 0);
  const unrelated = rolesToSwap(['x'], ['r1', 'r2'], 'r1');
  check('colors: rolesToSwap leaves unrelated roles alone', unrelated.remove.length === 0 && unrelated.add.join() === 'r1');
  check('colors: sortColorRoles by position then name',
    sortColorRoles([{ name: 'b', position: 1 }, { name: 'a', position: 3 }, { name: 'a', position: 1 }]).map((r) => `${r.name}${r.position}`).join() === 'a3,a1,b1');
  const colorMsg = buildColorMessage('r9');
  const colorJson = JSON.stringify(colorMsg.components.map((c) => c.toJSON()));
  check('colors: picker message is a V2 card mentioning the role without pings',
    colorMsg.flags === MessageFlags.IsComponentsV2 && colorJson.includes('<@&r9>') && JSON.stringify(colorMsg.allowedMentions) === '{"parse":[],"repliedUser":false}');

  const cdir = mkdtempSync(join(tmpdir(), 'bojan-colors-'));
  const cdb = new BotDatabase(join(cdir, 'colors.db'));
  check('colors: settings default to no channel and no roles', cdb.getColorSettings(G).channelId === null && cdb.getColorRoles(G).length === 0);
  cdb.saveColorSettings({ guildId: G, channelId: 'ch1' });
  check('colors: selection saved', cdb.saveColorSelection(G, ['r1', 'r2', 'r3']).length === 0 && cdb.getColorRoles(G).length === 3 && cdb.getColorSettings(G).channelId === 'ch1');
  cdb.setColorMessage(G, 'r1', 'm1');
  cdb.setColorMessage(G, 'r2', 'm2');
  check('colors: picker message maps back to its role',
    cdb.colorRoleForMessage(G, 'm1') === 'r1' && cdb.colorRoleForMessage(G, 'm2') === 'r2' && cdb.colorRoleForMessage(G, 'nope') === null);
  const droppedColors = cdb.saveColorSelection(G, ['r1', 'r3']);
  check('colors: unselected role is dropped with its message',
    droppedColors.length === 1 && droppedColors[0]!.roleId === 'r2' && droppedColors[0]!.messageId === 'm2' && cdb.getColorRoles(G).length === 2);
  const clearedColors = cdb.clearColorMessages(G);
  check('colors: a channel change clears stored messages',
    clearedColors.length === 1 && clearedColors[0]!.roleId === 'r1' && cdb.getColorRoles(G).every((r) => r.messageId === null));
  cdb.close();
  rmSync(cdir, { recursive: true, force: true });

  const fdir = mkdtempSync(join(tmpdir(), 'bojan-free-'));
  const fdb = new BotDatabase(join(fdir, 'free.db'));
  const fs0 = fdb.getFreeSettings(G);
  check('free settings defaults', fs0.channelId === null && fs0.stores.length === ALL_STORES.length && !fs0.includeDlc && !fs0.includeBeta && !fs0.includeMobile);
  fdb.saveFreeSettings({ ...fs0, channelId: 'ch1', pingRoleId: 'r1', stores: ['epic', 'steam'], includeDlc: true, includeBeta: true });
  const fs1 = fdb.getFreeSettings(G);
  check('free settings round-trip', fs1.channelId === 'ch1' && fs1.pingRoleId === 'r1' && fs1.stores.join() === 'epic,steam' && fs1.includeDlc && fs1.includeBeta && !fs1.includeMobile);
  fdb.saveFreeSettings({ ...fs1, channelId: null, pingRoleId: null });
  check('free settings update/clear', fdb.getFreeSettings(G).channelId === null && fdb.getFreeSettings(G).pingRoleId === null);
  check('free_posted: mark + dedupe', fdb.markFreePosted(G, ['fs:e1', 'fs:1']) === 2 && fdb.markFreePosted(G, ['fs:e1', 'fs:3']) === 1 && fdb.isFreePosted(G, 'fs:3') && !fdb.isFreePosted(G, 'fs:9') && !fdb.isFreePosted('other', 'fs:3') && fdb.countFreePosted(G) === 3);
  fdb.close();

  // beta classification
  const betaGames = [
    mk('b:101', 'Scallywags Playtest', { kind: isBetaTitle('Scallywags Playtest') ? 'beta' : 'game' }),
    mk('b:102', 'Zero King (Beta)', { kind: isBetaTitle('Zero King (Beta)') ? 'beta' : 'game' }),
    mk('b:103', 'DungeonLoot: Open Beta Has Arrived!', { kind: isBetaTitle('DungeonLoot: Open Beta Has Arrived!') ? 'beta' : 'game' }),
    mk('b:105', 'Cozy Farm'),
    mk('b:106', 'Betrayal at Club Low', { kind: isBetaTitle('Betrayal at Club Low') ? 'beta' : 'game' }),
    mk('b:107', 'Alphabet Adventure', { kind: isBetaTitle('Alphabet Adventure') ? 'beta' : 'game' }),
  ];
  const bk = new Map(betaGames.map((g) => [g.key, g]));
  check('beta: playtest/beta titles classified beta', ['b:101', 'b:102', 'b:103'].every((k) => bk.get(k)?.kind === 'beta'), betaGames.map((g) => `${g.key}=${g.kind}`).join(' '));
  check('beta: word boundary false positives stay game', bk.get('b:106')?.kind === 'game' && bk.get('b:107')?.kind === 'game' && !isBetaTitle('Betrayal at Club Low') && isBetaTitle('Foo DEMO') && isBetaTitle('Bar Test Key') && isBetaTitle('Baz Closed Beta'));
  const betaKeys = (f: FreeSettings): string => filterGames(betaGames, f).map((g) => g.key).join(',');
  check('beta: excluded by default', betaKeys(defaults) === 'b:105,b:106,b:107', betaKeys(defaults));
  check('beta: includeBeta admits them (platform rules still apply)', betaKeys({ ...defaults, includeBeta: true }).split(',').length === 6 && betaKeys({ ...defaults, includeBeta: true, stores: ['epic'] }) === '');
  check('beta: label on card', JSON.stringify(buildFreeGameMessage(bk.get('b:101')!).components.map((c) => c.toJSON())).includes('Beta / playtest'));

  rmSync(fdir, { recursive: true, force: true });

  // dashboard form parsing
  const chans = new Set(['c1', 'c2']);
  const roles = new Set(['r1']);
  const pf = parseFreeForm({ channel: 'c1', pingRole: 'r1', stores: ['steam', 'bogus', 'epic'], includeDlc: '1' }, G, chans, roles);
  check('form: parses valid input', pf.channelId === 'c1' && pf.pingRoleId === 'r1' && pf.stores.join() === 'epic,steam' && pf.includeDlc && !pf.includeBeta && !pf.includeMobile);
  const pbad = parseFreeForm({ channel: 'nope', pingRole: 'nope', stores: 'gog' }, G, chans, roles);
  check('form: unknown channel/role -> null, single store string ok', pbad.channelId === null && pbad.pingRoleId === null && pbad.stores.join() === 'gog');
  check('form: empty form = disabled, no stores', parseFreeForm({}, G, chans, roles).stores.length === 0 && parseFreeForm({}, G, chans, roles).channelId === null);
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
  check('freestuff normalize: keep game', !!g1 && g1.key === 'fs:1' && g1.kind === 'game' && g1.store === 'epic' && g1.platform === 'pc' && g1.url === 'https://s/high' && g1.imageUrl === 'https://i/wide.png' && g1.worth === '$4.99' && g1.endsAt === 1800000000000 && g1.description === 'Hello', JSON.stringify(g1));
  check('freestuff normalize: EUR worth when no USD', normalizeFreeStuffProduct(prod({ prices: [{ currency: 'EUR', oldValue: 599 }] }))?.worth === '€5.99');
  check('freestuff normalize: no until / no wide image / no prices', (() => { const g = normalizeFreeStuffProduct(prod({ until: 0, images: [{ url: 'x', flags: 0 }], prices: [] })); return !!g && g.endsAt === null && g.imageUrl === null && g.worth === null; })());
  check('freestuff normalize: dlc/loot/storeitem -> dlc', ['dlc', 'loot', 'storeitem'].every((k) => normalizeFreeStuffProduct(prod({ kind: k }))?.kind === 'dlc'));
  check('freestuff normalize: bundle -> game, playtest -> beta', normalizeFreeStuffProduct(prod({ kind: 'bundle' }))?.kind === 'game' && normalizeFreeStuffProduct(prod({ title: 'X Playtest Steam Key' }))?.kind === 'beta');
  check('freestuff normalize: mobile', normalizeFreeStuffProduct(prod({ type: 'mobile', store: 'gplay' }))?.platform === 'mobile' && normalizeFreeStuffProduct(prod({ urls: [{ url: 'u', platforms: ['ios'] }] }))?.platform === 'mobile');
  check('freestuff normalize: console -> null', normalizeFreeStuffProduct(prod({ store: 'playstation' })) === null && normalizeFreeStuffProduct(prod({ urls: [{ url: 'u', platforms: ['xbox'] }] })) === null && normalizeFreeStuffProduct(prod({ urls: [{ url: 'u', platforms: ['ps5'] }] })) === null);
  check('freestuff normalize: store mapping', normalizeFreeStuffProduct(prod({ store: 'ubi' }))?.store === 'ubisoft' && normalizeFreeStuffProduct(prod({ store: 'origin' }))?.store === 'ea' && normalizeFreeStuffProduct(prod({ store: 'humble' }))?.store === 'other' && normalizeFreeStuffProduct(prod({ store: 'gog' }))?.store === 'gog');
  check('freestuff normalize: skips timed/prime/gamepass/assets/unknown type', ['timed', 'prime', 'gamepass', 'playstation', 'assets', 'news', 'unknown', 'debug', 'zzz'].every((t) => normalizeFreeStuffProduct(prod({ type: t })) === null));
  check('freestuff normalize: skips TRASH / FIRSTPARTY flags', normalizeFreeStuffProduct(prod({ flags: 1 })) === null && normalizeFreeStuffProduct(prod({ flags: 16 })) === null);
  check('freestuff normalize: skips unknown kind, missing url/title/id, junk', normalizeFreeStuffProduct(prod({ kind: 'software' })) === null && normalizeFreeStuffProduct(prod({ urls: [] })) === null && normalizeFreeStuffProduct(prod({ urls: undefined })) === null && normalizeFreeStuffProduct(prod({ title: '' })) === null && normalizeFreeStuffProduct(prod({ id: undefined })) === null && normalizeFreeStuffProduct(null) === null && normalizeFreeStuffProduct('x') === null);
  const card = JSON.stringify(buildFreeGameMessage(g1!).components.map((c) => c.toJSON()));
  check('freestuff card: via FreeStuff attribution', card.includes('via FreeStuff'));

  // cross-source dedupe
  const epicCopy = { ...g1!, key: 'fs:x', title: 'COOL game!' };
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
  const fs0: FreeSettings = { guildId: 'gd', channelId: 'ch', pingRoleId: null, stores: [...ALL_STORES], includeDlc: false, includeBeta: false, includeMobile: false };
  const fresh2 = { ...g1!, key: 'fs:2', title: 'Brand New' };
  const n = await announceInGuild(fakeClient, ddb, 'gd', fs0, [g1!, fresh2, { ...fresh2, key: 'fs:9' }]);
  check('announceInGuild: skips title-posted game, sends new once, marks both keys', n === 1 && sent.length === 1 && ddb.isFreePosted('gd', 'fs:2') && ddb.isFreePosted('gd', titleDedupeKey(fresh2)), `n=${n}`);
  check('announceInGuild: second run sends nothing', (await announceInGuild(fakeClient, ddb, 'gd', fs0, [fresh2])) === 0 && sent.length === 1);
  ddb.close();

  // real HTTP route through the Hono app
  process.env.DISCORD_TOKEN ??= 't'; process.env.CLIENT_ID ??= 'c'; process.env.CLIENT_SECRET ??= 's'; process.env.GUILD_ID ??= 'gd';
  process.env.DASHBOARD_URL ??= 'http://localhost:3000'; process.env.SESSION_SECRET ??= 'x';
  const { createWebApp, botAvatarTarget } = await import('./web/server.js');
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

  // dashboard routes: favicon, auth gates, the four pages, live refresh and settings redirects
  {
    const { config: cfg } = await import('./config.js');
    const dClient = { guilds: { cache: new Map() }, users: { cache: new Map() }, ws: { ping: 7 } } as never;
    wdb.saveWebSession({ sid: 'sv1', userId: 'uview', username: 'Viewer <i>', avatar: '', accessToken: 't', createdAt: now, expiresAt: now + D });
    const dash = createWebApp(dClient, wdb, { freestuffPublicKey: null });
    const cookie = `sid=sv1.${createHmac('sha256', cfg.sessionSecret).update('sv1').digest('hex')}`;
    const get = (path: string, auth = true) => dash.request(path, auth ? { headers: { cookie } } : {});
    const postForm = (path: string, body: string) => dash.request(path, { method: 'POST', body, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });

    const fav = await get('/favicon.svg', false);
    check('route: /favicon.svg is public, svg, cached', fav.status === 200 && (fav.headers.get('content-type') ?? '').startsWith('image/svg+xml') && /max-age=\d{6,}/.test(fav.headers.get('cache-control') ?? '') && (await fav.text()) === faviconSvg());
    const cloudsRes = await get('/assets/clouds.png', false);
    const cloudsBytes = Buffer.from(await cloudsRes.arrayBuffer());
    check(
      'route: /assets/clouds.png is public, png, immutable, and matches the versioned url',
      cloudsRes.status === 200 && cloudsRes.headers.get('content-type') === 'image/png' && (cloudsRes.headers.get('cache-control') ?? '').includes('max-age=31536000') && (cloudsRes.headers.get('cache-control') ?? '').includes('immutable') &&
        cloudsBytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && cloudsBytes.readUInt32BE(16) === 2000 && cloudsBytes[24] === 1 && cloudsBytes[25] === 3 && cloudsBytes.length < 150_000 &&
        createHash('sha256').update(cloudsBytes).digest('hex').startsWith(CLOUDS_VERSION) && CLOUDS_URL === `/assets/clouds.png?v=${CLOUDS_VERSION}` && (await get(CLOUDS_URL, false)).status === 200,
      `status=${cloudsRes.status} bytes=${cloudsBytes.length}`,
    );
    const ico = await get('/favicon.ico', false);
    check('route: /favicon.ico redirects to /bot-avatar', ico.status === 302 && ico.headers.get('location') === '/bot-avatar');
    const av = await get('/bot-avatar', false);
    check('route: /bot-avatar is public, falls back to /favicon.svg without a bot user', av.status === 302 && av.headers.get('location') === '/favicon.svg' && /max-age=\d+/.test(av.headers.get('cache-control') ?? ''), `status=${av.status} loc=${av.headers.get('location')}`);
    check('botAvatarTarget: avatar url or the svg fallback', botAvatarTarget('https://cdn.discordapp.com/avatars/1/a.png?size=128') === 'https://cdn.discordapp.com/avatars/1/a.png?size=128' && botAvatarTarget(null) === '/favicon.svg');
    const liveAnon = await get('/dashboard/live?view=overview', false);
    check('route: unauthenticated /dashboard/live -> 401 json, not a redirect', liveAnon.status === 401 && (liveAnon.headers.get('content-type') ?? '').includes('application/json') && liveAnon.headers.get('location') === null);
    const setAnon = await get('/dashboard/settings', false);
    check('route: unauthenticated /dashboard/settings -> login', setAnon.status === 302 && setAnon.headers.get('location') === '/login');

    const ovRes = await get('/dashboard');
    const ov = await ovRes.text();
    check('route: overview renders shell + live regions, no settings forms', ovRes.status === 200 && ov.includes('data-live="overview"') && ['live-health', 'live-kpis', 'live-you', 'live-week', 'live-all', 'live-react'].every((id) => ov.includes(`id="${id}"`)) && !ov.includes('<form') && ov.includes('Viewer &lt;i&gt;') && !ov.includes('Viewer <i>'));
    const liveRes = await get('/dashboard/live?view=overview&week=last');
    const liveJson = (await liveRes.json()) as { parts: Record<string, string> };
    check(
      'route: /dashboard/live returns the overview regions as html',
      liveRes.status === 200 && ['live-health', 'live-kpis', 'live-you', 'live-week', 'live-all', 'live-react'].every((id) => typeof liveJson.parts[id] === 'string') && liveJson.parts['live-week']!.includes('<span class="tab" aria-current="page">Last week</span>') && ov.includes(liveJson.parts['live-kpis']!) && !('live-deploy' in liveJson.parts),
    );
    const liveLogs = (await (await get('/dashboard/live?view=logs&level=error')).json()) as { parts: Record<string, string> };
    const liveReqs = (await (await get('/dashboard/live?view=requests')).json()) as { parts: Record<string, string> };
    const liveSet = (await (await get('/dashboard/live?view=settings')).json()) as { parts: Record<string, string> };
    check('route: live logs / requests / settings parts', typeof liveLogs.parts['live-logs'] === 'string' && typeof liveReqs.parts['live-reqs'] === 'string' && typeof liveReqs.parts['live-chat-kpis'] === 'string' && Object.keys(liveSet.parts).length === 0 && (await get('/dashboard/live?view=nope')).status === 400);

    const setRes = await get('/dashboard/settings?saved=1');
    const setHtml = await setRes.text();
    check('route: settings page renders the three forms + saved flash', setRes.status === 200 && setHtml.includes('action="/settings"') && setHtml.includes('action="/free-settings"') && setHtml.includes('action="/builder-settings"') && setHtml.includes('Settings saved.') && setHtml.includes('<a href="/dashboard/settings" aria-current="page">'));
    const logsRes = await get('/dashboard/logs');
    const reqRes = await get('/dashboard/requests');
    check('route: logs + requests pages render', logsRes.status === 200 && (await logsRes.text()).includes('id="live-logs"') && reqRes.status === 200 && (await reqRes.text()).includes('id="live-reqs"'));

    const p1 = await postForm('/settings', 'weeklyEnabled=1&statsChannel=c1&weeklyDay=3&weeklyHour=18&timezone=Europe%2FLjubljana&embedChannels=c1&embedChannels=c2&levelingEnabled=1&levelupChannel=');
    const saved = wdb.getSettings(cfg.guildId);
    check('route: POST /settings saves and redirects to the settings page', p1.status === 302 && p1.headers.get('location') === '/dashboard/settings?saved=1' && saved.weeklyDay === 3 && saved.weeklyHour === 18 && saved.statsChannelId === 'c1' && saved.embedChannels.join() === 'c1,c2' && saved.levelingEnabled && saved.levelupChannelId === null);
    const p2 = await postForm('/free-settings', 'channel=&pingRole=&stores=steam&includeBeta=1');
    check('route: POST /free-settings redirects to #free', p2.status === 302 && p2.headers.get('location') === '/dashboard/settings?freeSaved=1#free' && wdb.getFreeSettings(cfg.guildId).includeBeta === true && wdb.getFreeSettings(cfg.guildId).stores.join() === 'steam');
    const p3 = await postForm('/builder-settings', 'chatEnabled=1&chatModel=opencode-go%2Fa&chatDecisionModel=opencode-go%2Fb&chatLanguages=English&model=opencode-go%2Fc&maxParallelBuilds=2&limitThreshold=90');
    check('route: POST /builder-settings redirects to #builder', p3.status === 302 && p3.headers.get('location') === '/dashboard/settings?builderSaved=1#builder' && wdb.getBuilderSettings().limitThreshold === 90 && wdb.getBuilderSettings().maxParallelBuilds === 2);
    const p4 = await postForm('/builder-settings', 'model=not-a-model-ref');
    check('route: POST /builder-settings error flag keeps the anchor', p4.status === 302 && /^\/dashboard\/settings\?builderError=.+#builder$/.test(p4.headers.get('location') ?? ''), p4.headers.get('location') ?? '');
    const p5 = await postForm('/weekly/send-now', '');
    check('route: POST /weekly/send-now redirects to the settings page', p5.status === 302 && (p5.headers.get('location') ?? '').startsWith('/dashboard/settings?weekly=error&reason='), p5.headers.get('location') ?? '');
    wdb.deleteWebSessionsForUser('uview');
  }

  // dashboard sessions persist in the DB so redeploys don't force a re-login
  const mkSess = (sid: string, userId: string, username: string, expiresAt: number): WebSessionRow => ({ sid, userId, username, avatar: `a-${sid}.png`, accessToken: `tok-${sid}`, createdAt: now, expiresAt });
  wdb.saveWebSession(mkSess('s1', 'u1', 'Ann', now + D));
  wdb.saveWebSession(mkSess('s2', 'u1', 'Ann', now - 1)); // already expired
  wdb.saveWebSession(mkSess('s3', 'u2', 'Bob', now + 2 * D));
  const live = wdb.loadWebSessions(now);
  check('web sessions: expired row pruned, live rows loaded in order', live.length === 2 && live[0]?.sid === 's1' && live[0]?.username === 'Ann' && live[0]?.avatar === 'a-s1.png' && live[0]?.accessToken === 'tok-s1' && live[1]?.sid === 's3', JSON.stringify(live.map((x) => x.sid)));
  check('web sessions: second load keeps pruning to the same rows', wdb.loadWebSessions(now).length === 2);
  wdb.saveWebSession({ ...mkSess('s1', 'u1', 'Ann', now + D), username: 'Ann R.' });
  const replaced = wdb.loadWebSessions(now).find((x) => x.sid === 's1');
  check('web sessions: same sid is replaced, not duplicated', wdb.loadWebSessions(now).length === 2 && replaced?.username === 'Ann R.', replaced?.username ?? 'missing');
  wdb.deleteWebSessionsForUser('u1');
  const afterLogout = wdb.loadWebSessions(now);
  check("web sessions: logout deletes all of the user's rows, other users untouched", afterLogout.length === 1 && afterLogout[0]?.userId === 'u2', JSON.stringify(afterLogout.map((x) => x.sid)));

  // a fresh app instance (simulated redeploy) restores the surviving session
  const afterRestart = new BotDatabase(join(fsDir, 'web.db'));
  check('web sessions: survive a restart (new DB handle, same file)', afterRestart.loadWebSessions(now).length === 1 && afterRestart.loadWebSessions(now)[0]?.sid === 's3');
  afterRestart.close();
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
  check('leaderboard: user outside top gets extra row with real rank', outTop.includes('you extra') && outTop.includes('<span class="rank">42</span>') && outTop.includes('>Nine<') && outTop.includes('3.0%') && (outTop.match(/<li/g) ?? []).length === 5 && outTop.includes('class="gap"'));
  const noYou = leaderboard(rows, 16, mem, { userId: 'u9', rank: null });
  check('leaderboard: no extra row when user has no messages; no highlight', !noYou.includes('you') && (noYou.match(/<li/g) ?? []).length === 3 && !leaderboard(rows, 16, mem).includes('aria-current'));
  check('leaderboard: names escaped', inTop.includes('One &lt;b&gt;') && !inTop.includes('One <b>'));
  const lvlTop = leaderboard(rows, 16, mem, { userId: 'u9', rank: { rank: 42, messages: 3 } }, { u1: 650, u9: 242_000 });
  check(
    'leaderboard: level tags next to names, including the extra row',
    lvlTop.includes('<span class="nm">One &lt;b&gt;</span><span class="lvl">lvl 3 · 50/400</span>') &&
      lvlTop.includes('<span class="nm">Nine</span><span class="lvl">lvl 69 · 500/7,000</span>') &&
      (lvlTop.match(/class="lvl"/g) ?? []).length === 2,
  );
  check('medalFor: gold/silver/bronze for ranks 1-3, nothing else', medalFor(1) === '🥇' && medalFor(2) === '🥈' && medalFor(3) === '🥉' && medalFor(4) === null && medalFor(0) === null && medalFor(1.5) === null);
  check(
    'leaderboard: medals replace the numbers for the top 3',
    (inTop.match(/class="rank medal"/g) ?? []).length === 3 &&
      inTop.includes('aria-label="Rank 1"') &&
      inTop.includes('aria-hidden="true">🥇</span>') &&
      inTop.includes('aria-label="Rank 3"') &&
      !inTop.includes('<span class="rank">1</span>'),
  );
  const fourth = leaderboard([...rows, { userId: 'u4', messages: 0 }], 16, mem);
  check('leaderboard: rank 4 keeps a plain number', (fourth.match(/class="rank medal"/g) ?? []).length === 3 && fourth.includes('<span class="rank">4</span>'));
  const tabCur = weekTabs('current');
  check(
    'weekTabs: current selected, last is a link',
    tabCur.includes('<span class="tab" aria-current="page">This week</span>') &&
      tabCur.includes('<a class="tab" href="/dashboard?week=last#h-week">Last week</a>') &&
      (tabCur.match(/aria-current/g) ?? []).length === 1,
  );
  const tabLast = weekTabs('last');
  check(
    'weekTabs: last selected flips the highlight',
    tabLast.includes('<span class="tab" aria-current="page">Last week</span>') && tabLast.includes('<a class="tab" href="/dashboard?week=current#h-week">This week</a>'),
  );
  const emptyYou = youSection(
    { allRank: null, currentWeekRank: null, lastWeekRank: null, xp: null, stats: { userId: 'u9', messages: 0, firstTs: null, lastTs: null }, reactions: { given: 0, received: 0 }, voice: { totalMs: 0, sessions: 0 }, activityMs: 0, topActivities: [], topVoice: [], emojiGiven: [], emojiReceived: [], nowPlaying: [], inVoice: null },
    { total: 10, timezone: 'UTC', channelNames: {}, username: 'Nine' },
  );
  check('youSection: empty state', emptyYou.includes('id="h-you"') && emptyYou.includes('No tracked activity'));
  const youLvl = youSection(
    {
      allRank: { rank: 3, messages: 7 }, currentWeekRank: null, lastWeekRank: null, xp: 242_000, roleColor: '#5865f2',
      stats: { userId: 'u9', messages: 7, firstTs: 1_000, lastTs: 2_000 },
      reactions: { given: 2, received: 1 }, voice: { totalMs: 60_000, sessions: 1 }, activityMs: 0, topActivities: [], topVoice: [], emojiGiven: [], emojiReceived: [], nowPlaying: [], inVoice: null,
    },
    { total: 100, timezone: 'UTC', channelNames: {}, username: 'Nine' },
  );
  check(
    'youSection: level row with role-colored rounded progress bar',
    youLvl.includes('<div class="levelrow">') &&
      youLvl.includes('<span>Level</span><b>69</b>') &&
      youLvl.includes('500 / 7,000 XP') &&
      youLvl.includes('role="progressbar"') &&
      youLvl.includes('aria-valuenow="500"') &&
      youLvl.includes('aria-valuemax="7000"') &&
      youLvl.includes('width:7.1%;background:#5865f2') &&
      youLvl.indexOf('Level') < youLvl.indexOf('500 / 7,000 XP') &&
      youLvl.indexOf('Activity time') > youLvl.indexOf('Messages, last week') &&
      youLvl.indexOf('Activity time') < youLvl.indexOf('Reactions given') &&
      !youLvl.includes('lvl 69') &&
      !emptyYou.includes('levelrow'),
  );
  const youNoColor = youSection(
    {
      allRank: null, currentWeekRank: null, lastWeekRank: null, xp: 242_000, roleColor: null,
      stats: { userId: 'u9', messages: 7, firstTs: 1_000, lastTs: 2_000 },
      reactions: { given: 0, received: 0 }, voice: { totalMs: 0, sessions: 0 }, activityMs: 0, topActivities: [], topVoice: [], emojiGiven: [], emojiReceived: [], nowPlaying: [], inVoice: null,
    },
    { total: 100, timezone: 'UTC', channelNames: {}, username: 'Nine' },
  );
  check('youSection: level bar falls back to the accent color', youNoColor.includes('<i style="width:7.1%"></i>'));
  const youNoXp = youSection(
    {
      allRank: null, currentWeekRank: null, lastWeekRank: null, xp: null, roleColor: '#5865f2',
      stats: { userId: 'u9', messages: 7, firstTs: 1_000, lastTs: 2_000 },
      reactions: { given: 0, received: 0 }, voice: { totalMs: 0, sessions: 0 }, activityMs: 0, topActivities: [], topVoice: [], emojiGiven: [], emojiReceived: [], nowPlaying: [], inVoice: null,
    },
    { total: 100, timezone: 'UTC', channelNames: {}, username: 'Nine' },
  );
  check('youSection: no level row without xp', !youNoXp.includes('levelrow') && !youNoXp.includes('progressbar'));

  // ---- dashboard shell, settings page, favicon, deployment pill ----
  const T = 1_800_000_000_000;
  const emptyYouData = { allRank: null, currentWeekRank: null, lastWeekRank: null, xp: null, stats: { userId: 'u2', messages: 0, firstTs: null, lastTs: null }, reactions: { given: 0, received: 0 }, voice: { totalMs: 0, sessions: 0 }, activityMs: 0, topActivities: [], topVoice: [], emojiGiven: [], emojiReceived: [], nowPlaying: [], inVoice: null };
  const ovData: OverviewData = {
    timezone: 'UTC',
    botStatus: { ping: 42, uptimeSec: 3700, guilds: 1, totalMessages: 16, dbBytes: 1024 * 1024, lastWeeklySent: null, embedsConverted: 3, errors24h: 2 },
    deploy: { ok: true, state: 'running', title: 'Ship <it>', startedAt: T - 60_000, finishedAt: null },
    today: 4,
    week: { selected: 'current', current: { bounds: currentWeekBounds('UTC'), total: 16, rows }, last: { bounds: lastWeekBounds('UTC'), total: 0, rows: [] } },
    allTime: { total: 16, rows },
    reactions: { total: 0, top: [] },
    recentEmbeds: [{ id: 1, guildId: G, channelId: 'c1', messageId: 'm', url: 'https://x.test/a?b="c"', provider: 'twitter', ts: T }],
    embedPage: { page: 2, pages: 3, total: 21, pageSize: 10 },
    members: mem,
    channelNames: { c1: 'general' },
    xpByUser: {},
    user: { id: 'u2', username: 'Two', avatar: null },
    you: emptyYouData,
  };
  const ovHtml = dashboardPage(ovData, T);
  const ovParts = overviewParts(ovData, T);
  check(
    'dashboardPage: shell with skip link, one h1, nav with the active page, favicon + theme-color',
    ovHtml.includes('<a class="skip" href="#main">') &&
      (ovHtml.match(/<h1/g) ?? []).length === 1 &&
      ovHtml.includes('<nav class="nav" aria-label="Main">') &&
      ovHtml.includes('<a href="/dashboard" aria-current="page">') &&
      ovHtml.includes('<a href="/dashboard/settings">') &&
      ovHtml.includes('<a href="/dashboard/requests">') &&
      ovHtml.includes('<a href="/dashboard/logs">') &&
      ovHtml.includes('<link rel="icon" href="/bot-avatar">') &&
      (ovHtml.match(/<meta name="theme-color"/g) ?? []).length === 2 &&
      ovHtml.includes('viewport-fit=cover') &&
      ovHtml.includes('<main class="main" id="main" data-live="overview">') &&
      ovHtml.includes(LIVE_SCRIPT) &&
      ovHtml.includes('<div class="sky" aria-hidden="true"></div>') &&
      ovHtml.includes(`url("${CLOUDS_URL}")`) &&
      ovHtml.includes('image-rendering: pixelated') &&
      ovHtml.includes('<div class="pagehead"><div class="pagehead-top"><h1>Overview</h1><span class="livestat" id="livestat"'),
  );
  check(
    'dashboardPage: every live region holds exactly what overviewParts renders',
    Object.keys(ovParts).sort().join() === 'live-all,live-deploy,live-health,live-kpis,live-react,live-week,live-you' && Object.entries(ovParts).every(([id, html]) => new RegExp(`id="${id}"[^>]*>`).test(ovHtml) && ovHtml.includes(`>${html}</div>`)),
  );
  check(
    'dashboardPage: no settings forms; embed table with data-labels, escaped url and pager links',
    !ovHtml.includes('<form') &&
      !ovHtml.includes('name="weeklyEnabled"') &&
      ovHtml.includes('<td class="url" data-label="URL"><a href="https://x.test/a?b=&quot;c&quot;"') &&
      ovHtml.includes('href="/dashboard#h-embeds"') &&
      ovHtml.includes('href="/dashboard?embedsPage=3#h-embeds"') &&
      ovHtml.includes('#general'),
  );
  const health = healthPills(ovData.botStatus, ovData.deploy, T);
  check(
    'healthPills: online, deployment, errors link, uptime, db size, weekly',
    health.includes('Online · 42 ms') && health.includes('Deploying') && health.includes('<a class="pill err" href="/dashboard/logs?level=error">') && health.includes('2 errors in 24h') && health.includes('Up 1h 1m') && health.includes('Database 1.00 MB') && health.includes('last sent never') &&
      healthPills({ ...ovData.botStatus, ping: -1, errors24h: 0 }, null, T).includes('Connecting…') && !healthPills({ ...ovData.botStatus, errors24h: 0 }, null, T).includes('pill err'),
  );
  check('fmtAgo: just now / minutes / hours / days', fmtAgo(T - 5_000, T) === 'just now' && fmtAgo(T - 5 * 60_000, T) === '5 min ago' && fmtAgo(T - 3 * 3_600_000, T) === '3 h ago' && fmtAgo(T - 49 * 3_600_000, T) === '2 d ago' && fmtAgo(T + 5_000, T) === 'just now');
  const pillRun = deployPill({ ok: true, state: 'running', title: 'Ship <it>', startedAt: T - 60_000, finishedAt: null }, T);
  const pillDone = deployPill({ ok: true, state: 'done', title: 'v2', startedAt: T - 600_000, finishedAt: T - 300_000 }, T);
  const pillErr = deployPill({ ok: true, state: 'error', title: null, startedAt: null, finishedAt: null }, T);
  const pillDown = deployPill({ ok: false, error: 'HTTP 500' }, T);
  check('deployPill: running is amber + pulsing, title escaped, full text in the title attr', pillRun.includes('class="pill warn"') && pillRun.includes('dot pulse') && pillRun.includes('title="Deploying · Ship &lt;it&gt;"') && pillRun.includes('<span class="trunc">Ship &lt;it&gt;</span>') && !pillRun.includes('<it>'));
  check('deployPill: done is green with a relative time', pillDone.includes('class="pill ok"') && pillDone.includes('Deployed 5 min ago') && pillDone.includes('>v2</span>') && !pillDone.includes('pulse'));
  check('deployPill: error is red, unreachable is muted, unconfigured is hidden', pillErr.includes('class="pill err"') && pillErr.includes('Deploy failed') && pillDown.includes('class="pill off"') && pillDown.includes('Deploy status unavailable') && !pillDown.includes('HTTP 500') && deployPill(null, T) === '' && deployPill(undefined, T) === '');
  check('deployPill: unknown state reads as unavailable; compact drops the title', deployPill({ ok: true, state: 'unknown', title: 'x', startedAt: null, finishedAt: null }, T).includes('Deploy status unavailable') && !deployPill({ ok: true, state: 'running', title: 'Ship', startedAt: null, finishedAt: null }, T, true).includes('class="trunc"'));
  check('chromeParts: deploy chip only when configured', Object.keys(chromeParts(null, T)).length === 0 && chromeParts({ ok: false, error: 'x' }, T)['live-deploy']!.includes('Deploy status unavailable') && !dashboardPage({ ...ovData, deploy: null }, T).includes('id="live-deploy"'));

  const setData: SettingsPageData = {
    settings: { guildId: G, statsChannelId: 'c2', weeklyEnabled: true, weeklyDay: 3, weeklyHour: 18, timezone: 'Europe/Ljubljana', embedChannels: ['c1'], levelingEnabled: false, levelupChannelId: null },
    channels: [{ id: 'c1', name: 'general' }, { id: 'c2', name: 'bots <b>' }],
    user: { username: 'Two', avatar: null },
    deploy: null,
    saved: true,
    weeklyFlash: null,
    free: { settings: { guildId: G, channelId: 'c1', pingRoleId: 'r1', stores: ['steam'], includeDlc: false, includeBeta: true, includeMobile: false }, roles: [{ id: 'r1', name: 'Gamers' }], webhookEnabled: false, postedCount: 3, flash: null },
    color: { channelId: 'c2', roles: [{ id: 'r1', name: 'Gamers' }, { id: 'cr1', name: 'Red <x>' }], selected: ['cr1'], posted: 1, canManage: true, flash: null },
    builder: {
      settings: { enabled: true, model: 'opencode-go/m"1', chatEnabled: false, chatModel: 'opencode-go/c', chatDecisionModel: 'opencode-go/d', chatLanguages: ['Slovenian', 'English'], maxParallelBuilds: 2, limitThreshold: 90 },
      passwordSet: true,
      agent: { reachable: true, version: '2.4.1', error: null, limits: { rolling: { percent: 12.4, limited: false, resetsAt: T }, weekly: { percent: 80, limited: false, resetsAt: T }, monthly: { percent: 97, limited: true, resetsAt: T } } },
      flash: null,
    },
  };
  const setHtmlV = settingsPage(setData, T);
  const formOf = (action: string): string => setHtmlV.slice(setHtmlV.indexOf(`action="${action}"`), setHtmlV.indexOf('</form>', setHtmlV.indexOf(`action="${action}"`)));
  const general = formOf('/settings');
  const freeForm = formOf('/free-settings');
  const aiForm = formOf('/builder-settings');
  check(
    'settingsPage: general form keeps every field name and value',
    general.includes('name="weeklyEnabled" value="1" checked') &&
      general.includes('<select id="statsChannel" name="statsChannel"') &&
      general.includes('<option value="c2" selected>#bots &lt;b&gt;</option>') &&
      general.includes('name="weeklyDay"') && general.includes('<option value="3" selected>Wednesday</option>') &&
      general.includes('name="weeklyHour"') && general.includes('<option value="18" selected>18:00</option>') &&
      general.includes('name="timezone" value="Europe/Ljubljana"') &&
      general.includes('<input type="checkbox" name="embedChannels" value="c1" checked><span>#general</span>') &&
      general.includes('<input type="checkbox" name="embedChannels" value="c2"><span>#bots &lt;b&gt;</span>') &&
      general.includes('name="levelingEnabled" value="1">') &&
      general.includes('<select id="levelupChannel" name="levelupChannel"') && general.includes('<option value="">— silent —</option>') &&
      (general.match(/type="submit"/g) ?? []).length === 2 &&
      general.includes('form="send-now-form"') && general.includes('confirm(') &&
      setHtmlV.includes('<form id="send-now-form" method="post" action="/weekly/send-now"></form>') &&
      !general.includes('name="stores"') && !general.includes('name="chatModel"'),
  );
  check(
    'settingsPage: weekly, embeds and leveling are separate cards inside the one general form',
    ['id="weekly"', 'id="embeds"', 'id="leveling"'].every((id) => general.includes(`<section class="card" ${id}`)) && (general.match(/<section class="card"/g) ?? []).length === 3,
  );
  check(
    'settingsPage: free games form keeps its field names',
    freeForm.includes('<select id="freeChannel" name="channel"') && freeForm.includes('<option value="c1" selected>#general</option>') &&
      freeForm.includes('<select id="freeRole" name="pingRole"') && freeForm.includes('<option value="r1" selected>@Gamers</option>') &&
      ALL_STORES.every((st) => freeForm.includes(`name="stores" value="${st}"`)) && freeForm.includes('name="stores" value="steam" checked') && !freeForm.includes('name="stores" value="epic" checked') &&
      freeForm.includes('name="includeDlc" value="1">') && freeForm.includes('name="includeBeta" value="1" checked>') && freeForm.includes('name="includeMobile" value="1">') &&
      (freeForm.match(/type="submit"/g) ?? []).length === 1 && setHtmlV.includes('FreeStuff webhook disabled (set FREESTUFF_PUBLIC_KEY)') && setHtmlV.includes('3 recorded as announced'),
  );
  const colorForm = formOf('/color-settings');
  check(
    'settingsPage: name colour form keeps channel and role chips, status sits above it',
    colorForm.includes('<select id="colorChannel" name="channel"') && colorForm.includes('<option value="c2" selected>#bots &lt;b&gt;</option>') &&
      colorForm.includes('name="colorRoles" value="cr1" checked><span>@Red &lt;x&gt;</span>') && colorForm.includes('name="colorRoles" value="r1"><span>@Gamers</span>') &&
      setHtmlV.includes('Manage Roles granted') && setHtmlV.includes('1 of 1 messages posted') && !colorForm.includes('@Red <x>'),
  );
  check(
    'settingsPage: AI assistant form keeps its field names, escapes values, shows limit meters',
    aiForm.includes('name="chatEnabled" value="1">') && aiForm.includes('name="enabled" value="1" checked>') &&
      aiForm.includes('name="chatModel" value="opencode-go/c"') && aiForm.includes('name="chatDecisionModel" value="opencode-go/d"') &&
      aiForm.includes('name="chatLanguages" value="Slovenian, English"') && aiForm.includes('name="model" value="opencode-go/m&quot;1"') &&
      aiForm.includes('<input type="number" id="maxParallelBuilds" name="maxParallelBuilds" min="1" max="5" step="1"') && aiForm.includes('value="2"') &&
      aiForm.includes('<input type="number" id="limitThreshold" name="limitThreshold" min="50" max="100" step="1"') && aiForm.includes('value="90"') &&
      (aiForm.match(/class="meter"/g) ?? []).length === 3 && aiForm.includes('97% (limited)') && aiForm.includes('style="width:12%"') && aiForm.includes('left:90%') &&
      setHtmlV.includes('Agent server reachable (v2.4.1)') && setHtmlV.includes('OPENCODE_PASSWORD set'),
  );
  check(
    'settingsPage: section nav, labels tied to inputs, flash, no live polling without Dokploy',
    setHtmlV.includes('<nav class="secnav" aria-label="Settings sections">') &&
      ['weekly', 'embeds', 'leveling', 'colors', 'free', 'builder'].every((id) => setHtmlV.includes(`<a href="#${id}">`) && setHtmlV.includes(` id="${id}"`)) &&
      ['statsChannel', 'timezone', 'levelupChannel', 'freeChannel', 'freeRole', 'chatModel', 'chatDecisionModel', 'chatLanguages', 'builderModel', 'maxParallelBuilds', 'limitThreshold'].every((id) => setHtmlV.includes(`<label for="${id}">`) && setHtmlV.includes(` id="${id}"`)) &&
      setHtmlV.includes('<div class="flash" role="status">Settings saved.</div>') && setHtmlV.includes("searchParams.delete('saved')") &&
      setHtmlV.includes('<a href="/dashboard/settings" aria-current="page">') && (setHtmlV.match(/<h1/g) ?? []).length === 1 &&
      !setHtmlV.includes('data-live=') && !setHtmlV.includes(LIVE_SCRIPT) && !setHtmlV.includes('id="livestat"'),
  );
  const setDeploy = settingsPage({ ...setData, saved: false, deploy: { ok: true, state: 'done', title: 'v2', startedAt: T - 120_000, finishedAt: T - 60_000 }, builder: { ...setData.builder, flash: { kind: 'error', reason: 'bad <model>' } } }, T);
  check('settingsPage: with Dokploy only the deployment chip is live; builder error flash is escaped', setDeploy.includes('data-live="settings"') && setDeploy.includes('id="live-deploy"') && !setDeploy.includes('id="livestat"') && setDeploy.includes('Deployed 1 min ago') && setDeploy.includes('<div class="flash" role="alert">bad &lt;model&gt;</div>') && !setDeploy.includes('Settings saved.'));
  const bsec = builderSection({ builder: { ...setData.builder, passwordSet: false, agent: null }, settings: setData.settings });
  check('builderSection: standalone card with its own form; no meters without limits', bsec.startsWith('<section class="card" id="builder"') && bsec.includes('action="/builder-settings"') && bsec.includes('OPENCODE_PASSWORD not set') && bsec.includes('Agent server not checked') && !bsec.includes('class="meter"'));

  const logsHtml = logsPage({ rows: [{ id: 1, ts: T, level: 'error', tag: 'web', message: 'boom <x>\n  at y' }, { id: 2, ts: T, level: 'info', tag: null, message: 'ok' }], tags: ['web', 'bot'], level: 'error', tag: 'web', page: 1, pages: 1, pageSize: 10, total: 2, timezone: 'UTC', user: { username: 'Two', avatar: null } }, T);
  check(
    'logsPage: segmented level control, tag select, stacked-table labels, escaped message',
    logsHtml.includes('<nav class="seg" aria-label="Level">') && logsHtml.includes('<a aria-current="page" href="/dashboard/logs?level=error&amp;tag=web">Errors</a>') && logsHtml.includes('<a href="/dashboard/logs?tag=web">All</a>') &&
      logsHtml.includes('<input type="hidden" name="level" value="error">') && logsHtml.includes('<option value="web" selected>[web]</option>') &&
      logsHtml.includes('<td class="logmsg" data-label="Message"><pre>boom &lt;x&gt;\n  at y</pre></td>') && logsHtml.includes('<span class="badge error">error</span>') && logsHtml.includes('<span class="badge ">info</span>') &&
      logsHtml.includes('data-live="logs"') && logsHtml.includes('1–2 of 2') && logsHtml.includes('<a href="/dashboard/logs" aria-current="page">'),
  );
  check('logsParts: empty state', logsParts({ rows: [], tags: [], level: 'all', tag: null, page: 1, pages: 1, pageSize: 50, total: 0, timezone: 'UTC', user: { username: 'x', avatar: null } }, T)['live-logs']!.includes('No log entries match.'));
  const lrow = { id: 1, ts: T, level: 'info' as const, tag: null, message: 'm' };
  const lp = logsParts({ rows: [lrow], tags: ['web'], level: 'warn', tag: 'web&x', page: 2, pages: 3, pageSize: 50, total: 120, timezone: 'UTC', user: { username: 'x', avatar: null } }, T);
  check(
    'logsParts: pager in the live region keeps level, tag and page; range in the sub text',
    lp['live-logs']!.includes('<a class="pager-btn" href="/dashboard/logs?level=warn&amp;tag=web%26x&amp;size=50#h-logs">Previous</a>') && lp['live-logs']!.includes('href="/dashboard/logs?level=warn&amp;tag=web%26x&amp;page=3&amp;size=50#h-logs">Next</a>') && lp['live-logs']!.includes('Page 2 of 3') && lp['live-logcount'] === '51–51 of 120',
  );
  check('logsParts: single page still shows the Showing summary', logsParts({ rows: [lrow], tags: [], level: 'all', tag: null, page: 1, pages: 1, pageSize: 50, total: 1, timezone: 'UTC', user: { username: 'x', avatar: null } }, T)['live-logs']!.includes('Showing 1–1 of 1'));
  check('logsPage: level tabs and tag form carry no page param', !logsPage({ rows: [lrow], tags: ['web'], level: 'warn', tag: 'web', page: 2, pages: 3, pageSize: 50, total: 120, timezone: 'UTC', user: { username: 'x', avatar: null } }, T).match(/<nav class="seg"[^]*?<\/nav>/)![0].includes('page='));

  // pager helper
  const pg = (page: number, pages: number): string => pagerHtml({ page, pages, summary: 'S <b>', href: (p) => `/x?a=1&page=${p}`, label: 'L' });
  check('pagerHtml: single page shows nothing (or only the summary with showSingle)', pg(1, 1) === '' && pagerHtml({ page: 1, pages: 1, summary: 'S', href: () => '/', label: 'L', showSingle: true }) === '<div class="pager"><p class="muted">S</p></div>');
  check('pagerHtml: first page disables Previous', pg(1, 3).includes('<span class="pager-btn" aria-disabled="true">Previous</span>') && pg(1, 3).includes('href="/x?a=1&amp;page=2">Next</a>') && pg(1, 3).includes('Page 1 of 3'));
  check('pagerHtml: middle page links both ways', pg(2, 3).includes('href="/x?a=1&amp;page=1">Previous</a>') && pg(2, 3).includes('href="/x?a=1&amp;page=3">Next</a>'));
  check('pagerHtml: last page disables Next; summary escaped', pg(3, 3).includes('<span class="pager-btn" aria-disabled="true">Next</span>') && pg(3, 3).includes('S &lt;b&gt;') && !pg(3, 3).includes('<b>'));
  check('rangeSummary', rangeSummary(1, 50, 50, 1234) === '1–50 of 1,234' && rangeSummary(1, 50, 0, 0) === '0');

  // logs paging in the db
  const ldb = new BotDatabase(join(mkdtempSync(join(tmpdir(), 'bojan-logs-')), 'logs.db'));
  for (let i = 1; i <= 7; i++) ldb.addLog({ ts: i, level: i % 3 === 0 ? 'error' : i % 2 === 0 ? 'warn' : 'info', tag: i <= 4 ? 'web' : 'bot', message: `m${i}` });
  check('recentLogs: offset pages newest first, default offset 0', ldb.recentLogs({ limit: 3 }).map((r) => r.message).join() === 'm7,m6,m5' && ldb.recentLogs({ limit: 3, offset: 3 }).map((r) => r.message).join() === 'm4,m3,m2' && ldb.recentLogs({ limit: 3, offset: 6 }).map((r) => r.message).join() === 'm1');
  check('countLogs: same level/tag filter as recentLogs', ldb.countLogs() === 7 && ldb.countLogs({ level: 'error' }) === 2 && ldb.countLogs({ level: 'warn' }) === 4 && ldb.countLogs({ tag: 'web' }) === 4 && ldb.countLogs({ level: 'error', tag: 'web' }) === 1 && ldb.recentLogs({ limit: 10, offset: 1, level: 'warn', tag: 'web' }).map((r) => r.message).join() === 'm3,m2');
  ldb.close();

  const fav = faviconSvg();
  check(
    'faviconSvg: standalone svg, cloud glyph on a royal-blue tile, no script or external refs; same mark in the shell',
    fav.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && fav.endsWith('</svg>') && fav.includes('viewBox="0 0 32 32"') && fav.includes('<rect width="32" height="32" rx="8" fill="#2b5ce6"/>') && (fav.match(/<circle /g) ?? []).length >= 3 && !fav.includes('crispEdges') && !/<script|href=|https?:\/\/(?!www\.w3\.org)/.test(fav) && fav === faviconSvg() && ovHtml.includes('<img class="mark" src="/bot-avatar" width="28" height="28" alt="">'),
  );
  const loginHtml = loginPage('https://discord.com/oauth2/authorize?a=1&b="2"');
  check('loginPage / errorPage: auth card on the cloud background, escaped, no chrome or polling', loginHtml.includes('class="sky"') && loginHtml.includes(CLOUDS_URL) && loginHtml.includes('<img class="mark" src="/bot-avatar" width="56" height="56" alt="">') && loginHtml.includes('href="https://discord.com/oauth2/authorize?a=1&amp;b=&quot;2&quot;"') && !loginHtml.includes('class="chrome"') && !loginHtml.includes(LIVE_SCRIPT) && errorPage('no <b>').includes('no &lt;b&gt;') && errorPage('x').includes('href="/login"'));
  check('LIVE_SCRIPT: polls the live endpoint, handles 401 and failures, safe to inline', LIVE_SCRIPT.includes("'/dashboard/live?'") && LIVE_SCRIPT.includes('15000') && LIVE_SCRIPT.includes('r.status===401') && LIVE_SCRIPT.includes('Reconnecting') && LIVE_SCRIPT.includes('Session expired') && LIVE_SCRIPT.includes('visibilitychange') && !LIVE_SCRIPT.includes('</script'));

  // ---- Dokploy deployment summary ----
  const dep = (o: Record<string, unknown>): Record<string, unknown> => ({ deploymentId: 'd', title: 'Deploy', status: 'done', createdAt: '2026-11-20T10:00:00.000Z', startedAt: '2026-11-20T10:00:01.000Z', finishedAt: '2026-11-20T10:02:00.000Z', ...o });
  const sRun = summarizeDeployments([dep({ title: 'new one', status: 'running', createdAt: '2026-11-24T08:00:00.000Z', startedAt: '2026-11-24T08:00:02.000Z', finishedAt: null }), dep({})]);
  check('summarizeDeployments: running', sRun.state === 'running' && sRun.title === 'new one' && sRun.startedAt === Date.parse('2026-11-24T08:00:02.000Z') && sRun.finishedAt === null);
  const sDone = summarizeDeployments([dep({ title: '  Manual deployment ' })]);
  check('summarizeDeployments: done, title trimmed, ISO dates -> ms', sDone.state === 'done' && sDone.title === 'Manual deployment' && sDone.startedAt === Date.parse('2026-11-20T10:00:01.000Z') && sDone.finishedAt === Date.parse('2026-11-20T10:02:00.000Z'));
  const sErr = summarizeDeployments([dep({ status: 'error', title: '', description: 'Commit: abc', startedAt: null, finishedAt: null })]);
  check('summarizeDeployments: error; falls back to description and createdAt', sErr.state === 'error' && sErr.title === 'Commit: abc' && sErr.startedAt === Date.parse('2026-11-20T10:00:00.000Z') && sErr.finishedAt === null);
  const unknownSummary = JSON.stringify({ state: 'unknown', title: null, startedAt: null, finishedAt: null });
  check('summarizeDeployments: empty list', JSON.stringify(summarizeDeployments([])) === unknownSummary);
  check(
    'summarizeDeployments: garbage input never throws',
    [null, undefined, 42, 'nope', {}, { data: 'x' }, [null, 3, 'a', []], { message: 'Unauthorized' }].every((x) => JSON.stringify(summarizeDeployments(x)) === unknownSummary) &&
      summarizeDeployments([{ status: 7, title: 9, createdAt: 'not a date', startedAt: {}, finishedAt: [] }]).state === 'unknown' &&
      summarizeDeployments([{ status: 'DONE', title: null }]).state === 'done' && summarizeDeployments([{ status: 'DONE', title: null }]).title === null,
  );
  const older = dep({ title: 'older', status: 'error', createdAt: '2026-11-01T00:00:00.000Z' });
  const newer = dep({ title: 'newer', status: 'done', createdAt: '2026-11-22T00:00:00.000Z' });
  check('summarizeDeployments: newest createdAt wins regardless of order', summarizeDeployments([older, newer]).title === 'newer' && summarizeDeployments([newer, older]).title === 'newer' && summarizeDeployments([older, newer]).state === 'done');
  check('summarizeDeployments: undated rows keep the API order (newest first)', summarizeDeployments([{ status: 'running', title: 'first' }, { status: 'done', title: 'second' }]).title === 'first');
  const cancelled = dep({ title: 'cancelled one', status: 'cancelled', createdAt: '2026-11-23T00:00:00.000Z' });
  check('summarizeDeployments: a cancelled newest deployment is skipped; all cancelled -> unknown', summarizeDeployments([cancelled, newer, older]).title === 'newer' && JSON.stringify(summarizeDeployments([cancelled])) === unknownSummary);
  check('summarizeDeployments: queued counts as in progress, idle is unknown', summarizeDeployments([dep({ status: 'queued' })]).state === 'running' && summarizeDeployments([dep({ status: 'idle' })]).state === 'unknown');
  check('summarizeDeployments: wrapper objects', summarizeDeployments({ deployments: [newer] }).title === 'newer' && summarizeDeployments({ result: { data: { json: [older] } } }).state === 'error' && summarizeDeployments({ data: [newer, older] }).state === 'done');
  const dkOff = { url: 'https://d.test', apiKey: null, composeId: 'c' };
  const dkRes = await fetchDeployments(dkOff);
  check('dokploy: all three settings are required; unconfigured fetch fails without a request', !dokployEnabled(dkOff) && !dokployEnabled({ url: null, apiKey: 'k', composeId: 'c' }) && dokployEnabled({ url: 'https://d.test', apiKey: 'k', composeId: 'c' }) && !dkRes.ok && dkRes.error === 'not configured');
}

// ---- self-building (builder) ---------------------------------------------
{
  const json = (o: unknown): string => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
  const r1 = parseAgentReply(`Looks good.\n\n${json({ status: 'approved', title: 'T', plan: 'line1\nline2 "q"', questions: [] })}\n\n  \n`);
  check('parseAgentReply: visible text + json with escaped newlines/quotes', r1.visible === 'Looks good.' && r1.result?.status === 'approved' && r1.result?.plan === 'line1\nline2 "q"');
  const r2 = parseAgentReply('Just text, no block.  \n');
  check('parseAgentReply: missing block', r2.visible === 'Just text, no block.' && r2.result === null);
  const r3 = parseAgentReply('Hi\n```json\n{not valid}\n```');
  check('parseAgentReply: invalid JSON', r3.visible === 'Hi' && r3.result === null);
  const r4 = parseAgentReply(`a\n${json({ status: 'needs_input' })}\nb\n${json({ status: 'approved' })}`);
  check('parseAgentReply: last block wins', r4.result?.status === 'approved' && r4.visible.includes('b'));
  check('parseAgentReply: crlf + empty input', parseAgentReply('x\r\n```json\r\n{"a":1}\r\n```\r\n').result?.a === 1 && parseAgentReply('').result === null);
  check('parseAgentReply: non-object json ignored', parseAgentReply('x\n```json\n[1,2]\n```').result === null);

  const plan = normalizePlanResult({ status: 'needs_input', title: ' T ', plan: 'p', questions: ['a', '', 5, ' b '] });
  check('normalizePlanResult', plan?.title === 'T' && plan.questions.join('|') === 'a|b' && normalizePlanResult({ status: 'nope' }) === null && normalizePlanResult(null) === null);
  const bOk = normalizeBuildResult({ status: 'pr_opened', pr_url: 'https://github.com/timrekelj/bojan/pull/12', summary: ' done ' });
  check('normalizeBuildResult: pr_opened', bOk?.status === 'pr_opened' && bOk.summary === 'done');
  check('normalizeBuildResult: failed / invalid', normalizeBuildResult({ status: 'failed', reason: 'x' })?.status === 'failed' && normalizeBuildResult({ status: 'pr_opened', pr_url: 'nope' }) === null && normalizeBuildResult({ status: 'x' }) === null);

  check('branchName/worktreeDirFor', branchName(7) === 'bot/7' && worktreeDirFor(7) === '/workspace/jobs/7');
  const pr = parsePrUrl('https://github.com/timrekelj/bojan/pull/34');
  check('parsePrUrl: valid', pr?.owner === 'timrekelj' && pr.repo === 'bojan' && pr.number === 34 && parsePrUrl('https://github.com/a/b/pull/5/files')?.number === 5);
  check('parsePrUrl: invalid', parsePrUrl('https://github.com/a/b/issues/5') === null && parsePrUrl('http://github.com/a/b/pull/5') === null && parsePrUrl('') === null);
  const mr = parseModelRef('opencode-go/glm-5.3');
  check('parseModelRef', mr?.providerID === 'opencode-go' && mr.id === 'glm-5.3' && parseModelRef('a/b/c')?.id === 'b/c' && parseModelRef('nope') === null && parseModelRef('/x') === null && parseModelRef('x/') === null);
  check('stripBotMention', stripBotMention('<@123> do it', '123') === 'do it' && stripBotMention('do it <@!123>', '123') === 'do it' && stripBotMention('<@456> x', '123') === '<@456> x');
  check('formatTokens/formatCost/formatUsage', formatTokens(950) === '950' && formatTokens(1500) === '1.5k' && formatTokens(25_400) === '25k' && formatTokens(2_300_000) === '2.3M' && formatCost(0.01234) === '$0.0123' && formatUsage({ input: 1200, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 }) === '1.2k in · 300 out · $0.5000');
  check('isAdminLike', isAdminLike(true, [], null) && isAdminLike(false, ['r1'], 'r1') && !isAdminLike(false, ['r2'], 'r1') && !isAdminLike(false, ['r1'], null));
  check('prStateFromJson', prStateFromJson({ state: 'closed', merged: true }) === 'merged' && prStateFromJson({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' }) === 'merged' && prStateFromJson({ state: 'closed', merged: false }) === 'closed' && prStateFromJson({ state: 'open' }) === 'open');

  const reply = extractReply([
    { id: 'm2', type: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'one' }, { type: 'text', text: 'two' }], finish: 'stop' },
    { id: 'm1', type: 'assistant', content: [{ type: 'text', text: 'old' }] },
  ]);
  check('extractReply: newest assistant text parts', reply.id === 'm2' && reply.text === 'one\ntwo' && reply.finish === 'stop' && reply.error === null);
  const errReply = extractReply([{ id: 'm3', type: 'assistant', content: [], finish: 'error', error: { type: 'auth', message: 'bad key' } }]);
  check('extractReply: surfaces error; empty list', errReply.error === 'auth: bad key' && extractReply([]).id === null);

  const textLen = (m: BuilderMessage): number =>
    m.components.reduce((n, c) => n + c.components.reduce((k, t) => k + ((t as unknown as { data: { content?: string } }).data.content?.length ?? 0), 0), 0);
  const huge = 'word '.repeat(3000);
  const usage = { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 };
  const cards: [string, BuilderMessage][] = [
    ['plan', buildPlanCard({ title: 'T'.repeat(150), plan: huge, questions: Array.from({ length: 20 }, () => 'q'.repeat(300)) })],
    ['note', buildNoteCard(huge)],
    ['building', buildBuildingCard('Title')],
    ['pr', buildPrOpenedCard({ title: 'T', prUrl: 'https://github.com/a/b/pull/1', summary: huge, usage })],
    ['merged', buildMergedCard({ title: 'T', prUrl: 'https://github.com/a/b/pull/1', usage })],
    ['closed', buildClosedCard({ title: 'T', prUrl: 'https://github.com/a/b/pull/1', usage })],
    ['failed', buildFailedCard({ reason: huge, usage })],
    ['cancelled', buildCancelledCard(usage)],
    ['queued', buildQueuedCard({ title: 'T', position: 2 })],
    ['resuming', buildResumingCard('T')],
    ['conflict fix', buildConflictFixCard('T')],
    ['conflict fixed', buildConflictFixedCard({ title: 'T', prUrl: 'https://github.com/a/b/pull/1' })],
    ['conflict manual', buildConflictManualCard({ title: 'T', prUrl: 'https://github.com/a/b/pull/1', reason: huge })],
  ];
  for (const [name, card] of cards) {
    check(`builder card "${name}" stays under 4000 chars, no mentions, V2`, textLen(card) > 0 && textLen(card) < 4000 && (card.allowedMentions.parse as string[]).length === 0 && card.flags === MessageFlags.IsComponentsV2, String(textLen(card)));
  }
  const planCard = buildPlanCard({ title: 'My title', plan: huge, questions: ['first?', 'second?'] });
  const planJson = JSON.stringify(planCard.components[0]!.toJSON());
  check('plan card keeps heading, numbered questions and footer when trimming', planJson.includes('### My title') && planJson.includes('1. first?') && planJson.includes('2. second?') && planJson.includes('Reply in this thread'));
  const prJson = JSON.stringify(cards[3]![1].components[0]!.toJSON());
  check('PR card has link and usage line', prJson.includes('pull/1') && prJson.includes('$0.0100'));

  // DB: build_jobs + settings
  const bdb = new BotDatabase(join(mkdtempSync(join(tmpdir(), 'bojan-builder-')), 'b.db'));
  check('builder settings defaults', !bdb.getBuilderSettings().enabled && bdb.getBuilderSettings().model === 'opencode-go/glm-5.3' && !bdb.getBuilderSettings().chatEnabled && bdb.getBuilderSettings().chatModel === 'opencode-go/glm-5.3-flash' && bdb.getBuilderSettings().chatLanguages.length === 0);
  bdb.setBuilderSettings({ enabled: true, model: ' prov/model ', chatEnabled: true, chatModel: ' p/chat ', chatDecisionModel: ' p/decide ', chatLanguages: ['Slovenian', 'English'], maxParallelBuilds: 3, limitThreshold: 95 });
  check('decision model setting: default, roundtrip', new BotDatabase(join(mkdtempSync(join(tmpdir(), 'bojan-dm-')), 'd.db')).getBuilderSettings().chatDecisionModel === 'opencode-go/jev-1.14' && bdb.getBuilderSettings().chatDecisionModel === 'p/decide');
  check('builder settings roundtrip', bdb.getBuilderSettings().enabled && bdb.getBuilderSettings().model === 'prov/model' && bdb.getBuilderSettings().chatEnabled && bdb.getBuilderSettings().chatModel === 'p/chat' && JSON.stringify(bdb.getBuilderSettings().chatLanguages) === JSON.stringify(['Slovenian', 'English']));
  bdb.setBuilderSettings({ enabled: false, model: '', chatEnabled: false, chatModel: '', chatDecisionModel: '', chatLanguages: [], maxParallelBuilds: 99, limitThreshold: 95 });
  check('builder settings: empty decision model falls back to default', bdb.getBuilderSettings().chatDecisionModel === 'opencode-go/jev-1.14');
  check('builder settings: empty models fall back to defaults', !bdb.getBuilderSettings().enabled && bdb.getBuilderSettings().model === 'opencode-go/glm-5.3' && bdb.getBuilderSettings().chatModel === 'opencode-go/glm-5.3-flash' && bdb.getBuilderSettings().chatLanguages.length === 0);
  bdb.setState('chat:languages', 'not json');
  check('chat languages: invalid state means no constraint', bdb.getBuilderSettings().chatLanguages.length === 0);
  bdb.setState('chat:languages', '["ok", 7, " "]');
  check('chat languages: only valid strings survive the state roundtrip', JSON.stringify(bdb.getBuilderSettings().chatLanguages) === JSON.stringify(['ok']));
  bdb.setBuilderSettings({ enabled: false, model: '', chatEnabled: false, chatModel: '', chatDecisionModel: '', chatLanguages: ['Slovenian', 'English'], maxParallelBuilds: 99, limitThreshold: 95 });
  check('no active job initially', bdb.activeBuildJobInThread('t1') === null && bdb.recentBuildJobs(G, 100).length === 0);
  check('builder settings: maxParallelBuilds default 1, roundtrip, clamped', new BotDatabase(join(mkdtempSync(join(tmpdir(), 'bojan-mp-')), 'm.db')).getBuilderSettings().maxParallelBuilds === 1 && bdb.getBuilderSettings().maxParallelBuilds === 5);
  const j1 = bdb.createBuildJob({ guildId: G, threadId: 't1', channelId: 'c1', requesterId: 'u1', request: 'add ping' }, 1000);
  check('createBuildJob defaults', j1.id > 0 && j1.status === 'planning' && j1.tokensInput === 0 && j1.costUsd === 0 && j1.sessionId === null && j1.createdAt === 1000);
  check('getBuildJobByThread / active', bdb.getBuildJobByThread('t1')?.id === j1.id && bdb.getBuildJobByThread('nope') === null && bdb.activeBuildJobInThread('t1')?.id === j1.id);
  bdb.updateBuildJob(j1.id, { sessionId: 'ses_1', worktreeDir: '/w/1', branch: 'bot/1', title: 'Ping' }, 2000);
  bdb.setBuildJobStatus(j1.id, 'awaiting_input', 2500);
  const j1b = bdb.getBuildJob(j1.id)!;
  check('updateBuildJob / setBuildJobStatus', j1b.sessionId === 'ses_1' && j1b.branch === 'bot/1' && j1b.title === 'Ping' && j1b.status === 'awaiting_input' && j1b.updatedAt === 2500 && bdb.activeBuildJobInThread('t1')?.id === j1.id);
  bdb.setBuildJobUsage(j1.id, { input: 100, output: 20, reasoning: 5, cacheRead: 7, cacheWrite: 3, costUsd: 0.25 });
  bdb.updateBuildJob(j1.id, { prUrl: 'https://github.com/a/b/pull/9' });
  bdb.setBuildJobStatus(j1.id, 'pr_open');
  check('pr_open frees the slot; listBuildJobsByStatus', bdb.activeBuildJobInThread('t1') === null && bdb.listBuildJobsByStatus(['pr_open']).length === 1 && bdb.getBuildJob(j1.id)!.prUrl === 'https://github.com/a/b/pull/9' && bdb.listBuildJobsByStatus([]).length === 0);
  const j2 = bdb.createBuildJob({ guildId: G, threadId: 't2', channelId: 'c1', requesterId: 'u2', request: 'second' });
  bdb.setBuildJobUsage(j2.id, { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.05 });
  const tot = bdb.buildUsageTotals(G);
  check('buildUsageTotals', tot.jobs === 2 && tot.input === 110 && tot.output === 22 && tot.reasoning === 5 && tot.cacheRead === 7 && tot.cacheWrite === 3 && Math.abs(tot.costUsd - 0.3) < 1e-9);
  check('recentBuildJobs newest first + paging', bdb.recentBuildJobs(G, 10)[0]!.id === j2.id && bdb.recentBuildJobs(G, 1, 1)[0]!.id === j1.id && bdb.recentBuildJobs('other', 10).length === 0);
  // A thread may hold several jobs over time; the newest one wins.
  const j3 = bdb.createBuildJob({ guildId: G, threadId: 't1', channelId: 'c', requesterId: 'u', request: 'again' });
  check('several build jobs per thread; getBuildJobByThread returns the newest', j3.id > j2.id && bdb.getBuildJobByThread('t1')?.id === j3.id && bdb.recentBuildJobs(G, 100).length === 3);
  bdb.setBuildJobStatus(j3.id, 'cancelled');
  bdb.updateBuildJob(j1.id, { model: 'opencode-go/glm-5.3' });
  check('build job model column', bdb.getBuildJob(j1.id)!.model === 'opencode-go/glm-5.3' && bdb.getBuildJob(j2.id)!.model === null);
  // chat_threads
  check('chat totals empty', bdb.chatUsageTotals(G).threads === 0 && bdb.getChatThread('ct1') === null && bdb.recentChatThreads(G, 10).length === 0);
  const c1 = bdb.createChatThread({ threadId: 'ct1', guildId: G, channelId: 'c1', sessionId: 'ses_c1', startedBy: 'u1', model: 'opencode-go/glm-5.3-flash' }, 100);
  check('createChatThread defaults', c1.sessionId === 'ses_c1' && !c1.oneOff && c1.tokensInput === 0 && c1.costUsd === 0 && c1.createdAt === 100 && c1.lastActiveAt === 100);
  bdb.setChatThreadUsage('ct1', { input: 1000, output: 50, reasoning: 10, cacheRead: 200, cacheWrite: 0, costUsd: 0.002 }, 500);
  bdb.createChatThread({ threadId: 'ct1:m9', guildId: G, channelId: 'c1', sessionId: 'ses_o', startedBy: 'u2', model: null, oneOff: true }, 200);
  bdb.setChatThreadUsage('ct1:m9', { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 }, 300);
  const ctot = bdb.chatUsageTotals(G);
  check('chatUsageTotals counts threads and one-offs separately', ctot.threads === 1 && ctot.oneOffs === 1 && ctot.input === 1010 && ctot.output === 55 && ctot.reasoning === 10 && ctot.cacheRead === 200 && Math.abs(ctot.costUsd - 0.003) < 1e-9 && bdb.chatUsageTotals('other').threads === 0);
  check('recentChatThreads by last activity; one-off flag; getChatThread exact id', bdb.recentChatThreads(G, 10)[0]!.threadId === 'ct1' && bdb.recentChatThreads(G, 10)[1]!.oneOff && bdb.recentChatThreads(G, 1).length === 1 && bdb.recentChatThreads(G, 1, 1)[0]!.threadId === 'ct1:m9' && bdb.recentChatThreads(G, 1, 2).length === 0 && bdb.getChatThread('ct1')!.lastActiveAt === 500 && bdb.getChatThread('ct1:m9')!.oneOff);
  // chat notes in the DB
  check('addChatNote: unknown thread -> false', !bdb.addChatNote('nope', 'x'));
  check('chat notes: queue, survive reopen order, consume only the sent ones', (() => { bdb.addChatNote('ct1', 'n1'); bdb.addChatNote('ct1', 'n2'); const sent = bdb.pendingChatNotes('ct1'); bdb.addChatNote('ct1', 'n3'); bdb.consumeChatNotes('ct1', sent.length); return sent.join(',') === 'n1,n2' && bdb.pendingChatNotes('ct1').join(',') === 'n3'; })());
  let cdup = false;
  try { bdb.createChatThread({ threadId: 'ct1', guildId: G, channelId: 'c', sessionId: 's', startedBy: 'u', model: null }); } catch { cdup = true; }
  check('chat thread id is unique', cdup);
  const html = requestsPage({ jobs: bdb.recentBuildJobs(G, 50), totals: bdb.buildUsageTotals(G), chatTotals: bdb.chatUsageTotals(G), chats: bdb.recentChatThreads(G, 50), page: 1, pages: 1, pageSize: 50, chatPage: 1, chatPages: 1, chatPageSize: 20, guildId: G, timezone: 'UTC', members: { u1: '<b>Ann</b>' }, user: { username: 'x', avatar: 'a' } });
  check('requestsPage renders chat summary + rows', html.includes('Chat threads') && html.includes('$0.0030') && html.includes(`discord.com/channels/${G}/ct1"`) && html.includes('one-off'));
  check('requestsPage renders rows, cost and escapes names', html.includes('$0.2500') && html.includes('&lt;b&gt;Ann&lt;/b&gt;') && !html.includes('<b>Ann</b>') && html.includes(`discord.com/channels/${G}/t1`));
  bdb.close();

  // Migration: a build_jobs table from before the model column gets it on open.
  const mdir = mkdtempSync(join(tmpdir(), 'bojan-builder-model-'));
  const mraw = new DatabaseSync(join(mdir, 'm.db'));
  mraw.exec('CREATE TABLE build_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL, requester_id TEXT NOT NULL, request TEXT NOT NULL, title TEXT, status TEXT NOT NULL, session_id TEXT, worktree_dir TEXT, branch TEXT, pr_url TEXT, error TEXT, tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  mraw.close();
  const mdb = new BotDatabase(join(mdir, 'm.db'));
  const mj = mdb.createBuildJob({ guildId: G, threadId: 'm1', channelId: 'c', requesterId: 'u', request: 'x' });
  mdb.updateBuildJob(mj.id, { model: 'a/b' });
  check('model column migration on old build_jobs', mdb.getBuildJob(mj.id)!.model === 'a/b');
  // The same old table also had a UNIQUE thread_id: the migration rebuilt it, keeping rows.
  const mj2 = mdb.createBuildJob({ guildId: G, threadId: 'm1', channelId: 'c', requesterId: 'u', request: 'second in same thread' });
  check('old build_jobs: UNIQUE thread_id dropped by migration, rows kept', mj2.id > mj.id && mdb.getBuildJobByThread('m1')?.id === mj2.id && mdb.getBuildJob(mj.id)!.request === 'x' && mdb.getBuildJob(mj.id)!.model === 'a/b');
  mdb.close();
  const mdb2 = new BotDatabase(join(mdir, 'm.db'));
  check('thread_id migration is idempotent', mdb2.recentBuildJobs(G, 100).length === 2);
  mdb2.close();

  // Pricing
  const prices = parseGoPrices({
    data: [
      { id: 'glm-5.3', cost: { text: { input: { price: 1.4, cache: { read: 0.26 } }, output: { price: 4.4 } } } },
      { id: 'kimi', cost: { text: { input: { price: 1, cache: { read: 0.1, write: 1.25 } }, output: { price: 3 } } } },
      { id: 'nocache', cost: { text: { input: { price: 2 }, output: { price: 5 } } } },
      { id: 'noprice', cost: { text: {} } },
      { cost: {} },
      null,
    ],
  });
  check('parseGoPrices: complete entries', prices.size === 3 && JSON.stringify(prices.get('glm-5.3')) === JSON.stringify({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: null }) && prices.get('kimi')!.cacheWrite === 1.25);
  check('parseGoPrices: missing cache -> input price; garbage tolerated', prices.get('nocache')!.cacheRead === 2 && parseGoPrices(null).size === 0 && parseGoPrices({ data: 'x' }).size === 0);
  const glm = prices.get('glm-5.3')!;
  const est = estimateCostUsd({ input: 8561, output: 286, reasoning: 773, cacheRead: 9472, cacheWrite: 0 }, glm);
  check('estimateCostUsd glm-5.3 example', Math.abs(est - 0.01910772) < 1e-9, String(est));
  check('estimateCostUsd cache write fallback', Math.abs(estimateCostUsd({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 1_000_000 }, glm) - 1.4) < 1e-9 && Math.abs(estimateCostUsd({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 1_000_000 }, prices.get('kimi')!) - 1.25) < 1e-9);
  check('goPriceFor: only opencode-go/*', goPriceFor('opencode-go/glm-5.3', prices) === glm && goPriceFor('anthropic/glm-5.3', prices) === null && goPriceFor('opencode-go/none', prices) === null && goPriceFor(null, prices) === null);

  // Settings form
  const cur = { enabled: false, model: 'opencode-go/glm-5.3', chatEnabled: false, chatModel: 'opencode-go/glm-5.3-flash', chatDecisionModel: 'opencode-go/jev-1.14', chatLanguages: [] as string[], maxParallelBuilds: 1, limitThreshold: 95 };
  check('parseBuilderForm: valid', JSON.stringify(parseBuilderForm({ enabled: '1', model: ' p/m ', chatEnabled: '1', chatModel: 'q/c' }, cur)) === JSON.stringify({ settings: { enabled: true, model: 'p/m', chatEnabled: true, chatModel: 'q/c', chatDecisionModel: 'opencode-go/jev-1.14', chatLanguages: [], maxParallelBuilds: 1, limitThreshold: 95 }, modelError: null }));
  check('parseBuilderForm: decision model valid / empty -> default / invalid keeps current + error', parseBuilderForm({ chatDecisionModel: ' a/b ' }, cur).settings.chatDecisionModel === 'a/b' && parseBuilderForm({ chatDecisionModel: '' }, { ...cur, chatDecisionModel: 'x/y' }).settings.chatDecisionModel === 'opencode-go/jev-1.14' && (() => { const r = parseBuilderForm({ chatDecisionModel: 'bad model' }, { ...cur, chatDecisionModel: 'x/y' }); return r.settings.chatDecisionModel === 'x/y' && r.modelError !== null && r.modelError.startsWith('Decision model'); })());
  check('parseBuilderForm: invalid model keeps current + error', (() => { const r = parseBuilderForm({ model: 'nomodel' }, { ...cur, enabled: true, model: 'x/y' }); return !r.settings.enabled && r.settings.model === 'x/y' && r.modelError !== null; })());
  check('parseBuilderForm: invalid chat model keeps current + error', (() => { const r = parseBuilderForm({ chatEnabled: '1', chatModel: 'bad model/x' }, { ...cur, chatModel: 'x/chat' }); return r.settings.chatEnabled && r.settings.chatModel === 'x/chat' && r.modelError !== null && r.modelError.startsWith('Chat model'); })());
  check('parseBuilderForm: empty -> defaults', (() => { const r = parseBuilderForm({ enabled: '1', model: '', chatModel: '' }, { ...cur, model: 'x/y', chatModel: 'x/z' }); return r.settings.model === 'opencode-go/glm-5.3' && r.settings.chatModel === 'opencode-go/glm-5.3-flash' && !r.settings.chatEnabled; })());
  check('parseChatLanguages: trims, dedupes case-insensitively, drops empties', JSON.stringify(parseChatLanguages(' Slovenian ,english,, SLOVENIAN , English ')) === JSON.stringify(['Slovenian', 'english']) && JSON.stringify(parseChatLanguages(['a', 'b, a'])) === JSON.stringify(['a', 'b']));
  check('parseChatLanguages: missing/garbage -> none; whitespace flattened; clipped at 30', parseChatLanguages(undefined).length === 0 && parseChatLanguages(7).length === 0 && parseChatLanguages('  neo   latin  ').join('|') === 'neo latin' && parseChatLanguages('x'.repeat(50))[0]!.length === 30);
  check('parseChatLanguages: capped at 8 entries', parseChatLanguages(Array.from({ length: 12 }, (_, i) => `l${i}`).join(',')).length === 8 && parseChatLanguages(Array.from({ length: 12 }, (_, i) => `l${i}`)).length === 8);
  check('parseBuilderForm: chat languages parsed from the form', parseBuilderForm({ chatLanguages: ' Slovenian, English ' }, cur).settings.chatLanguages.join(',') === 'Slovenian,English');

  check('parseBuilderForm: maxParallelBuilds parsed, clamped to 1..5, invalid keeps current', parseBuilderForm({ maxParallelBuilds: '3' }, cur).settings.maxParallelBuilds === 3 && parseBuilderForm({ maxParallelBuilds: '0' }, cur).settings.maxParallelBuilds === 1 && parseBuilderForm({ maxParallelBuilds: '-4' }, cur).settings.maxParallelBuilds === 1 && parseBuilderForm({ maxParallelBuilds: '99' }, cur).settings.maxParallelBuilds === 5 && parseBuilderForm({ maxParallelBuilds: 'abc' }, { ...cur, maxParallelBuilds: 4 }).settings.maxParallelBuilds === 4 && parseBuilderForm({ maxParallelBuilds: '2.5' }, { ...cur, maxParallelBuilds: 4 }).settings.maxParallelBuilds === 4 && parseBuilderForm({}, { ...cur, maxParallelBuilds: 2 }).settings.maxParallelBuilds === 2);

  // OpenCode Go limit gate
  check('clampLimitThreshold: 50..100, default 95', clampLimitThreshold(95) === 95 && clampLimitThreshold(50) === 50 && clampLimitThreshold(20) === 50 && clampLimitThreshold(120) === 100 && clampLimitThreshold(94.6) === 95 && clampLimitThreshold(NaN) === 95);
  check('parseLimitThreshold: parsed, clamped, invalid keeps current', parseLimitThreshold('90', 95) === 90 && parseLimitThreshold('20', 95) === 50 && parseLimitThreshold('200', 95) === 100 && parseLimitThreshold('abc', 80) === 80 && parseLimitThreshold(undefined, 80) === 80 && parseLimitThreshold('95.5', 80) === 80);
  check('parseBuilderForm: limitThreshold parsed', parseBuilderForm({ limitThreshold: '85' }, cur).settings.limitThreshold === 85 && parseBuilderForm({ limitThreshold: '10' }, cur).settings.limitThreshold === 50 && parseBuilderForm({}, { ...cur, limitThreshold: 90 }).settings.limitThreshold === 90);
  const meter = (percent: number, resetsAt: number, limited = false) => ({ percent, limited, resetsAt });
  const limitsAt = (rolling: number, weekly: number, monthly: number, t = now) => ({ rolling: meter(rolling, t + H), weekly: meter(weekly, t + 2 * D), monthly: meter(monthly, t + 20 * D) });
  check('blockingLimit: below threshold and missing limits allow', blockingLimit(null, 95) === null && blockingLimit({}, 95) === null && blockingLimit(limitsAt(94, 0, 0), 95) === null && blockingLimit(limitsAt(0, 0, 0), 50) === null);
  check('blockingLimit: at or above threshold blocks each window', blockingLimit(limitsAt(95, 0, 0), 95)?.kind === 'rolling' && blockingLimit(limitsAt(0, 99, 0), 95)?.kind === 'weekly' && blockingLimit(limitsAt(0, 0, 100), 95)?.kind === 'monthly');
  check('blockingLimit: limited flag blocks below the threshold', blockingLimit({ rolling: meter(12, now + H, true), weekly: meter(0, now + D), monthly: meter(0, now + 20 * D) }, 95)?.kind === 'rolling');
  check('blockingLimit: several blocked -> the latest reset wins', (() => { const b = blockingLimit({ rolling: meter(99, now + H), weekly: meter(96, now + 2 * D), monthly: meter(10, now + 20 * D) }, 95); return b?.kind === 'weekly' && b.resetsAt === now + 2 * D; })());
  check('blockingLimit: custom threshold', blockingLimit(limitsAt(60, 0, 0), 60)?.kind === 'rolling' && blockingLimit(limitsAt(59, 0, 0), 60) === null);
  check('formatLimitDenial: percent, reset time and countdown', (() => { const r = formatLimitDenial({ kind: 'monthly', percent: 97.4, resetsAt: now + 3 * D }, 'UTC', now); return r.includes('monthly limit') && r.includes('97%') && r.includes('Next reset:') && r.includes('in 3d') && formatLimitDenial({ kind: 'rolling', percent: 100, resetsAt: 0 }, 'UTC', now).includes('5h'); })());
  let gateNow = now;
  let limitCalls = 0;
  const gate = new LimitGate(30_000, () => gateNow);
  const busyLimits = { limitMeters: async () => { limitCalls++; return limitsAt(96, 0, 0, gateNow); } };
  const denied = await gate.check(busyLimits, 95, 'UTC');
  check('LimitGate: blocks over the threshold and caches the answer', denied !== null && (await gate.check(busyLimits, 95, 'UTC')) === denied && limitCalls === 1, String(denied));
  gateNow = now + 31_000;
  const idleLimits = { limitMeters: async () => { limitCalls++; return limitsAt(0, 0, 0, gateNow); } };
  check('LimitGate: allows again after the TTL once the limit reset', (await gate.check(idleLimits, 95, 'UTC')) === null && limitCalls === 2);
  check('LimitGate: read failure allows requests', (await new LimitGate(0, () => gateNow).check({ limitMeters: async () => { throw new Error('boom'); } }, 95, 'UTC')) === null);

  // Chat assistant: pure helpers
  const cr1 = parseChatReply('Node 24 is the LTS.\nSource: https://nodejs.org\n```json\n{"reply": true, "feature_request": null}\n```');
  check('parseChatReply: reply true', cr1.reply && cr1.visible.startsWith('Node 24') && !cr1.visible.includes('```') && !cr1.missingBlock);
  const cr2 = parseChatReply('ignored text\n```json\n{"reply": false}\n```');
  check('parseChatReply: reply false in the block no longer hides the text', cr2.reply && cr2.visible === 'ignored text' && !cr2.missingBlock);
  const cr4 = parseChatReply('Just some text without a block');
  check('parseChatReply: missing block -> never posted, flagged', !cr4.reply && cr4.visible === '' && cr4.missingBlock);
  const cr5 = parseChatReply('Text\n```json\n{not json}\n```');
  check('parseChatReply: invalid json -> never posted, flagged', !cr5.reply && cr5.visible === '' && cr5.missingBlock);
  check('parseChatReply: empty -> flagged; block with no text -> no reply', !parseChatReply('').reply && parseChatReply('').missingBlock && !parseChatReply('```json\n{"reply": true}\n```').reply);
  check('isFeatureRequest: threshold 0.5, null = no', isFeatureRequest(0.96) && isFeatureRequest(0.5) && !isFeatureRequest(0.49) && !isFeatureRequest(null) && !isFeatureRequest(NaN) && isFeatureRequest(0.7, 0.7));
  check('FEATURE_REQUEST_QUESTION: shape, covers "ship this"', FEATURE_REQUEST_QUESTION.name === 'feature_request' && FEATURE_REQUEST_QUESTION.instructions.includes('ship this') && FEATURE_REQUEST_QUESTION.criteria.false.includes('discussing'));
  check('formatDecisionInput: plain message only', formatDecisionInput({ text: ' add a beer reaction ' }) === 'Latest message (the one to classify):\nadd a beer reaction');
  check('formatDecisionInput: with reply line', formatDecisionInput({ text: 'do this', replyTo: { name: 'Ana', text: 'we need dark mode' } }) === 'The latest message replies to Ana: we need dark mode\n\nLatest message (the one to classify):\ndo this' && formatDecisionInput({ text: 'x', replyTo: { name: 'Ana', text: '  ' } }) === 'Latest message (the one to classify):\nx');
  const di = formatDecisionInput({ text: 'ship this', history: [{ name: 'Ana', text: 'what about a /joke command?' }, { name: 'Bob', text: 'multi\nline   idea' }, { name: 'Cy', text: '  ' }] });
  check('formatDecisionInput: history oldest first, then the latest message', di.startsWith('Recent thread messages') && di.indexOf('Ana: what about a /joke command?') < di.indexOf('Bob: multi line idea') && !di.includes('Cy:') && di.endsWith('Latest message (the one to classify):\nship this'));
  const diBig = formatDecisionInput({ text: 'go', history: Array.from({ length: 20 }, (_, i) => ({ name: 'U', text: `${i} ${'q'.repeat(400)}` })), maxChars: 1000 });
  check('formatDecisionInput: history clipped by dropping oldest', !diBig.includes('U: 0 ') && diBig.includes(`U: 19 `) && diBig.length < 1400);
  const sl = sinceLastBotMessage([{ authorId: 'u1', text: 'a' }, { authorId: 'bot', text: 'b' }, { authorId: 'u2', text: 'c' }, { authorId: 'u1', text: 'd' }], 'bot');
  check('sinceLastBotMessage: keeps only messages after the bot\'s last one', sl.map((m) => m.text).join('') === 'cd');
  check('sinceLastBotMessage: bot never spoke -> all; bot last -> none; empty -> empty', sinceLastBotMessage([{ authorId: 'u1', text: 'a' }, { authorId: 'u2', text: 'b' }], 'bot').length === 2 && sinceLastBotMessage([{ authorId: 'u1', text: 'a' }, { authorId: 'bot', text: 'b' }], 'bot').length === 0 && sinceLastBotMessage([], 'bot').length === 0);
  const tc = formatThreadContext(['Ann (1): hi', '  ', 'Bob (2): ship it?']);
  check('formatThreadContext: header + lines, empty -> empty', tc === 'Other messages in the thread since your last reply (context, not addressed to you):\nAnn (1): hi\nBob (2): ship it?' && formatThreadContext([]) === '' && formatThreadContext(['  ']) === '');
  check('formatThreadContext: keeps newest lines within limits', formatThreadContext(Array.from({ length: 40 }, (_, i) => `L${i}`), { maxLines: 3 }).endsWith('L37\nL38\nL39') && !formatThreadContext(Array.from({ length: 40 }, (_, i) => `L${i}`), { maxLines: 3 }).includes('L36'));
  check('featureRequestText: plain and with reply', featureRequestText({ text: ' add x ' }) === 'add x' && featureRequestText({ text: 'do this', replyTo: { name: 'Ana', text: 'dark mode' } }) === 'In reply to Ana: dark mode\n\ndo this');
  check('shouldRunDecision: needs directed + admin + enabled + text', shouldRunDecision({ directed: true, admin: true, buildingEnabled: true, text: 'x' }) && !shouldRunDecision({ directed: false, admin: true, buildingEnabled: true, text: 'x' }) && !shouldRunDecision({ directed: true, admin: false, buildingEnabled: true, text: 'x' }) && !shouldRunDecision({ directed: true, admin: true, buildingEnabled: false, text: 'x' }) && !shouldRunDecision({ directed: true, admin: true, buildingEnabled: true, text: '  ' }));

  const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n');
  const chunks = chunkMessage(long, 2000);
  check('chunkMessage: <=2000 each, split at line boundaries, nothing lost', chunks.length > 1 && chunks.every((c) => c.length <= 2000) && chunks.join('\n') === long && chunks.every((c) => c.split('\n').every((l) => l.startsWith('line '))));
  check('chunkMessage: short text is one chunk; empty -> none', chunkMessage('hello').length === 1 && chunkMessage('  ').length === 0);
  const wall = chunkMessage(`${'word '.repeat(900)}`.trim(), 2000);
  check('chunkMessage: a single long line is split at spaces', wall.length === 3 && wall.every((c) => c.length <= 2000 && !c.startsWith(' ') && !c.endsWith(' ')));
  check('chunkMessage: unbroken text is hard-split', chunkMessage('y'.repeat(4500), 2000).map((c) => c.length).join(',') === '2000,2000,500');

  check('formatChatMessage', formatChatMessage({ name: 'Ann', id: '42', text: ' hi ' }) === 'Ann (42): hi' && formatChatMessage({ name: 'Ann', id: '42', text: 'see', extras: ['[attachment] a.png: https://cdn/x.png'] }) === 'Ann (42): see\n  [attachment] a.png: https://cdn/x.png');
  const ip = formatInitialPrompt({ channelName: 'general', trigger: { name: 'Bob', id: '7', text: '@bojan what is this?' }, referenced: { name: 'Ann', id: '42', text: 'look at this', extras: ['[embed] Title — https://e.com'] } });
  check('formatInitialPrompt: reference first, then the mention', ip.includes('#general') && ip.indexOf('Ann (42): look at this') < ip.indexOf('Bob (7): @bojan what is this?') && ip.includes('https://e.com'));
  check('formatInitialPrompt: no reference, no channel', (() => { const p = formatInitialPrompt({ channelName: null, trigger: { name: 'Bob', id: '7', text: 'hey' }, referenced: null }); return !p.includes('replied to') && !p.includes('#') && p.includes('Bob (7): hey'); })());
  const entries = Array.from({ length: 30 }, (_, i) => ({ name: 'U', id: String(i), text: `message ${i}` }));
  const tr = formatTranscript(entries).split('\n');
  check('formatTranscript: all 30 recent messages kept (limit 50), oldest first', tr.length === 30 && tr[0] === 'U (0): message 0' && tr[29] === 'U (29): message 29' && formatTranscript(Array.from({ length: 80 }, (_, i) => ({ name: 'U', id: String(i), text: `m${i}` }))).split('\n').length === 50);
  const bigTr = formatTranscript([{ name: 'A', id: '1', text: 'a'.repeat(900) }, { name: 'B', id: '2', text: 'multi\nline   text' }], { perMessage: 100 });
  check('formatTranscript: trims long messages, flattens whitespace', bigTr.split('\n').length === 2 && bigTr.split('\n')[0]!.length <= 'A (1): '.length + 100 && bigTr.endsWith('B (2): multi line text'));
  const capped = formatTranscript(Array.from({ length: 20 }, (_, i) => ({ name: 'U', id: String(i), text: 'z'.repeat(400) })), { maxChars: 1000 });
  check('formatTranscript: drops oldest to stay under maxChars', capped.length <= 1000 && capped.endsWith('U (19): ' + 'z'.repeat(400)) && capped.split('\n').length < 20);
  check('chatThreadNameFor', chatThreadNameFor('  what is\nnode?  ') === 'what is node?' && chatThreadNameFor('') === 'chat' && chatThreadNameFor('a'.repeat(300)).length === 100);
  const bn = formatBuildNote({ jobId: 7, title: 'Ping', event: 'pr_opened', prUrl: 'https://github.com/a/b/pull/9', summary: 'Adds\n/ping.' });
  check('formatBuildNote: pr_opened', bn === '[build update] job #7 "Ping": PR opened https://github.com/a/b/pull/9 — Adds /ping.');
  check('formatBuildNote: approved includes plan, others', formatBuildNote({ jobId: 1, title: null, event: 'approved', plan: '- do x' }).includes('plan approved, building now. Plan:\n- do x') && formatBuildNote({ jobId: 1, title: 'T', event: 'merged', prUrl: 'u' }) === '[build update] job #1 "T": PR merged u' && formatBuildNote({ jobId: 1, title: 'T', event: 'closed' }).includes('closed without merging') && formatBuildNote({ jobId: 1, title: 'T', event: 'failed', reason: 'boom\nbad' }) === '[build update] job #1 "T": failed — boom bad' && formatBuildNote({ jobId: 1, title: 'T', event: 'cancelled' }).endsWith('cancelled'));
  check('formatBuildNote: long plan clipped', formatBuildNote({ jobId: 1, title: 'T', event: 'approved', plan: 'p'.repeat(5000) }).length < 2700);
  const js = (status: string, extra: Partial<{ queuePosition: number | null; sinceMs: number; prUrl: string | null; title: string | null }> = {}) =>
    formatJobStatus({ jobId: 4, title: 'Ping', request: 'add /ping', status, queuePosition: null, sinceMs: 7 * 60_000, prUrl: null, ...extra });
  check('formatJobStatus: planning', js('planning').startsWith('[build status] job #4 "Ping"') && js('planning').includes('context') && js('planning').includes('add /ping'));
  check('formatJobStatus: awaiting_input', js('awaiting_input').includes('reply to the posted plan'));
  check('formatJobStatus: queued', js('queued', { queuePosition: 2 }).includes('position 2') && !js('queued').includes('position'));
  check('formatJobStatus: building', js('building').includes('7 min') && js('building', { title: null }).includes('job #4 —'));
  check('formatJobStatus: pr_open', js('pr_open', { prUrl: 'https://x/pull/1' }).includes('https://x/pull/1'));
  check('formatJobStatus: other statuses empty', js('merged') === '' && js('failed') === '');
  check('withNotes', withNotes([], 'hi') === 'hi' && withNotes(['a', 'b'], 'hi') === 'a\nb\n\nhi');
  check('languageDirective: empty list -> no rule', languageDirective([]) === '' && languageDirective(['Slovenian']).length > 0);
  check('withLanguageRule: untouched without languages, rule first otherwise', withLanguageRule('hi', []) === 'hi' && withLanguageRule('hi', ['Slovenian', 'English']).startsWith('[language rule]') && withLanguageRule('hi', ['Slovenian', 'English']).includes('Slovenian, English') && withLanguageRule('hi', ['Slovenian', 'English']).endsWith('\n\nhi'));
  check('replaceBotMention', replaceBotMention('<@123> and <@!123> hi <@456>', '123', 'bojan') === '@bojan and @bojan hi <@456>');


  // ---- build queue, resume, conflict fix (pure) ----
  const qj = (id: number, approvedAt: number | null, createdAt = 0) => ({ id, approvedAt, createdAt });
  const queue = [qj(5, 300), qj(3, 100), qj(4, 100), qj(9, null, 50)];
  check('sortQueue: approval time then id (null approvedAt falls back to createdAt)', sortQueue(queue).map((j) => j.id).join(',') === '9,3,4,5');
  check('queuePosition: 1-based, 0 when absent', queuePosition(queue, 9) === 1 && queuePosition(queue, 5) === 4 && queuePosition(queue, 77) === 0);
  check('freeSlots', freeSlots(0, 1) === 1 && freeSlots(1, 1) === 0 && freeSlots(3, 2) === 0 && freeSlots(1, 3) === 2);
  check('pickJobsToStart: FIFO up to free slots', pickJobsToStart(queue, 0, 2).map((j) => j.id).join(',') === '9,3' && pickJobsToStart(queue, 1, 1).length === 0 && pickJobsToStart(queue, 1, 3).map((j) => j.id).join(',') === '9,3' && pickJobsToStart([], 0, 3).length === 0);

  check('prInfoFromJson: dirty open PR is a conflict', JSON.stringify(prInfoFromJson({ state: 'open', mergeable: false, mergeable_state: 'dirty' })) === '{"state":"open","mergeability":"conflict"}');
  check('prInfoFromJson: mergeable null / unknown is unknown', prInfoFromJson({ state: 'open', mergeable: null, mergeable_state: 'unknown' }).mergeability === 'unknown' && prInfoFromJson({ state: 'open' }).mergeability === 'unknown' && prInfoFromJson({ state: 'open', mergeable: true, mergeable_state: 'unknown' }).mergeability === 'unknown');
  check('prInfoFromJson: clean / blocked / behind are ok', ['clean', 'blocked', 'behind', 'unstable'].every((m) => prInfoFromJson({ state: 'open', mergeable: true, mergeable_state: m }).mergeability === 'ok'));
  check('prInfoFromJson: merged and closed ignore mergeability; prStateFromJson unchanged', prInfoFromJson({ state: 'closed', merged: true, mergeable_state: 'dirty' }).state === 'merged' && prInfoFromJson({ state: 'closed', merged: true, mergeable_state: 'dirty' }).mergeability === 'ok' && prInfoFromJson({ state: 'closed', mergeable: null }).state === 'closed' && prInfoFromJson({ state: 'closed', mergeable: null }).mergeability === 'ok' && prStateFromJson({ state: 'open', mergeable_state: 'dirty' }) === 'open');

  check('lastConversationIsAssistant: skips idle/other message types', lastConversationIsAssistant([{ type: 'idle' }, { type: 'agent-switched' }, { type: 'assistant' }, { type: 'user' }]) && !lastConversationIsAssistant([{ type: 'system' }, { type: 'user' }, { type: 'assistant' }]) && !lastConversationIsAssistant([{ type: 'user' }]) && lastConversationIsAssistant([]) && lastConversationIsAssistant([{ type: 'idle' }]));
  const okBuild = `done\n${json({ status: 'pr_opened', pr_url: 'https://github.com/a/b/pull/1', summary: 's' })}`;
  const okPlan = `plan\n${json({ status: 'needs_input', title: 'T', plan: 'p', questions: [] })}`;
  const rep = (text: string, finish: string | null = 'stop', error: string | null = null) => ({ text, finish, error });
  check('decideRecovery: valid build result is handled', decideRecovery({ kind: 'build', reply: rep(okBuild), lastIsAssistant: true, resumeCount: 0 }).action === 'handle' && decideRecovery({ kind: 'build', reply: rep(okBuild), lastIsAssistant: true, resumeCount: 2 }).action === 'handle');
  check('decideRecovery: build without json block resumes', decideRecovery({ kind: 'build', reply: rep('working on it'), lastIsAssistant: true, resumeCount: 0 }).action === 'resume' && decideRecovery({ kind: 'build', reply: rep('x\n```json\n{bad}\n```'), lastIsAssistant: true, resumeCount: 1 }).action === 'resume');
  check('decideRecovery: error finish or unanswered prompt resumes even with a (stale) valid result', decideRecovery({ kind: 'build', reply: rep(okBuild, 'error', 'boom'), lastIsAssistant: true, resumeCount: 0 }).action === 'resume' && decideRecovery({ kind: 'build', reply: rep(okBuild), lastIsAssistant: false, resumeCount: 0 }).action === 'resume' && decideRecovery({ kind: 'build', reply: rep(okBuild, 'tool-calls'), lastIsAssistant: true, resumeCount: 0 }).action === 'resume');
  const failDec = decideRecovery({ kind: 'build', reply: rep('nope'), lastIsAssistant: true, resumeCount: 2 });
  check('decideRecovery: fails after 2 resume attempts with a reason', failDec.action === 'fail' && failDec.reason.includes('2 resume attempts'), JSON.stringify(failDec));
  check('decideRecovery: plan with valid result handled; clean plain text handled; empty/interrupted resumes', decideRecovery({ kind: 'plan', reply: rep(okPlan), lastIsAssistant: true, resumeCount: 0 }).action === 'handle' && decideRecovery({ kind: 'plan', reply: rep('Which store?'), lastIsAssistant: true, resumeCount: 0 }).action === 'handle' && decideRecovery({ kind: 'plan', reply: rep(''), lastIsAssistant: true, resumeCount: 0 }).action === 'resume' && decideRecovery({ kind: 'plan', reply: rep('half', null, 'x'), lastIsAssistant: true, resumeCount: 1 }).action === 'resume' && decideRecovery({ kind: 'plan', reply: rep(''), lastIsAssistant: true, resumeCount: 2 }).action === 'fail');
  {
    check('planner message attribution', formatPlannerMessage('Game Explorer', 'add medals') === 'Message from Discord user "Game Explorer": add medals');
    check('planner message quote in name', formatPlannerMessage('Ga"me', 'x') === `Message from Discord user "Ga'me": x`);
    const p = followUpPrompt(['Tim: a', 'Tim: b'], ['Bob: hi'], 'CTX:');
    check('follow-up prompt', p.startsWith('CTX:\nBob: hi\n\n') && p.includes(`${FOLLOW_UP_HEADER}\nTim: a\nTim: b`) && p.includes('can not approve') && followUpPrompt(['x']) === `${FOLLOW_UP_HEADER}\nx`);
    check('shouldHoldPlanReply', !shouldHoldPlanReply({ pendingFollowUps: 0, error: false, planStatus: 'needs_input' }) && !shouldHoldPlanReply({ pendingFollowUps: 1, error: true, planStatus: null }) && !shouldHoldPlanReply({ pendingFollowUps: 1, error: false, planStatus: 'cancelled' }) && shouldHoldPlanReply({ pendingFollowUps: 1, error: false, planStatus: 'needs_input' }) && shouldHoldPlanReply({ pendingFollowUps: 2, error: false, planStatus: 'approved' }) && shouldHoldPlanReply({ pendingFollowUps: 1, error: false, planStatus: null }));
    check('follow-up approval downgraded', guardPlanStatus({ status: 'approved', planPostedAt: 2000, latestUserMessageAt: 1000 }) === 'needs_input');
  }
  check('resume / conflict prompts', BUILD_RESUME_PROMPT.includes('gh pr view') && BUILD_RESUME_PROMPT.includes('json block') && conflictFixPrompt('https://github.com/a/b/pull/1').includes('git merge origin/main') && conflictFixPrompt('https://github.com/a/b/pull/1').includes('no force push') && conflictFixPrompt('https://github.com/a/b/pull/1').includes('https://github.com/a/b/pull/1'));
  const ca = (o: Partial<Parameters<typeof conflictAction>[0]>) => conflictAction({ conflict: 'conflict', fixAttempts: 0, notified: false, slotFree: true, sinceUpdateMs: 10 * CONFLICT_SETTLE_MS, ...o });
  check('conflictAction: fix when slot free, wait otherwise, unknown/ok do nothing', ca({}) === 'fix' && ca({ slotFree: false }) === 'wait' && ca({ conflict: 'unknown' }) === 'none' && ca({ conflict: 'ok' }) === 'none');
  check('conflictAction: after the attempt notify once (after settling), never a second fix', ca({ fixAttempts: 1 }) === 'notify' && ca({ fixAttempts: 1, notified: true }) === 'none' && ca({ fixAttempts: 1, sinceUpdateMs: 1000 }) === 'none' && ca({ fixAttempts: 1, slotFree: false }) === 'notify');

  const nt = (event: Parameters<typeof formatBuildNote>[0]['event'], extra: object = {}) => formatBuildNote({ jobId: 4, title: 'T', event, ...extra });
  check('formatBuildNote: queued / resumed', nt('queued', { position: 2, plan: '- x' }) === '[build update] job #4 "T": plan approved, queued for a build slot (#2 in line). Plan:\n- x' && nt('resumed').includes('restarted') && nt('resumed').includes('resuming'));
  check('formatBuildNote: conflict started / fixed / failed', nt('conflict_fix_started', { prUrl: 'u' }).includes('merge conflicts with main; trying to fix') && nt('conflict_fixed', { prUrl: 'u' }) === '[build update] job #4 "T": merge conflicts fixed. u' && nt('conflict_failed', { prUrl: 'u', reason: 'bad\nmerge' }).includes('needs a manual merge. u bad merge'));

  check('guardPlanStatus: approval needs a plan card and a later user message', guardPlanStatus({ status: 'approved', planPostedAt: null, latestUserMessageAt: 5 }) === 'needs_input' && guardPlanStatus({ status: 'approved', planPostedAt: 10, latestUserMessageAt: 5 }) === 'needs_input' && guardPlanStatus({ status: 'approved', planPostedAt: 10, latestUserMessageAt: 10 }) === 'needs_input' && guardPlanStatus({ status: 'approved', planPostedAt: 10, latestUserMessageAt: null }) === 'needs_input' && guardPlanStatus({ status: 'approved', planPostedAt: 10, latestUserMessageAt: 11 }) === 'approved');
  check('guardPlanStatus: cancelled and needs_input unaffected', guardPlanStatus({ status: 'cancelled', planPostedAt: null, latestUserMessageAt: null }) === 'cancelled' && guardPlanStatus({ status: 'needs_input', planPostedAt: 1, latestUserMessageAt: 2 }) === 'needs_input');
  check('planChanged: first plan, whitespace-only diff, real diff, empty next', planChanged(null, 'a') && !planChanged('- a\n- b', '-  a   - b\n') && planChanged('- a', '- a\n- c') && !planChanged('- a', '  ') && planChanged(null, ''));

  // Several planning jobs run in parallel (different threads); one non-terminal job per thread.
  const pdb = new BotDatabase(join(mkdtempSync(join(tmpdir(), 'bojan-par-')), 'p.db'));
  const pj1 = pdb.createBuildJob({ guildId: G, threadId: 'pt1', channelId: 'c', requesterId: 'u', request: 'a' });
  const pj2 = pdb.createBuildJob({ guildId: G, threadId: 'pt2', channelId: 'c', requesterId: 'u', request: 'b' });
  const pj3 = pdb.createBuildJob({ guildId: G, threadId: 'pt3', channelId: 'c', requesterId: 'u', request: 'c' });
  pdb.setBuildJobStatus(pj2.id, 'awaiting_input');
  check('concurrent planning jobs in different threads', pdb.listBuildJobsByStatus(['planning', 'awaiting_input']).length === 3 && pdb.activeBuildJobInThread('pt1')?.id === pj1.id && pdb.activeBuildJobInThread('pt2')?.id === pj2.id && pdb.activeBuildJobInThread('other') === null && pdb.countBuildingJobs() === 0);
  pdb.updateBuildJob(pj3.id, { approvedAt: 500 });
  pdb.setBuildJobStatus(pj3.id, 'queued');
  pdb.updateBuildJob(pj1.id, { approvedAt: 400 });
  pdb.setBuildJobStatus(pj1.id, 'queued');
  check('queued jobs: approvedAt stored, still own their thread, do not use a slot', pdb.activeBuildJobInThread('pt3')?.status === 'queued' && pdb.countBuildingJobs() === 0 && sortQueue(pdb.listBuildJobsByStatus(['queued'])).map((j) => j.id).join(',') === `${pj1.id},${pj3.id}` && pdb.getBuildJob(pj3.id)!.approvedAt === 500);
  pdb.setBuildJobStatus(pj1.id, 'building');
  check('countBuildingJobs counts building (incl. fix runs)', pdb.countBuildingJobs() === 1);
  check('new columns default', pj2.approvedAt === null && pj2.resumeCount === 0 && pj2.fixAttempts === 0 && !pj2.conflictNotified);
  pdb.updateBuildJob(pj2.id, { resumeCount: 2, fixAttempts: 1, conflictNotified: true });
  const pj2b = pdb.getBuildJob(pj2.id)!;
  check('resume_count / fix_attempts / conflict_notified persist', pj2b.resumeCount === 2 && pj2b.fixAttempts === 1 && pj2b.conflictNotified === true);
  pdb.updateBuildJob(pj2.id, { planMessageId: 'm9', planPostedAt: 77, lastPlan: '- p', triggerMessageId: 'm1' });
  const pj2c = pdb.getBuildJob(pj2.id)!;
  check('plan tracking columns persist (new default null)', pj2.planPostedAt === null && pj2.lastPlan === null && pj2.triggerMessageId === null && pj2c.planMessageId === 'm9' && pj2c.planPostedAt === 77 && pj2c.lastPlan === '- p' && pj2c.triggerMessageId === 'm1' && pdb.createBuildJob({ guildId: G, threadId: 'pt9', channelId: 'c', requesterId: 'u', request: 'z', triggerMessageId: 'tm' }).triggerMessageId === 'tm');
  pdb.updateBuildJob(pj2.id, { resumeCount: 0 });
  check('resume_count can be reset to 0 (per-phase budget)', pdb.getBuildJob(pj2.id)!.resumeCount === 0);
  const qhtml = requestsPage({ jobs: pdb.recentBuildJobs(G, 50), totals: pdb.buildUsageTotals(G), chatTotals: pdb.chatUsageTotals(G), chats: [], page: 1, pages: 1, pageSize: 50, chatPage: 1, chatPages: 1, chatPageSize: 20, guildId: G, timezone: 'UTC', members: {}, user: { username: 'x', avatar: 'a' }, queuePositions: { [pj3.id]: 1 } });
  check('requests page shows queued position', qhtml.includes('queued #1'));

  // Migration: an older build_jobs table (no queue/resume/fix columns) gains them.
  const qdir = mkdtempSync(join(tmpdir(), 'bojan-queue-old-'));
  const qraw = new DatabaseSync(join(qdir, 'q.db'));
  qraw.exec(`CREATE TABLE build_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, thread_id TEXT NOT NULL, channel_id TEXT NOT NULL, requester_id TEXT NOT NULL, request TEXT NOT NULL, title TEXT, status TEXT NOT NULL, session_id TEXT, worktree_dir TEXT, branch TEXT, pr_url TEXT, error TEXT, model TEXT, tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  qraw.exec(`INSERT INTO build_jobs (guild_id, thread_id, channel_id, requester_id, request, status, created_at, updated_at) VALUES ('g', 't', 'c', 'u', 'old', 'building', 1, 1)`);
  qraw.close();
  const qdb = new BotDatabase(join(qdir, 'q.db'));
  const qold = qdb.getBuildJob(1)!;
  check('old build_jobs gets approved_at / resume_count / fix_attempts / conflict_notified', qold.approvedAt === null && qold.resumeCount === 0 && qold.fixAttempts === 0 && qold.conflictNotified === false && qdb.countBuildingJobs() === 1);
  check('old build_jobs gets plan tracking columns', qold.triggerMessageId === null && qold.planMessageId === null && qold.planPostedAt === null && qold.lastPlan === null);
  qdb.updateBuildJob(1, { approvedAt: 7, resumeCount: 1, planPostedAt: 5, lastPlan: 'p' });
  check('migrated columns are writable', qdb.getBuildJob(1)!.approvedAt === 7 && qdb.getBuildJob(1)!.resumeCount === 1);
  qdb.close();

  // Migration: a database from before build_jobs gets the table on open.
  const odir = mkdtempSync(join(tmpdir(), 'bojan-builder-old-'));
  const raw = new DatabaseSync(join(odir, 'old.db'));
  raw.exec('CREATE TABLE bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  raw.close();
  const odb = new BotDatabase(join(odir, 'old.db'));
  check('old database gets build_jobs on open', odb.recentBuildJobs(G, 100).length === 0 && !odb.getBuilderSettings().enabled);
  odb.close();
}

{
  check('buildingActivity: none -> null', buildingActivity([]) === null);
  check('buildingActivity: one title', buildingActivity(['Add dark mode']) === 'Building Add dark mode');
  check('buildingActivity: untitled falls back', buildingActivity([null]) === 'Building a feature' && buildingActivity(['  ']) === 'Building a feature');
  check('buildingActivity: several jobs', buildingActivity(['a', null, 'c']) === 'Building 3 features');
  const longActivity = buildingActivity(['x'.repeat(300)]) ?? '';
  check('buildingActivity: clipped to 120', longActivity.length === 120 && longActivity.endsWith('…'));
  check('reactionChannelFor: starter message -> parent, others -> thread', reactionChannelFor('T1', 'T1', 'P1') === 'P1' && reactionChannelFor('M2', 'T1', 'P1') === 'T1');
  check('pickReplyTarget: empty batch', pickReplyTarget([]) === null);
  check('pickReplyTarget: latest directed wins', pickReplyTarget([{ messageId: '1', directed: true }, { messageId: '2', directed: true }, { messageId: '3', directed: false }]) === '2');
  check('pickReplyTarget: falls back to last message', pickReplyTarget([{ messageId: '1', directed: false }, { messageId: '2', directed: false }]) === '2');
  {
    const att = (name: string, contentType: string | null, size: number) => ({ name, url: `https://cdn/${name}`, contentType, size });
    const picked = selectImages([att('a.png', 'image/png', 100), att('doc.pdf', 'application/pdf', 100), att('b.jpg', 'image/jpeg; charset=x', 100), att('none', null, 100), att('huge.png', 'image/png', 6 * 1024 * 1024)]);
    check('selectImages: only images, in order, within size', picked.map((p) => p.name).join(',') === 'a.png,b.jpg' && picked[1]!.mime === 'image/jpeg');
    check('selectImages: capped at 4', selectImages(Array.from({ length: 7 }, (_, i) => att(`${i}.png`, 'image/png', 1))).length === 4);
    check('selectImages: empty', selectImages([]).length === 0);
  }
}

{
  // ---- session transcript page + cache percent ----
  check('cachePercent: zero denominator', cachePercent({ input: 0, cacheRead: 0, cacheWrite: 0 }) === 0);
  check('cachePercent: normal case', cachePercent({ input: 100, cacheRead: 700, cacheWrite: 200 }) === 70);
  check('cachePercent: rounds to whole percent', cachePercent({ input: 2, cacheRead: 1, cacheWrite: 0 }) === 33 && cachePercent({ input: 1, cacheRead: 2, cacheWrite: 0 }) === 67 && cachePercent({ input: 0, cacheRead: 5, cacheWrite: 0 }) === 100);
  check('tokensCell: last value is cache %', tokensCell({ input: 1000, output: 50, reasoning: 10, cacheRead: 9000, cacheWrite: 0 }) === '1,000 / 50 / 10 / 90%' || tokensCell({ input: 1000, output: 50, reasoning: 10, cacheRead: 9000, cacheWrite: 0 }).endsWith('/ 90%'), tokensCell({ input: 1000, output: 50, reasoning: 10, cacheRead: 9000, cacheWrite: 0 }));

  const raw: unknown[] = [
    { id: 'm1', type: 'user', time: { created: 1000 }, text: 'build it', files: [{ name: 'a.png', mime: 'image/png' }] },
    {
      id: 'm2', type: 'assistant', time: { created: 2000 }, agent: 'build', model: { id: 'glm', providerID: 'opencode-go' }, finish: 'stop', cost: 0.01,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 0 } },
      content: [
        { type: 'reasoning', text: 'hmm <script>alert(1)</script>' },
        { type: 'text', text: 'hello' },
        { type: 'tool', id: 't1', name: 'read', state: { status: 'completed', input: { path: 'a.ts' }, content: [{ type: 'text', text: 'line1' }, { type: 'file', uri: 'x', mime: 'image/png', name: 'pic.png' }, { type: 'file', uri: 'y', mime: 'application/pdf' }] }, time: { created: 2100, ran: 2200, completed: 2700 } },
        { type: 'tool', id: 't2', name: 'bash', state: { status: 'error', input: { command: 'ls' }, error: { type: 'ToolError', message: 'boom' } }, time: { created: 2800 } },
      ],
    },
    { id: 'm3', type: 'assistant', time: { created: 3000 }, model: { id: 'glm', providerID: 'p' }, content: [], error: { type: 'ProviderError', message: 'rate limited' } },
    { id: 'm4', type: 'agent-switched', time: { created: 4000 }, agent: 'plan', previous: 'build' },
    { id: 'm5', type: 'brand-new-type', time: { created: 5000 } },
    null,
    { type: 'assistant' },
  ];
  const tr = normalizeTranscript(raw);
  check('transcript: skips non-objects, keeps order', tr.length === 6 && tr.map((e) => e.kind).join() === 'user,assistant,assistant,event,event,assistant');
  const u0 = tr[0]!;
  check('transcript: user text + attachment', u0.kind === 'user' && u0.text === 'build it' && u0.attachments[0] === '[file: a.png]');
  const a1 = tr[1]!;
  check('transcript: assistant meta', a1.kind === 'assistant' && a1.agent === 'build' && a1.model === 'opencode-go/glm' && a1.finish === 'stop' && a1.cost === 0.01 && a1.tokens?.cacheRead === 300 && a1.parts.length === 4);
  const tool1 = a1.kind === 'assistant' ? a1.parts[2] : undefined;
  check('transcript: completed tool has pretty input, joined output, files and duration', tool1?.kind === 'tool' && tool1.status === 'completed' && tool1.input.includes('"path": "a.ts"') && tool1.output === 'line1\n[file: pic.png]\n[file: application/pdf]' && tool1.durationMs === 500 && tool1.error === null);
  const tool2 = a1.kind === 'assistant' ? a1.parts[3] : undefined;
  check('transcript: tool error', tool2?.kind === 'tool' && tool2.status === 'error' && tool2.error === 'ToolError: boom' && tool2.durationMs === null);
  check('transcript: assistant error string', tr[2]!.kind === 'assistant' && (tr[2] as { error: string | null }).error === 'ProviderError: rate limited');
  check('transcript: events (known and unknown type) render a label', tr[3]!.kind === 'event' && (tr[3] as { label: string }).label === 'Agent: build → plan' && tr[4]!.kind === 'event' && (tr[4] as { label: string }).label === 'brand-new-type');
  check('transcript: malformed assistant tolerated', tr[5]!.kind === 'assistant' && (tr[5] as { parts: unknown[] }).parts.length === 0);
  const big = normalizeTranscript([
    { id: 'b1', type: 'user', text: 'x'.repeat(MAX_TEXT_CHARS + 50) },
    { id: 'b2', type: 'assistant', content: [{ type: 'tool', name: 'big', state: { status: 'completed', input: 'i'.repeat(MAX_TOOL_INPUT_CHARS + 10), content: [{ type: 'text', text: 'o'.repeat(MAX_TOOL_OUTPUT_CHARS + 7) }] }, time: { created: 1 } }] },
  ]);
  const bt = big[1]!.kind === 'assistant' ? big[1]!.parts[0] : undefined;
  check('transcript: clipping with marker', big[0]!.kind === 'user' && big[0]!.text.endsWith('… (50 more chars)') && bt?.kind === 'tool' && bt.input.endsWith('… (10 more chars)') && bt.output.endsWith('… (7 more chars)') && clipText('abc', 5) === 'abc');

  const calls: unknown[] = [];
  const fakeClient = { message: { list: async (input: unknown) => { calls.push(input); return { data: [{ id: 'n2', type: 'user', text: 'new' }, { id: 'n1', type: 'user', text: 'old' }], cursor: { next: 'CUR', previous: null } }; } } };
  const page = await fetchTranscript(fakeClient, 'ses_abc', { limit: 2, cursor: 'C0' });
  check('fetchTranscript: cursor request has no order, newest-first result, older cursor', !('order' in (calls[0] as object)) && (calls[0] as { cursor: string }).cursor === 'C0' && page.entries.map((e) => e.id).join() === 'n2,n1' && page.olderCursor === 'CUR');
  const short = await fetchTranscript(fakeClient, 'ses_abc', { limit: 60 });
  check('fetchTranscript: first page requests order desc without cursor', (calls[1] as { order: string }).order === 'desc' && !('cursor' in (calls[1] as object)));
  const ascClient = { message: { list: async () => ({ data: [{ id: 'a1', type: 'user', text: 'old', time: { created: 1 } }, { id: 'a2', type: 'user', text: 'new', time: { created: 2 } }], cursor: { next: null, previous: null } }) } };
  const ascPage = await fetchTranscript(ascClient, 'ses_abc', { limit: 2, cursor: 'C1' });
  check('fetchTranscript: ascending page is sorted newest first', ascPage.entries.map((e) => e.id).join() === 'a2,a1');
  check('fetchTranscript: no older cursor on a short page', short.olderCursor === null);
  let timedOut = false;
  try {
    await fetchTranscript({ message: { list: () => new Promise(() => {}) } }, 'ses_abc', { timeoutMs: 20 });
  } catch (err) {
    timedOut = err instanceof Error && err.message.includes('timed out');
  }
  check('fetchTranscript: times out', timedOut);

  const job = { id: 7, guildId: G, threadId: 'th7', channelId: 'c', requesterId: 'u1', request: 'req', title: 'T <i>', status: 'building', sessionId: 'ses_job7', planSessionId: 'ses_plan7', worktreeDir: null, branch: null, prUrl: 'https://github.com/x/y/pull/1', error: null, model: 'opencode-go/glm', tokensInput: 100, tokensOutput: 20, tokensReasoning: 5, tokensCacheRead: 300, tokensCacheWrite: 0, costUsd: 0.5, createdAt: 1, updatedAt: 1, approvedAt: null, triggerMessageId: null, planMessageId: null, planPostedAt: null, lastPlan: null, resumeCount: 0, fixAttempts: 0, conflictNotified: false } as const;
  const sdata: SessionPageData = {
    sessionId: 'ses_job7', owner: { kind: 'job', job }, entries: normalizeTranscript([
      { id: 'e1', type: 'assistant', time: { created: 1 }, tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 300, write: 0 } }, content: [
        { type: 'reasoning', text: '<script>alert("r")</script>' },
        { type: 'tool', name: 'bash', state: { status: 'completed', input: { command: '<b>x</b>' }, content: [{ type: 'text', text: '<script>alert(1)</script>' }] }, time: { created: 1 } },
      ] },
    ]), olderCursor: 'OLD', cursor: null, error: null, guildId: G, timezone: 'UTC', members: { u1: 'Ann' }, user: { username: 'x', avatar: null },
  };
  const sp = sessionParts(sdata);
  const all = Object.values(sp).join('');
  check('sessionParts: escapes tool output, input and reasoning', !all.includes('<script>') && !all.includes('<b>x</b>') && all.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && all.includes('&lt;b&gt;x&lt;/b&gt;'));
  check('sessionParts: stable details ids, thinking summary, escaped title', all.includes('<details id="d-e1-0">') && all.includes('<details id="d-e1-1">') && all.includes('Thinking · ') && all.includes('T &lt;i&gt;') && !all.includes('T <i>'));
  check('sessionParts: cache % in header and per message, older link', all.includes('75%') && all.includes('cache 75%') && all.includes('/dashboard/sessions/ses_job7?cursor=OLD'));
  check('sessionParts: fetch error is shown instead of the timeline', sessionParts({ ...sdata, entries: [], error: 'agent <down>' })['live-session']!.includes('agent &lt;down&gt;'));
  const rhtml = requestsParts({ jobs: [job], totals: { jobs: 1, input: 100, output: 20, reasoning: 5, cacheRead: 300, cacheWrite: 0, costUsd: 0.5 }, chatTotals: { threads: 1, oneOffs: 0, input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, chats: [{ threadId: 'ct9', guildId: G, channelId: 'c', sessionId: 'ses_chat9', startedBy: 'u1', model: null, oneOff: false, tokensInput: 10, tokensOutput: 1, tokensReasoning: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0, createdAt: 1, lastActiveAt: 1 }], page: 1, pages: 1, pageSize: 20, chatPage: 1, chatPages: 1, chatPageSize: 20, guildId: G, timezone: 'UTC', members: {}, user: { username: 'x', avatar: null } });
  const requestsHtml = Object.values(rhtml).join('');
  const rp = requestsParts({ jobs: [job], totals: { jobs: 45, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, chatTotals: { threads: 40, oneOffs: 5, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, chats: [], page: 2, pages: 3, pageSize: 10, chatPage: 2, chatPages: 3, chatPageSize: 10, guildId: G, timezone: 'UTC', members: {}, user: { username: 'x', avatar: null } });
  const rp2 = requestsParts({ jobs: [job], totals: { jobs: 450, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, chatTotals: { threads: 400, oneOffs: 50, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, chats: [], page: 2, pages: 9, pageSize: 50, chatPage: 3, chatPages: 5, chatPageSize: 100, guildId: G, timezone: 'UTC', members: {}, user: { username: 'x', avatar: null } });
  check(
    'requestsParts: size dropdowns keep the other list page+size and reset their own page',
    rp2['live-reqs']!.includes('href="/dashboard/requests?page=3&amp;size=50&amp;chatPage=3&amp;chatSize=100#h-req">Next</a>') &&
      rp2['live-reqs']!.includes('<option value="/dashboard/requests?size=20&amp;chatPage=3&amp;chatSize=100#h-req">20 rows</option>') &&
      rp2['live-reqs']!.includes('<option value="/dashboard/requests?size=50&amp;chatPage=3&amp;chatSize=100#h-req" selected>50 rows</option>') &&
      rp2['live-chats']!.includes('<option value="/dashboard/requests?page=2&amp;size=50#h-chat">10 rows</option>') &&
      rp2['live-chats']!.includes('<option value="/dashboard/requests?page=2&amp;size=50&amp;chatSize=100#h-chat" selected>100 rows</option>'),
  );
  check('logsHref: keeps level/tag/size, omits defaults', logsHref('all', null) === '/dashboard/logs' && logsHref('warn', 'a b', 1, 50) === '/dashboard/logs?level=warn&tag=a+b&size=50' && logsHref('all', null, 3, 20) === '/dashboard/logs?page=3&size=20' && logsHref('error', null, 2) === '/dashboard/logs?level=error&page=2');
  const lp = logsParts({ rows: [], tags: [], level: 'warn', tag: 't', page: 2, pages: 4, pageSize: 20, total: 70, timezone: 'UTC', user: { username: 'x', avatar: null } })['live-logs']!;
  check(
    'logsParts: pager links and size dropdown keep filters and size',
    lp.includes('href="/dashboard/logs?level=warn&amp;tag=t&amp;size=20#h-logs">Previous</a>') && lp.includes('href="/dashboard/logs?level=warn&amp;tag=t&amp;page=3&amp;size=20#h-logs">Next</a>') &&
      lp.includes('<option value="/dashboard/logs?level=warn&amp;tag=t#h-logs">10 rows</option>') && lp.includes('<option value="/dashboard/logs?level=warn&amp;tag=t&amp;size=20#h-logs" selected>20 rows</option>'),
  );
  check(
    'parsePageSize: valid sizes pass, junk and missing fall back to 10',
    [10, 20, 50, 100].every((n) => parsePageSize(String(n)) === n) && parsePageSize(undefined) === 10 && parsePageSize('') === 10 && parsePageSize('abc') === 10 && parsePageSize('15') === 10 && parsePageSize('1000') === 10 && parsePageSize('-20') === 10 && parsePageSize('20x') === 10 && parsePageSize('0') === 10,
  );
  const psz = pagerHtml({ page: 1, pages: 1, summary: 'S', href: () => '/', label: 'L', showSingle: true, size: { current: 50, href: (n) => `/x?a=1&size=${n}` } });
  check(
    'pagerHtml size: four options, current selected, hrefs escaped, shown on a single page',
    (psz.match(/<option /g) ?? []).length === 4 && psz.includes('aria-label="Rows per page"') && psz.includes('<option value="/x?a=1&amp;size=50" selected>50 rows</option>') && (psz.match(/ selected>/g) ?? []).length === 1 && psz.includes('<option value="/x?a=1&amp;size=100">100 rows</option>') && !psz.includes('pager-nav') &&
      !pagerHtml({ page: 1, pages: 1, summary: 'S', href: () => '/', label: 'L', size: { current: 10, href: () => '/' } }).includes('<select'),
  );
  check(
    'requestsParts: both pagers keep the other param and anchor to their card',
    rp['live-reqs']!.includes('href="/dashboard/requests?chatPage=2#h-req">Previous</a>') && rp['live-reqs']!.includes('href="/dashboard/requests?page=3&amp;chatPage=2#h-req">Next</a>') &&
      rp['live-chats']!.includes('href="/dashboard/requests?page=2#h-chat">Previous</a>') && rp['live-chats']!.includes('href="/dashboard/requests?page=2&amp;chatPage=3#h-chat">Next</a>') && rp['live-chats']!.includes('45 total') && !rp['live-chats']!.includes('most recently active'),
  );
  check('requestsParts: single-page lists show only the Showing summary, no nav', !requestsHtml.includes('pager-nav') && requestsHtml.includes('Showing 1–1 of 1') && !requestsHtml.includes(' requests</p>') && !requestsHtml.includes(' chats</p>'));
  const tl = (ids: string[], extra: Partial<SessionPageData> = {}): string => sessionParts({ ...sdata, entries: normalizeTranscript(ids.map((id, i) => ({ id, type: 'user', text: `T-${id}`, time: { created: i } }))).reverse(), ...extra })['live-session']!;
  const newestFirst = tl(['b', 'a']);
  check('sessionParts: entries render in the given (newest first) order, sub text says newest first', newestFirst.indexOf('T-a') < newestFirst.indexOf('T-b') && newestFirst.includes('newest first') && !newestFirst.includes('oldest first'));
  const olderPage = tl(['b', 'a'], { cursor: 'C1', olderCursor: 'C2' });
  check('sessionParts: pager only below the transcript, with Latest and Older', olderPage.indexOf('class="tl"') < olderPage.indexOf('Latest messages') && olderPage.indexOf('Latest messages') < olderPage.indexOf('Older messages') && olderPage.indexOf('class="pager"') > olderPage.indexOf('T-a') && !tl(['b'], { olderCursor: null }).includes('pager'));
  const tm = normalizeTranscript([
    { id: 'u', type: 'user', text: 'hi', time: { created: 1000 } },
    { id: 'a1', type: 'assistant', time: { created: 2000, firstToken: 50_200, completed: 72_000 }, retry: { attempt: 2, at: 1, error: { type: 'rate', message: 'slow <down>' } }, content: [
      { type: 'tool', name: 'bash', state: { status: 'completed' }, time: { created: 60_000, completed: 64_000 } },
      { type: 'tool', name: 'read', state: { status: 'completed' }, time: { created: 64_000, ran: 65_000, completed: 66_500 } },
      { type: 'tool', name: 'x', state: { status: 'running' }, time: { created: 66_600 } },
    ] },
    { id: 'a2', type: 'assistant', time: { created: 70_000 }, content: [] },
    { id: 'a3', type: 'assistant', time: { created: 80_000 }, content: [] },
  ]);
  const ta = tm[1] as Extract<(typeof tm)[number], { kind: 'assistant' }>;
  check('timing: first token, total, tools sum, retry string', ta.timing.firstTokenMs === 48_200 && ta.timing.totalMs === 70_000 && ta.timing.toolsMs === 5500 && ta.timing.retry === 'attempt 2: rate: slow <down>');
  const tb = tm[2] as Extract<(typeof tm)[number], { kind: 'assistant' }>;
  check('timing: missing firstToken/completed/tools/retry are null', tb.timing.firstTokenMs === null && tb.timing.totalMs === null && tb.timing.toolsMs === null && tb.timing.retry === null);
  check('gapMs: first entry null, normal gap from completed, negative -> null, created fallback', tm[0]!.gapMs === null && tm[1]!.gapMs === 1000 && tm[2]!.gapMs === null && tm[3]!.gapMs === 10_000);
  check('fmtMs: ms, seconds, minutes', fmtMs(450) === '450 ms' && fmtMs(14_100) === '14.1 s' && fmtMs(72_000) === '1 min 12 s' && fmtMs(63_000) === '1 min 3 s');
  const timingHtml = sessionParts({ ...sdata, entries: [...tm].reverse() })['live-session']!;
  console.log('sample timing line:', (timingHtml.match(/<div class="toks">waited[^<]*<\/div>/) ?? [''])[0]);
  check('sessionParts: timing line rendered and escaped, idle shown from 5 s', timingHtml.includes('waited 48.2 s for first token · total 1 min 10 s · tools 5.5 s · retry: attempt 2: rate: slow &lt;down&gt;') && !timingHtml.includes('slow <down>') && timingHtml.includes('idle 10.0 s before this step') && !timingHtml.includes('idle 1.0 s'));
  check('requestsParts: session links for jobs and chats', requestsHtml.includes('href="/dashboard/sessions/ses_job7"') && requestsHtml.includes('href="/dashboard/sessions/ses_chat9"'));
  check('requestsParts: tokens cell and KPI use cache %', requestsHtml.includes('<td data-label="Tokens">100 / 20 / 5 / 75%</td>') && requestsHtml.includes('Cache hits') && !requestsHtml.includes('Cached tokens'));
  console.log('sample tokens cells:', (requestsHtml.match(/<td data-label="Tokens">[^<]*<\/td>/g) ?? []).join(' | '));
  const ownerDb = new BotDatabase(join(mkdtempSync(join(tmpdir(), 'bojan-owner-')), 'owner.db'));
  const oj = ownerDb.createBuildJob({ guildId: G, threadId: 'tx', channelId: 'c', requesterId: 'u', request: 'r' });
  ownerDb.updateBuildJob(oj.id, { sessionId: 'ses_own1' });
  ownerDb.createChatThread({ threadId: 'cx', guildId: G, channelId: 'c', sessionId: 'ses_own2', startedBy: 'u', model: null });
  const o1 = ownerDb.findSessionOwner(G, 'ses_own1');
  const o2 = ownerDb.findSessionOwner(G, 'ses_own2');
  check('findSessionOwner: job, chat, other guild, unknown', o1?.kind === 'job' && o2?.kind === 'chat' && ownerDb.findSessionOwner('other', 'ses_own1') === null && ownerDb.findSessionOwner(G, 'ses_nope') === null);
  ownerDb.updateBuildJob(oj.id, { planSessionId: 'ses_plan1', sessionId: 'ses_build1' });
  const oj2 = ownerDb.getBuildJob(oj.id);
  const op = ownerDb.findSessionOwner(G, 'ses_plan1');
  check('planSessionId round trip + findSessionOwner by plan and build session id', oj.planSessionId === null && oj2?.planSessionId === 'ses_plan1' && oj2.sessionId === 'ses_build1' && op?.kind === 'job' && op.job.id === oj.id && ownerDb.findSessionOwner(G, 'ses_build1')?.kind === 'job' && ownerDb.findSessionOwner(G, 'ses_own1') === null);
  ownerDb.close();
  check('requestsParts: Plan link next to Session link', requestsHtml.includes('<a href="/dashboard/sessions/ses_plan7">Plan</a>') && !requestsParts({ jobs: [{ ...job, planSessionId: null }], totals: { jobs: 1, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, chatTotals: { threads: 0, oneOffs: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, chats: [], page: 1, pages: 1, pageSize: 20, chatPage: 1, chatPages: 1, chatPageSize: 20, guildId: G, timezone: 'UTC', members: {}, user: { username: 'x', avatar: null } })['live-reqs']!.includes('>Plan<'));
  check('sessionParts: header says plan session vs build session', sessionParts({ ...sdata, sessionId: 'ses_plan7' })['live-session-head']!.includes('Plan session') && sp['live-session-head']!.includes('Build session'));
  const bp = buildPrompt({ request: 'add <ping>', title: 'Ping', plan: '- edit a.ts\n- test' });
  check('buildPrompt: request, title, plan, approval', bp.includes('add <ping>') && bp.includes('Title: Ping') && bp.includes('Approved plan:\n- edit a.ts\n- test') && bp.includes('approved') && bp.includes('Implement it now') && !buildPrompt({ request: 'r', title: null, plan: 'p' }).includes('Title:'));
  const us = addUsage({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, costUsd: 0.5 }, { input: 10, output: 20, reasoning: 30, cacheRead: 40, cacheWrite: 50, costUsd: 0.25 });
  check('addUsage sums every field', us.input === 11 && us.output === 22 && us.reasoning === 33 && us.cacheRead === 44 && us.cacheWrite === 55 && us.costUsd === 0.75);
}

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
