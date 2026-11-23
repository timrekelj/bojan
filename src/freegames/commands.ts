import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { BotDatabase } from '../db.js';
import { buildFreeListMessage } from './cards.js';
import { filterGames, getFreeGames } from './sources.js';
import { STORE_LABELS, type Store } from './types.js';

export const freeCommand = new SlashCommandBuilder()
  .setName('free')
  .setDescription('Games that are temporarily free right now')
  .addStringOption((o) =>
    o
      .setName('store')
      .setDescription('Narrow to one store (default: all)')
      .setRequired(false)
      .addChoices({ name: 'All stores', value: 'all' }, ...(Object.entries(STORE_LABELS) as [Store, string][]).map(([value, name]) => ({ name, value }))),
  );

export async function handleFreeCommand(interaction: ChatInputCommandInteraction, db: BotDatabase): Promise<void> {
  if (!interaction.guildId) return;
  const choice = interaction.options.getString('store') ?? 'all';
  const storeFilter = choice === 'all' ? null : (choice as Store);
  await interaction.deferReply();
  const settings = db.getFreeSettings(interaction.guildId);
  const data = await getFreeGames();
  const current = filterGames(data.current, settings).filter((g) => !storeFilter || g.store === storeFilter);
  const upcoming = filterGames(data.upcoming, settings);
  const showUpcoming = !storeFilter || storeFilter === 'epic';
  await interaction.editReply({
    ...buildFreeListMessage({ current, upcoming, storeFilter, showUpcoming }),
    flags: MessageFlags.IsComponentsV2,
  });
}
