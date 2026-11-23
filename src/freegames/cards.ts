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
import { BLURPLE, divider } from '../weekly.js';
import { STORE_LABELS, type FreeGame, type Store } from './types.js';

const TEXT_BUDGET = 3800;
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

function escapeLinkText(s: string): string {
  return s.replace(/([\[\]\\])/g, '\\$1');
}

export function buildFreeGameMessage(game: FreeGame, opts: { pingRoleId?: string | null } = {}) {
  const lines = [`## 🎁 ${truncate(game.title, 200)}`];
  const desc = truncate(game.description, 300);
  if (desc) lines.push(desc);
  lines.push('', priceLine(game), `-# ${STORE_LABELS[game.store]} · ${kindPlatformLabel(game)}`);
  if (game.source === 'gamerpower') lines.push('-# via GamerPower');

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

export interface FreeListData {
  current: FreeGame[];
  upcoming: FreeGame[];
  /** Store the user narrowed to, or null for all. */
  storeFilter: Store | null;
  showUpcoming: boolean;
}

function listLine(g: FreeGame, upcoming: boolean): string {
  const store = g.store === 'epic' ? 'Epic' : STORE_LABELS[g.store];
  const tag = g.kind === 'dlc' ? ' (DLC)' : g.kind === 'beta' ? ' (beta)' : g.platform !== 'pc' ? ` (${g.platform})` : '';
  const worth = g.worth ? ` ~~${g.worth}~~` : '';
  let when = '';
  if (upcoming) when = g.startsAt ? ` · free ${ts(g.startsAt, 'R')}` : '';
  else if (g.endsAt) when = ` · ends ${ts(g.endsAt, 'R')}`;
  return `**${store}** · [${escapeLinkText(truncate(g.title, 80))}](${g.url})${tag}${worth}${when}`;
}

/** Pure builder for `/free`: trims lines to stay within the 4000-char text budget. */
export function buildFreeListMessage(data: FreeListData) {
  const hasGp = data.current.some((g) => g.source === 'gamerpower');
  const header = `## 🎁 Free games right now${data.storeFilter ? ` — ${STORE_LABELS[data.storeFilter]}` : ''}`;
  const footer = hasGp ? '-# via GamerPower' : '';
  let current = data.current.map((g) => listLine(g, false));
  let upcoming = data.showUpcoming ? data.upcoming.map((g) => listLine(g, true)) : [];

  const render = (): { main: string; next: string | null } => ({
    main: [header, ...(current.length > 0 ? current : ['Nothing matching is free at the moment.'])].join('\n'),
    next: upcoming.length > 0 ? ['### ⏭️ Up next on Epic', ...upcoming].join('\n') : null,
  });
  const size = (): number => {
    const r = render();
    return r.main.length + (r.next?.length ?? 0) + footer.length + 3;
  };
  while (size() > TEXT_BUDGET) {
    if (upcoming.length > 1 && upcoming.length >= current.length) upcoming = upcoming.slice(0, -1);
    else if (current.length > 1) current = current.slice(0, -1);
    else if (upcoming.length > 0) upcoming = upcoming.slice(0, -1);
    else break;
  }
  const trimmed = data.current.length - current.length;
  if (trimmed > 0) current = [...current, `-# …and ${trimmed} more`];

  const r = render();
  const container = new ContainerBuilder().setAccentColor(BLURPLE);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(r.main));
  if (r.next) container.addSeparatorComponents(divider()).addTextDisplayComponents(new TextDisplayBuilder().setContent(r.next));
  if (footer) container.addSeparatorComponents(divider()).addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));
  return { flags: MessageFlags.IsComponentsV2 as const, components: [container], allowedMentions: NO_MENTIONS };
}
