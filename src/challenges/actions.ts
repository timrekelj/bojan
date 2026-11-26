import {
  ActionRowBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type ForumChannel,
  type ModalSubmitInteraction,
  type SendableChannels,
} from 'discord.js';
import type { BotDatabase, Challenge, ChallengeGoal } from '../db.js';
import { buildChallengeCard, goalProgressLines, goalProgressText, manualLogRow } from './cards.js';
import {
  challengeStatus,
  formatChallengeTarget,
  formatChallengeValue,
  goalRemaining,
  MAX_SET_VALUE,
  overallRankProgress,
  parseChallengeButtonId,
  parseChallengeLogId,
  parseEntryValue,
  shouldFlagEntry,
} from './form.js';
import { goalName, isManualMetric, type ChallengeMetric } from './types.js';

export interface NewChallengeInput {
  guildId: string;
  name: string;
  description: string;
  metric: ChallengeMetric;
  activityName: string | null;
  /** Custom goal name; null for the built-in metrics. */
  label: string | null;
  /** Count for messages/reactions, minutes for voice/activity; 0 = no target. */
  target: number;
  startsAt: number;
  endsAt: number;
  channelId: string;
  rewardRoleId: string | null;
  createdBy: string;
  /** Dashboard username of the admin who created it, for the event log. */
  createdByName: string;
}

/** Retention: the reward role is granted permanently to the top 3 with progress > 0. */
const REWARD_POSITIONS = 3;

/** Goals of a challenge plus per-goal, per-member progress in storage units. */
export function challengeGoalTotals(db: BotDatabase, challenge: Challenge, now = Date.now()): { goals: ChallengeGoal[]; totalsByGoal: Record<number, Record<string, number>> } {
  const goals = db.challengeGoals(challenge.id);
  const totalsByGoal: Record<number, Record<string, number>> = {};
  for (const goal of goals) {
    totalsByGoal[goal.id] = isManualMetric(goal.metric)
      ? db.challengeEntryTotals(goal.id, challenge.startsAt, challenge.endsAt)
      : db.challengeTotals(challenge.guildId, goal.metric, goal.activityName, challenge.startsAt, challenge.endsAt, now);
  }
  return { goals, totalsByGoal };
}

function cardData(db: BotDatabase, challenge: Challenge, now: number) {
  const { goals, totalsByGoal } = challengeGoalTotals(db, challenge, now);
  return {
    challenge,
    participants: db.challengeParticipants(challenge.id),
    goals,
    totalsByGoal,
    timeZone: db.getSettings(challenge.guildId).timezone,
    now,
  };
}

/** Forum-style channels get one post (thread) per challenge instead of a plain message. */
export function isForumChannelType(type: ChannelType): boolean {
  return type === ChannelType.GuildForum || type === ChannelType.GuildMedia;
}

/**
 * Insert the challenge, post its card and remember the message id. A send
 * failure removes the row again so the dashboard never shows a challenge
 * whose card nobody can see (or join).
 */
export async function createAndPostChallenge(
  db: BotDatabase,
  input: NewChallengeInput,
  channel: SendableChannels | ForumChannel,
  now = Date.now(),
): Promise<{ ok: true; challenge: Challenge } | { ok: false; reason: string }> {
  const challenge = db.createChallenge(input, now);
  try {
    const card = buildChallengeCard(cardData(db, challenge, now));
    let messageId: string;
    let threadId: string | null = null;
    if (isForumChannelType(channel.type)) {
      // For a forum post the starter message id and the thread id are the same.
      const thread = await (channel as ForumChannel).threads.create({
        name: input.name.slice(0, 100),
        message: card,
      });
      messageId = thread.id;
      threadId = thread.id;
    } else {
      const message = await (channel as SendableChannels).send(card);
      messageId = message.id;
    }
    db.setChallengeMessage(challenge.id, messageId, threadId);
    db.addChallengeEvent({ challengeId: challenge.id, ts: now, kind: 'created', actorId: input.createdBy, actorName: input.createdByName });
    console.log(`[challenges] guild ${challenge.guildId}: created challenge #${challenge.id} "${challenge.name}" in ${threadId ? `forum thread ${threadId}` : `channel ${challenge.channelId}`}`);
    return { ok: true, challenge: { ...challenge, messageId, threadId } };
  } catch (err) {
    db.deleteChallenge(challenge.id);
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[challenges] guild ${challenge.guildId}: could not post challenge #${challenge.id}: ${reason}`);
    return { ok: false, reason };
  }
}

