import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
} from 'discord.js';
import type { BotDatabase } from './db.js';
import { config } from './config.js';
import { fmt, fmtDate, leaderboardLines } from './stats.js';
import { maybeConvert } from './embeds/converter.js';

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });
}

const commands = [
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top message senders (all time)')
    .addIntegerOption((o) => o.setName('limit').setDescription('How many rows (default 10, max 25)').setMinValue(1).setMaxValue(25).setRequired(false)),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('All-time stats for a member (defaults to you)')
    .addUserOption((o) => o.setName('user').setDescription('Member to look up').setRequired(false)),
  new SlashCommandBuilder()
    .setName('setstats')
    .setDescription('Set the channel where weekly stats are posted')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((o) => o.setName('channel').setDescription('Channel for weekly stats').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
  new SlashCommandBuilder()
    .setName('backfill')
    .setDescription('(Admin) Record old messages and reactions from channel history into the stats database')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((o) => o.setName('channel').setDescription('Only this channel (default: all text channels)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
    .addIntegerOption((o) => o.setName('days').setDescription('Only messages from the last N days (default: all history)').setMinValue(1).setRequired(false)),
];

let backfillRunning = false;

function emojiParts(emoji: { id: string | null; name: string | null; animated?: boolean | null }): { key: string; label: string } {
  return {
    key: emoji.id ?? emoji.name ?? '',
    label: emoji.id ? `<${emoji.animated ? 'a' : ''}:${emoji.name ?? 'emoji'}:${emoji.id}>` : (emoji.name ?? ''),
  };
}

export async function registerCommands(client: Client): Promise<void> {
  const rest = new REST().setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands.map((c) => c.toJSON()) });
  console.log(`[bot] registered ${commands.length} guild commands`);
}

async function handleCommand(interaction: ChatInputCommandInteraction, db: BotDatabase, client: Client): Promise<void> {
  if (!interaction.guildId) return;
  const guildId = interaction.guildId;
  const settings = db.getSettings(guildId);

  if (interaction.commandName === 'leaderboard') {
    const limit = interaction.options.getInteger('limit') ?? 10;
    const total = db.countMessages(guildId);
    const rows = db.topUsers(guildId, limit);
    const given = db.topReactionsGiven(guildId, limit);
    const received = db.topReactionsReceived(guildId, limit);
    const emojiList = (userId: string): string => {
      const top = db.topEmojiForUser(guildId, userId, 3);
      return top.length > 0 ? top.map((e) => `${e.emojiLabel}×${e.count}`).join(' ') : '—';
    };
    const description = [
      '### 🏆 Messages (all time)',
      ...leaderboardLines(rows, total),
      '',
      '### 😄 Most reactions given',
      ...(given.length > 0 ? given.map((r, i) => `${i + 1}. <@${r.userId}> — **${fmt(r.count)}** ${emojiList(r.userId)}`) : ['—']),
      '',
      '### 😍 Most reactions received',
      ...(received.length > 0 ? received.map((r, i) => `${i + 1}. <@${r.userId}> — **${fmt(r.count)}**`) : ['—']),
    ].join('\n');
    const embed = new EmbedBuilder()
      .setTitle('🏆 Leaderboard (all time)')
      .setDescription(description.slice(0, 4000))
      .setFooter({ text: `${fmt(total)} messages · ${fmt(db.countReactions(guildId))} reactions tracked in total` })
      .setColor(0x5865f2)
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'stats') {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const stats = db.userStats(guildId, user.id);
    const total = db.countMessages(guildId);
    const reactions = db.reactionStats(guildId, user.id);
    const emojis = db.topEmojiForUser(guildId, user.id, 5);
    const emojisOnTheirMessages = db.topEmojiReceived(guildId, user.id, 5);

    const embed = new EmbedBuilder()
      .setTitle(`Stats for ${user.username}`)
      .setThumbnail(user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'All-time messages', value: `**${fmt(stats.messages)}**${total > 0 ? ` (${((stats.messages / total) * 100).toFixed(1)}% of server)` : ''}`, inline: true },
        { name: 'Reactions given', value: `**${fmt(reactions.given)}**`, inline: true },
        { name: 'Reactions received', value: `**${fmt(reactions.received)}**`, inline: true },
        { name: 'Last message seen', value: fmtDate(stats.lastTs, settings.timezone), inline: true },
        ...(emojis.length > 0
          ? [{ name: 'Most used emoji (given)', value: emojis.map((e) => `${e.emojiLabel} ×${fmt(e.count)}`).join('   '), inline: false }]
          : []),
        ...(emojisOnTheirMessages.length > 0
          ? [{ name: 'Most used emoji on their messages', value: emojisOnTheirMessages.map((e) => `${e.emojiLabel} ×${fmt(e.count)}`).join('   '), inline: false }]
          : []),
      )
      .setColor(0x5865f2)
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'backfill') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'This command is admin-only.', ephemeral: true });
      return;
    }
    if (backfillRunning) {
      await interaction.reply({ content: 'A backfill is already running — check the other invocation.', ephemeral: true });
      return;
    }
    backfillRunning = true;
    await interaction.deferReply({ ephemeral: true });
    try {
      const guild = interaction.guild;
      if (!guild) return;
      const onlyChannel = interaction.options.getChannel('channel');
      const days = interaction.options.getInteger('days');
      const cutoff = days ? Date.now() - days * 86_400_000 : null;

      const channelList: TextChannel[] = onlyChannel
        ? [onlyChannel as TextChannel]
        : [...guild.channels.cache
            .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
            .values()] as TextChannel[];

      let scanned = 0;
      let recorded = 0;
      let reactionsRecorded = 0;
      const skipped: string[] = [];
      let done = 0;
      for (const channel of channelList) {
        done++;
        try {
          let before: string | undefined;
          for (;;) {
            const batch = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
            if (batch.size === 0) break;
            scanned += batch.size;
            const rows = [];
            const reactionRows = [];
            for (const m of batch.values()) {
              if (m.author.bot || m.webhookId || !m.author) continue;
              rows.push({ guildId, channelId: channel.id, userId: m.author.id, ts: m.createdTimestamp, messageId: m.id });
              // Fetch who reacted to this message (paginated, 100 per request).
              for (const reaction of m.reactions.cache.values()) {
                const total = reaction.count ?? 0;
                if (total === 0) continue;
                try {
                  const { key, label } = emojiParts(reaction.emoji);
                  let after: string | undefined;
                  let collected = 0;
                  for (;;) {
                    const users = await reaction.users.fetch(after ? { limit: 100, after } : { limit: 100 });
                    if (users.size === 0) break;
                    for (const u of users.values()) {
                      if (u.bot) continue;
                      reactionRows.push({ guildId, channelId: channel.id, messageId: m.id, authorId: m.author.id, reactorId: u.id, emojiKey: key, emojiLabel: label, ts: m.createdTimestamp });
                    }
                    collected += users.size;
                    after = users.last()?.id;
                    if (users.size < 100 || collected >= total) break;
                  }
                } catch {
                  // rate-limited or emoji gone — skip this reaction
                }
              }
            }
            recorded += db.recordMessagesBatch(rows);
            reactionsRecorded += db.recordReactionsBatch(reactionRows);
            const oldest = batch.last();
            if (!oldest) break;
            before = oldest.id;
            if (batch.size < 100 || (cutoff !== null && oldest.createdTimestamp < cutoff)) break;
          }
          await interaction
            .editReply({ content: `Backfilling… channel ${done}/${channelList.length} — scanned ${fmt(scanned)} messages, recorded ${fmt(recorded)} new, ${fmt(reactionsRecorded)} reactions` })
            .catch(() => undefined);
        } catch {
          skipped.push(channel.name);
        }
      }
      const total = db.countMessages(guildId);
      const totalReactions = db.countReactions(guildId);
      await interaction.editReply({
        content: [
          `Backfill complete: scanned **${fmt(scanned)}** messages, recorded **${fmt(recorded)}** new (${fmt(total)} total in the database), **${fmt(reactionsRecorded)}** new reactions (${fmt(totalReactions)} total) across ${channelList.length} channel(s).`,
          skipped.length > 0 ? `No access to: ${skipped.map((n) => `[#${n}]`).join(', ')}` : '',
        ].filter(Boolean).join('\n'),
      });
    } catch (err) {
      console.error('[bot] backfill failed:', err);
      await interaction.editReply({ content: 'Backfill failed — see bot logs.' }).catch(() => undefined);
    } finally {
      backfillRunning = false;
    }
    return;
  }

  if (interaction.commandName === 'setstats') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'This command is admin-only.', ephemeral: true });
      return;
    }
    const channel = interaction.options.getChannel('channel', true);
    settings.statsChannelId = channel.id;
    db.saveSettings(settings);
    await interaction.reply({ content: `Weekly stats will be posted in <#${channel.id}>.`, ephemeral: true });
    return;
  }
}

