import {
  ActivityType,
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
import { activityTypeLabel, barChartLines, fmt, fmtDate, fmtDuration, leaderboardLines, localParts, zonedToUtcMs } from './stats.js';
import { maybeConvert } from './embeds/converter.js';

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildPresences, // privileged: needed to see what members are playing/listening to
      GatewayIntentBits.GuildVoiceStates, // voice channel join/leave tracking
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
    .setName('activity')
    .setDescription('Stats for one recorded activity/game (e.g. League of Legends, opencode)')
    .addStringOption((o) => o.setName('name').setDescription('Activity name (autocomplete from recorded ones)').setRequired(true).setAutocomplete(true))
    .addUserOption((o) => o.setName('user').setDescription('Member to look up (defaults to you)').setRequired(false)),
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
    const totalReactions = db.countReactions(guildId);
    const rows = db.topUsers(guildId, limit);
    const given = db.topReactionsGiven(guildId, limit);
    const received = db.topReactionsReceived(guildId, limit);
    const medal = (i: number): string => ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;
    // Embed field values are capped at 1024 chars — drop trailing rows if needed.
    const fit = (lines: string[]): string => {
      while (lines.length > 1 && lines.join('\n').length > 1000) lines.pop();
      return lines.join('\n') || '—';
    };
    const embed = new EmbedBuilder()
      .setTitle('🏆 Leaderboard — all time')
      .addFields(
        { name: `💬 Messages (${fmt(total)} total)`, value: fit(leaderboardLines(rows, total)) },
        {
          name: `😄 Reactions given (${fmt(totalReactions)} total)`,
          value: fit(given.map((r, i) => `${medal(i)} <@${r.userId}> — **${fmt(r.count)}**`)),
        },
        { name: '😍 Reactions received', value: fit(received.map((r, i) => `${medal(i)} <@${r.userId}> — **${fmt(r.count)}**`)) },
      )
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
    const nowPlaying = db.currentActivities(guildId, user.id);
    const topActivities = db.topActivities(guildId, user.id, 5);
    const totalActivityMs = db.totalActivityMs(guildId, user.id);
    const voice = db.voiceStats(guildId, user.id);
    const inVoiceNow = db.currentVoiceChannel(guildId, user.id);
    const topVoiceChannels = db.topVoiceChannels(guildId, user.id, 3);

    const embed = new EmbedBuilder()
      .setTitle(`Stats for ${user.username}`)
      .setThumbnail(user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'All-time messages', value: `**${fmt(stats.messages)}**${total > 0 ? ` (${((stats.messages / total) * 100).toFixed(1)}% of server)` : ''}`, inline: true },
        { name: 'Reactions given', value: `**${fmt(reactions.given)}**`, inline: true },
        { name: 'Reactions received', value: `**${fmt(reactions.received)}**`, inline: true },
        { name: 'Last message seen', value: fmtDate(stats.lastTs, settings.timezone), inline: true },
        { name: 'Time in voice', value: `**${fmtDuration(voice.totalMs)}**${voice.sessions > 0 ? ` across ${fmt(voice.sessions)} session${voice.sessions === 1 ? '' : 's'}` : ''}`, inline: true },
        ...(inVoiceNow
          ? [{ name: 'In voice now', value: `<#${inVoiceNow.channelId}> — for ${fmtDuration(Date.now() - inVoiceNow.startedAt)}`, inline: true }]
          : []),
        ...(nowPlaying.length > 0
          ? [{
              name: 'Now playing',
              value: nowPlaying
                .map((a) => `${activityTypeLabel(a.type)} **${a.name}** — for ${fmtDuration(Date.now() - a.startedAt)}`)
                .join('\n'),
              inline: false,
            }]
          : []),
        ...(topActivities.length > 0
          ? [{
              name: `Top activities (all time, ${fmtDuration(totalActivityMs)} tracked)`,
              value: topActivities
                .map((a) => `${activityTypeLabel(a.type)} **${a.name}** — **${fmtDuration(a.totalMs)}** across ${fmt(a.sessions)} session${a.sessions === 1 ? '' : 's'}`)
                .join('\n'),
              inline: false,
            }]
          : []),
        ...(topVoiceChannels.length > 0
          ? [{
              name: 'Top voice channels',
              value: topVoiceChannels.map((c) => `<#${c.channelId}> — **${fmtDuration(c.totalMs)}** (${fmt(c.sessions)}×)`).join('\n'),
              inline: false,
            }]
          : []),
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

  if (interaction.commandName === 'activity') {
    const name = interaction.options.getString('name', true);
    const user = interaction.options.getUser('user') ?? interaction.user;
    const summary = db.activitySummary(guildId, user.id, name);
    if (!summary) {
      await interaction.reply({ content: `No recorded sessions for **${name}**${user.id === interaction.user.id ? '' : ` for ${user.username}`}. Start it while the bot is online and try again.`, ephemeral: true });
      return;
    }
    const now = Date.now();
    const tz = settings.timezone;
    const breakdown = db.activityBreakdown(guildId, user.id, name, 5, now);
    const recent = db.recentActivitySessions(guildId, user.id, name, 8, now);
    // Last 7 local days, bucketed by session start day.
    const p = localParts(tz, new Date(now - 6 * 86_400_000));
    const dayStart = zonedToUtcMs(tz, p.y, p.mo, p.d);
    const minutes = db.activityMinutesPerDay(guildId, user.id, name, dayStart, now + 1, tz, now);
    const chart = barChartLines(minutes, { start: dayStart, end: now, key: '' }, tz);

    // Embed field values are capped at 1024 chars — drop trailing lines if needed.
    const fit = (lines: string[]): string => {
      while (lines.length > 1 && lines.join('\n').length > 1000) lines.pop();
      return lines.join('\n') || '—';
    };
    const embed = new EmbedBuilder()
      .setTitle(`📊 ${name} — ${user.username}`)
      .setThumbnail(user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'Total time', value: `**${fmtDuration(summary.totalMs)}**`, inline: true },
        { name: 'Sessions', value: `**${fmt(summary.sessions)}**`, inline: true },
        { name: 'Average session', value: `**${fmtDuration(summary.avgMs)}**`, inline: true },
        { name: 'First seen', value: fmtDate(summary.firstAt, tz), inline: true },
        { name: 'Last seen', value: fmtDate(summary.lastAt, tz), inline: true },
        { name: 'Last 7 days (minutes)', value: '```\n' + fit(chart) + '\n```', inline: false },
        ...(breakdown.length > 0
          ? [{ name: 'Breakdown (details/status)', value: fit(breakdown.map((b) => `**${b.label}** — ${fmtDuration(b.totalMs)} (${fmt(b.sessions)}×)`)), inline: false }]
          : []),
        ...(recent.length > 0
          ? [{
              name: 'Recent sessions',
              value: fit(recent.map((s) => `${fmtDate(s.startedAt, tz)} — **${fmtDuration(s.durationMs)}**${s.open ? ' (ongoing)' : ''}${s.details ? ` — ${s.details}` : ''}${!s.details && s.state ? ` — ${s.state}` : ''}`)),
              inline: false,
            }]
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
    // Seed voice sessions for members already in a voice channel when the bot
    // (re)starts — their real join time is unknown, so it counts from now.
    const now = Date.now();
    for (const guild of ready.guilds.cache.values()) {
      for (const vs of guild.voiceStates.cache.values()) {
        if (!vs.channelId || vs.member?.user.bot) continue;
        try {
          db.recordVoiceState(guild.id, vs.id, vs.channelId, now);
        } catch {
          // best-effort seeding
        }
      }
    }
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

  client.on(Events.PresenceUpdate, (oldPresence, newPresence) => {
    try {
      const guildId = newPresence.guild?.id;
      const userId = newPresence.userId;
      if (!guildId || !userId) return;
      if (newPresence.user?.bot || newPresence.member?.user.bot) return;
      db.recordPresence(
        guildId,
        userId,
        newPresence.activities.map((a) => ({
          // Custom statuses arrive as name "Custom Status" with the text in
          // `state` — track the text itself so statuses group by content.
          name: a.type === ActivityType.Custom && a.state ? a.state : a.name,
          type: a.type,
          details: a.details ?? null,
          state: a.state ?? null,
          applicationId: a.applicationId ?? null,
          startedAt: a.timestamps?.start?.getTime() ?? null,
        })),
        Date.now(),
      );
    } catch {
      // presence tracking is best-effort (uncached members, partials, ...)
    }
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    try {
      if (oldState.channelId === newState.channelId) return; // mute/deaf/move within same channel
      if (newState.member?.user.bot) return;
      db.recordVoiceState(newState.guild.id, newState.id, newState.channelId, Date.now());
    } catch {
      // voice tracking is best-effort
    }
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'activity' && interaction.guildId) {
        const prefix = String(interaction.options.getFocused());
        const names = db.activityNames(interaction.guildId, prefix, 25);
        void interaction
          .respond(names.map((n) => ({ name: n.length > 100 ? `${n.slice(0, 97)}…` : n, value: n })))
          .catch(() => undefined);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    void handleCommand(interaction, db, client).catch((err) => {
      console.error('[bot] command error:', err);
      const reply = { content: 'Something went wrong running that command.', ephemeral: true } as const;
      if (interaction.replied || interaction.deferred) void interaction.followUp(reply).catch(() => undefined);
      else void interaction.reply(reply).catch(() => undefined);
    });
  });
}