/** Rebuild and edit the posted card (leaderboards, join counts). Best-effort; returns success. */
export async function refreshChallengeCard(client: Client, db: BotDatabase, challenge: Challenge, now = Date.now()): Promise<boolean> {
  if (!challenge.messageId) return false;
  try {
    const channel = await client.channels.fetch(challenge.threadId ?? challenge.channelId).catch(() => null);
    if (!channel || !channel.isSendable()) return false;
    const message = await channel.messages.fetch(challenge.messageId).catch(() => null);
    if (!message) return false;
    await message.edit(buildChallengeCard(cardData(db, challenge, now)));
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[challenges] guild ${challenge.guildId}: could not refresh card of #${challenge.id}: ${reason}`);
    return false;
  }
}

/** upcoming -> active: log it and refresh the card (whose header switches from Starts to Until). */
export async function beginChallenge(client: Client, db: BotDatabase, challenge: Challenge, now = Date.now()): Promise<Challenge | null> {
  if (!db.startChallenge(challenge.id, now)) return null;
  const started: Challenge = { ...challenge, status: 'active' };
  db.addChallengeEvent({ challengeId: challenge.id, ts: now, kind: 'started' });
  await refreshChallengeCard(client, db, started, now);
  console.log(`[challenges] guild ${challenge.guildId}: started challenge #${challenge.id}`);
  return started;
}

/**
 * End a challenge: mark it ended, grant the reward role to the top 3 by the
 * mean goal share (progress > 0) and refresh the card without buttons.
 * Idempotent (a second call, or a race with the ticker, does nothing).
 */
export async function finalizeChallenge(client: Client, db: BotDatabase, challenge: Challenge, now = Date.now(), actor: { id: string; name: string } | null = null): Promise<Challenge | null> {
  if (!db.endChallenge(challenge.id, now)) return null;
  const ended: Challenge = { ...challenge, status: 'ended', endedAt: challenge.endedAt ?? now };
  const names = new Map(db.challengeParticipants(challenge.id).map((p) => [p.userId, p.displayName]));
  const { goals, totalsByGoal } = challengeGoalTotals(db, challenge, now);
  let rewarded = 0;
  if (challenge.rewardRoleId) {
    const guild = client.guilds.cache.get(challenge.guildId) ?? (await client.guilds.fetch(challenge.guildId).catch(() => null));
    const role = guild ? guild.roles.cache.get(challenge.rewardRoleId) ?? (await guild.roles.fetch(challenge.rewardRoleId).catch(() => null)) : null;
    if (guild && role) {
      const rows = overallRankProgress(db.challengeParticipants(challenge.id), goals, totalsByGoal)
        .filter((r) => r.share > 0)
        .slice(0, REWARD_POSITIONS);
      for (const row of rows) {
        const member = await guild.members.fetch(row.userId).catch(() => null);
        if (!member) continue;
        try {
          await member.roles.add(role, `Challenge #${challenge.id} top ${REWARD_POSITIONS}`);
          rewarded++;
          db.addChallengeEvent({ challengeId: challenge.id, ts: now, kind: 'reward', actorId: row.userId, actorName: names.get(row.userId) ?? null, detail: `rank ${row.rank}` });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`[challenges] guild ${challenge.guildId}: could not give role ${role.id} to ${row.userId}: ${reason}`);
        }
      }
    } else {
      console.warn(`[challenges] guild ${challenge.guildId}: reward role ${challenge.rewardRoleId} of challenge #${challenge.id} is gone`);
    }
  }
  db.addChallengeEvent({
    challengeId: challenge.id,
    ts: now,
    kind: 'ended',
    actorId: actor?.id ?? null,
    actorName: actor?.name.trim() || null,
    detail: `rewarded ${rewarded} member(s)`,
  });
  await refreshChallengeCard(client, db, ended, now);
  console.log(`[challenges] guild ${challenge.guildId}: ended challenge #${challenge.id}; rewarded ${rewarded} member(s)`);
  return ended;
}

