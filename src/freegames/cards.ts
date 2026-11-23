import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from 'discord.js';
import { BLURPLE } from '../weekly.js';
import { STORE_LABELS, type FreeGame } from './types.js';

const NO_MENTIONS = { parse: [] as never[] };

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function ts(ms: number, style: 'f' | 'R'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** "~~$4.99~~ **FREE** until <t:..:f> (<t:..:R>)" — unknown pieces are omitted. */
export function priceLine(g: FreeGame): string {
  const parts: string[] = [];
  if (g.worth) parts.push(`~~${g.worth}~~`);
  parts.push('**FREE**');
  if (g.endsAt) parts.push(`until ${ts(g.endsAt, 'f')} (${ts(g.endsAt, 'R')})`);
  return parts.join(' ');
}

function kindPlatformLabel(g: FreeGame): string {
  const kind = g.kind === 'dlc' ? 'DLC / loot' : g.kind === 'beta' ? 'Beta / playtest' : 'Game';
  const platform = g.platform === 'pc' ? 'PC' : g.platform === 'mobile' ? 'Mobile' : 'Console';
  return `${kind} · ${platform}`;
}

function buttonLabel(g: FreeGame): string {
  if (g.store === 'epic') return 'Get it on Epic Games';
  if (g.store === 'steam') return 'Open on Steam';
  return 'Open giveaway';
}

export function buildFreeGameMessage(game: FreeGame, opts: { pingRoleId?: string | null } = {}) {
  const lines = [`## 🎁 ${truncate(game.title, 200)}`];
  const desc = truncate(game.description, 300);
  if (desc) lines.push(desc);
  lines.push('', priceLine(game), `-# ${STORE_LABELS[game.store]} · ${kindPlatformLabel(game)}`);
  if (game.source === 'gamerpower') lines.push('-# via GamerPower');
  if (game.source === 'freestuff') lines.push('-# via FreeStuff');

  const container = new ContainerBuilder().setAccentColor(BLURPLE).addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  if (game.imageUrl) {
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(game.imageUrl)));
  }
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(buttonLabel(game)).setURL(game.url)),
  );

  const role = opts.pingRoleId ?? null;
  const components: (ContainerBuilder | TextDisplayBuilder)[] = role ? [new TextDisplayBuilder().setContent(`<@&${role}>`), container] : [container];
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components,
    allowedMentions: role ? { roles: [role] } : NO_MENTIONS,
  };
}
