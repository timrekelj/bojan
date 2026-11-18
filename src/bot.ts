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
} from 'discord.js';
import type { BotDatabase } from './db.js';
import { config } from './config.js';
import { fmt, fmtDate, lastWeekBounds, leaderboardLines, weekRangeLabel } from './stats.js';
import { maybeConvert } from './embeds/converter.js';

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
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
];

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
    const embed = new EmbedBuilder()
      .setTitle('🏆 Message leaderboard (all time)')
      .setDescription(leaderboardLines(rows, total).join('\n'))
      .setFooter({ text: `${fmt(total)} messages tracked in total` })
      .setColor(0x5865f2)
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'stats') {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const stats = db.userStats(guildId, user.id);
    const total = db.countMessages(guildId);
    const week = lastWeekBounds(settings.timezone);
    const weekCount = db.countMessages(guildId, week.start, week.end);
    const weekTop = db.topUsers(guildId, 1000, week.start, week.end);
    const weekRank = weekCount > 0 ? weekTop.findIndex((r) => r.userId === user.id) + 1 : 0;

    const embed = new EmbedBuilder()
      .setTitle(`Stats for ${user.username}`)
      .setThumbnail(user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'All-time messages', value: `**${fmt(stats.messages)}**${total > 0 ? ` (${((stats.messages / total) * 100).toFixed(1)}% of server)` : ''}`, inline: true },
        { name: `Last week (${weekRangeLabel(week, settings.timezone)})`, value: `**${fmt(weekCount)}** messages${weekRank > 0 ? ` — rank #${weekRank}` : ''}`, inline: true },
        { name: 'First message seen', value: fmtDate(stats.firstTs, settings.timezone), inline: true },
        { name: 'Last message seen', value: fmtDate(stats.lastTs, settings.timezone), inline: true },
      )
      .setColor(0x5865f2)
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'setstats') {
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
    db.recordMessage(message.guildId, message.channelId, message.author.id, message.createdTimestamp);
    const settings = db.getSettings(message.guildId);
    if (settings.embedChannels.length > 0) {
      void maybeConvert(message, db, settings.embedChannels);
    }
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