function displayNameOf(interaction: ButtonInteraction | ModalSubmitInteraction): string {
  const member = interaction.member;
  return member && 'displayName' in member && typeof member.displayName === 'string' ? member.displayName : interaction.user.username;
}

function isParticipant(db: BotDatabase, challengeId: number, userId: string): boolean {
  return db.challengeParticipants(challengeId).some((p) => p.userId === userId);
}

function windowState(challenge: Challenge, now: number): 'upcoming' | 'active' | 'ended' {
  if (challenge.status === 'ended' || now >= challenge.endsAt) return 'ended';
  return now < challenge.startsAt ? 'upcoming' : 'active';
}

function openLogModal(interaction: ButtonInteraction, challenge: Challenge, goal: ChallengeGoal): Promise<void> {
  const name = goalName(goal);
  const suffix = ` (1–${MAX_SET_VALUE})`;
  const modal = new ModalBuilder()
    .setCustomId(`challenge:log:${challenge.id}:${goal.id}`)
    .setTitle(`Log ${name}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel(`${name.slice(0, 45 - suffix.length)}${suffix}`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(4),
      ),
    );
  return interaction.showModal(modal);
}

/** Join/Leave/My progress/Log set button: ephemeral reaction, then refresh the card for everyone. */
export async function handleChallengeButton(interaction: ButtonInteraction, client: Client, db: BotDatabase): Promise<void> {
  const log = parseChallengeLogId(interaction.customId);
  if (log) {
    const challenge = db.getChallenge(log.challengeId);
    const goal = db.getChallengeGoal(log.goalId);
    if (!challenge || !goal || goal.challengeId !== challenge.id) {
      await interaction.reply({ content: 'This challenge no longer exists.', ephemeral: true }).catch(() => undefined);
      return;
    }
    const now = Date.now();
    const state = windowState(challenge, now);
    if (state !== 'active') {
      await interaction.reply({ content: `**${challenge.name}** ${state === 'upcoming' ? 'has not started yet' : 'has ended'}.`, ephemeral: true }).catch(() => undefined);
      return;
    }
    if (!isParticipant(db, challenge.id, interaction.user.id)) {
      await interaction.reply({ content: `Join **${challenge.name}** before logging a set.`, ephemeral: true }).catch(() => undefined);
      return;
    }
    await openLogModal(interaction, challenge, goal).catch(() => undefined);
    return;
  }

  const parsed = parseChallengeButtonId(interaction.customId);
  const challenge = parsed ? db.getChallenge(parsed.challengeId) : null;
  if (!parsed || !challenge) {
    await interaction.reply({ content: 'This challenge no longer exists.', ephemeral: true }).catch(() => undefined);
    return;
  }
  const now = Date.now();
  const status = challengeStatus(challenge, now);
  if (status === 'ended') {
    await interaction.reply({ content: `**${challenge.name}** has ended.`, ephemeral: true }).catch(() => undefined);
    return;
  }
  const displayName = displayNameOf(interaction);

  if (parsed.action === 'my') {
    const { goals, totalsByGoal } = challengeGoalTotals(db, challenge, now);
    const rows = status === 'active' ? manualLogRow(challenge.id, goals) : [];
    await interaction
      .reply({ content: goalProgressLines(challenge, goals, totalsByGoal, interaction.user.id), ephemeral: true, ...(rows.length > 0 ? { components: rows } : {}) })
      .catch(() => undefined);
    return;
  }

  const changed = parsed.action === 'join' ? db.joinChallenge(challenge.id, interaction.user.id, displayName, now) : db.leaveChallenge(challenge.id, interaction.user.id);
  if (changed) {
    db.addChallengeEvent({ challengeId: challenge.id, ts: now, kind: parsed.action === 'join' ? 'joined' : 'left', actorId: interaction.user.id, actorName: displayName });
  }
  const content =
    parsed.action === 'join'
      ? changed
        ? `You joined **${challenge.name}**. Progress counts automatically until the end.`
        : `You are already taking part in **${challenge.name}**.`
      : changed
        ? `You left **${challenge.name}**.`
        : `You were not taking part in **${challenge.name}**.`;
  await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
  await refreshChallengeCard(client, db, challenge, now);
}

/**
 * Modal submit for a manual set: only joined members inside the active window
 * may log; the entry is recorded even when it is flagged for review. Updates
 * the card immediately so the leaderboard is current.
 */
export async function handleChallengeLogSubmit(interaction: ModalSubmitInteraction, client: Client, db: BotDatabase): Promise<void> {
  const parsed = parseChallengeLogId(interaction.customId);
  const challenge = parsed ? db.getChallenge(parsed.challengeId) : null;
  const goal = parsed ? db.getChallengeGoal(parsed.goalId) : null;
  if (!parsed || !challenge || !goal || goal.challengeId !== challenge.id || !isManualMetric(goal.metric)) {
    await interaction.reply({ content: 'This challenge no longer exists.', ephemeral: true }).catch(() => undefined);
    return;
  }
  const now = Date.now();
  const state = windowState(challenge, now);
  if (state !== 'active' || now < challenge.startsAt || now >= challenge.endsAt) {
    await interaction.reply({ content: `**${challenge.name}** ${state === 'upcoming' ? 'has not started yet' : 'has ended'}; entries are closed.`, ephemeral: true }).catch(() => undefined);
    return;
  }
  if (!isParticipant(db, challenge.id, interaction.user.id)) {
    await interaction.reply({ content: `Join **${challenge.name}** before logging a set.`, ephemeral: true }).catch(() => undefined);
    return;
  }
  const value = parseEntryValue(interaction.fields.getTextInputValue('value'));
  if (value === null) {
    await interaction.reply({ content: `Enter a whole number between 1 and ${MAX_SET_VALUE}.`, ephemeral: true }).catch(() => undefined);
    return;
  }

  const displayName = displayNameOf(interaction);
  const flagged = shouldFlagEntry(goal.metric, value);
  db.addChallengeEntry({ challengeId: challenge.id, goalId: goal.id, userId: interaction.user.id, displayName, value, flagged, createdAt: now });
  const label = `${value} ${goalName(goal).toLowerCase()}`;
  db.addChallengeEvent({
    challengeId: challenge.id,
    ts: now,
    kind: flagged ? 'entry_flagged' : 'entry',
    actorId: interaction.user.id,
    actorName: displayName,
    detail: flagged ? `${label} · flagged for review` : label,
  });

  const totals = db.challengeEntryTotals(goal.id, challenge.startsAt, challenge.endsAt);
  const total = totals[interaction.user.id] ?? 0;
  const remaining = goalRemaining(goal, total);
  const lines = [`Logged **${label}** for **${challenge.name}**.`, goalProgressText(goal, total, remaining)];
  if (goal.target > 0) lines.push(`Goal **${formatChallengeTarget(goal.metric, goal.target)}** · still ${formatChallengeValue(goal.metric, remaining)} to go.`);
  if (flagged) lines.push(`⚠️ This set is above 99 and was flagged for admin review.`);
  const rows = manualLogRow(challenge.id, db.challengeGoals(challenge.id));
  await interaction.reply({ content: lines.join('\n'), ephemeral: true, ...(rows.length > 0 ? { components: rows } : {}) }).catch(() => undefined);
  await refreshChallengeCard(client, db, challenge, now);
}
