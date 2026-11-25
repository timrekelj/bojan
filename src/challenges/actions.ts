import type { ButtonInteraction, Client, SendableChannels } from 'discord.js';
import type { BotDatabase, Challenge } from '../db.js';
import { buildChallengeCard } from './cards.js';
import { challengeStatus, parseChallengeButtonId, rankProgress } from './form.js';
import type { ChallengeMetric } from './types.js';

export interface NewChallengeInput {
  guildId: string;
  name: string;
  description: string;
  metric: ChallengeMetric;
  activityName: string | null;
  /** Count for messages/reactions, minutes for voice/activity. */
  target: number;
  startsAt: number;
  endsAt: number;
  channelId: string;
  rewardRoleId: string | null;
  createdBy: string;
}

/** Retention: the reward role is granted permanently to the top 3 with progress > 0. */
const REWARD_POSITIONS = 3;

function cardData(db: BotDatabase, challenge: Challenge, now: number) {
  return {
    challenge,
    participants: db.challengeParticipants(challenge.id),
    totals: db.challengeTotals(challenge.guildId, challenge.metric, challenge.activityName, challenge.startsAt, challenge.endsAt, now),
    timeZone: db.getSettings(challenge.guildId).timezone,
    now,
  };
}

/**
 * Insert the challenge, post its card and remember the message id. A send
 * failure removes the row again so the dashboard never shows a challenge
 * whose card nobody can see (or join).
 */
export async function createAndPostChallenge(
  db: BotDatabase,
  input: NewChallengeInput,
  channel: SendableChannels,
  now = Date.now(),
): Promise<{ ok: true; challenge: Challenge } | { ok: false; reason: string }> {
  const challenge = db.createChallenge(input, now);
  try {
    const message = await channel.send(buildChallengeCard(cardData(db, challenge, now)));
    db.setChallengeMessage(challenge.id, message.id);
    console.log(`[challenges] guild ${challenge.guildId}: created challenge #${challenge.id} "${challenge.name}" in channel ${challenge.channelId}`);
    return { ok: true, challenge: { ...challenge, messageId: message.id } };
  } catch (err) {
    db.deleteChallenge(challenge.id);
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[challenges] guild ${challenge.guildId}: could not post challenge #${challenge.id}: ${reason}`);
    return { ok: false, reason };
  }
}

/** Rebuild and edit the posted card (leaderboard + join counts). Best-effort; returns success. */
export async function refreshChallengeCard(client: Client, db: BotDatabase, challenge: Challenge, now = Date.now()): Promise<boolean> {
  if (!challenge.messageId) return false;
  try {
    const channel = await client.channels.fetch(challenge.channelId).catch(() => null);
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

/**
 * End a challenge: mark it ended, grant the reward role to the top 3 with
 * progress > 0 and refresh the card without buttons. Idempotent (a second
 * call, or a race with the ticker, does nothing). Returns the ended row, or
 * null when it was already ended.
 */
export async function finalizeChallenge(client: Client, db: BotDatabase, challenge: Challenge, now = Date.now()): Promise<Challenge | null> {
  if (!db.endChallenge(challenge.id, now)) return null;
  const ended: Challenge = { ...challenge, status: 'ended', endedAt: challenge.endedAt ?? now };
  let rewarded = 0;
  if (challenge.rewardRoleId) {
    const guild = client.guilds.cache.get(challenge.guildId) ?? (await client.guilds.fetch(challenge.guildId).catch(() => null));
    const role = guild ? guild.roles.cache.get(challenge.rewardRoleId) ?? (await guild.roles.fetch(challenge.rewardRoleId).catch(() => null)) : null;
    if (guild && role) {
      const rows = rankProgress(db.challengeParticipants(challenge.id), db.challengeTotals(challenge.guildId, challenge.metric, challenge.activityName, challenge.startsAt, challenge.endsAt, now))
        .filter((r) => r.value > 0)
        .slice(0, REWARD_POSITIONS);
      for (const row of rows) {
        const member = await guild.members.fetch(row.userId).catch(() => null);
        if (!member) continue;
        try {
          await member.roles.add(role, `Challenge #${challenge.id} top ${REWARD_POSITIONS}`);
          rewarded++;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`[challenges] guild ${challenge.guildId}: could not give role ${role.id} to ${row.userId}: ${reason}`);
        }
      }
    } else {
      console.warn(`[challenges] guild ${challenge.guildId}: reward role ${challenge.rewardRoleId} of challenge #${challenge.id} is gone`);
    }
  }
  await refreshChallengeCard(client, db, ended, now);
  console.log(`[challenges] guild ${challenge.guildId}: ended challenge #${challenge.id}; rewarded ${rewarded} member(s)`);
  return ended;
}

/** Join/leave button: ephemeral confirmation, then refresh the card for everyone. */
export async function handleChallengeButton(interaction: ButtonInteraction, client: Client, db: BotDatabase): Promise<void> {
  const parsed = parseChallengeButtonId(interaction.customId);
  const challenge = parsed ? db.getChallenge(parsed.challengeId) : null;
  if (!parsed || !challenge) {
    await interaction.reply({ content: 'This challenge no longer exists.', ephemeral: true }).catch(() => undefined);
    return;
  }
  const now = Date.now();
  if (challengeStatus(challenge, now) === 'ended') {
    await interaction.reply({ content: `**${challenge.name}** has ended.`, ephemeral: true }).catch(() => undefined);
    return;
  }
  const member = interaction.member;
  const displayName = member && 'displayName' in member && typeof member.displayName === 'string' ? member.displayName : interaction.user.username;
  const content =
    parsed.action === 'join'
      ? db.joinChallenge(challenge.id, interaction.user.id, displayName, now)
        ? `You joined **${challenge.name}**. Progress counts automatically until the end.`
        : `You are already taking part in **${challenge.name}**.`
      : db.leaveChallenge(challenge.id, interaction.user.id)
        ? `You left **${challenge.name}**.`
        : `You were not taking part in **${challenge.name}**.`;
  await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
  await refreshChallengeCard(client, db, challenge, now);
}