export function registerEvents(client: Client, db: BotDatabase): void {
  client.once(Events.ClientReady, async (ready) => {
    console.log(`[bot] logged in as ${ready.user.tag} (${ready.user.id})`);
    await registerCommands(client).catch((err) => console.error('[bot] command registration failed:', err));
  });

  client.on(Events.MessageCreate, (message: Message) => {
    if (!message.guildId || message.author.bot || message.webhookId) return;
    db.recordMessage(message.guildId, message.channelId, message.author.id, message.createdTimestamp, message.id);
    const settings = db.getSettings(message.guildId);
    if (settings.embedChannels.length > 0) {
      void maybeConvert(message, db, settings.embedChannels);
    }
  });

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void (async () => {
      try {
        if (user.bot) return;
        let message = reaction.message;
        if (message.partial) message = await message.fetch();
        if (!message.guildId || message.author?.bot || message.webhookId) return;
        const { key, label } = emojiParts(reaction.emoji);
        db.recordReaction({
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          reactorId: user.id,
          emojiKey: key,
          emojiLabel: label,
          ts: Date.now(),
        });
      } catch {
        // reaction tracking is best-effort (partials, deleted messages, ...)
      }
    })();
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    void handleCommand(interaction, db, client).catch((err) => {
      console.error('[bot] command error:', err);
      const reply = { content: 'Something went wrong running that command.', ephemeral: true } as const;
      if (interaction.replied || interaction.deferred) void interaction.followUp(reply).catch(() => undefined);
      else void interaction.reply(reply).catch(() => undefined);
    });
  });
}
