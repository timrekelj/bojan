export type Store = 'epic' | 'steam' | 'gog' | 'itch' | 'ubisoft' | 'ea' | 'other';
export type Kind = 'game' | 'dlc' | 'beta';
export type Platform = 'pc' | 'mobile' | 'console';
export type Source = 'epic' | 'gamerpower' | 'freestuff';

export const ALL_STORES: Store[] = ['epic', 'steam', 'gog', 'itch', 'ubisoft', 'ea', 'other'];

export const STORE_LABELS: Record<Store, string> = {
  epic: 'Epic Games Store',
  steam: 'Steam',
  gog: 'GOG',
  itch: 'itch.io',
  ubisoft: 'Ubisoft',
  ea: 'EA',
  other: 'Other',
};

export interface FreeGame {
  /** Stable, source-prefixed id: "epic:<id>", "gp:<id>" or "fs:<id>". */
  key: string;
  title: string;
  description: string;
  store: Store;
  kind: Kind;
  platform: Platform;
  url: string;
  imageUrl: string | null;
  /** Original price as displayed (e.g. "$4.99"), null when unknown. */
  worth: string | null;
  endsAt: number | null;
  startsAt: number | null;
  source: Source;
}

export interface FreeSettings {
  guildId: string;
  channelId: string | null; // null = disabled
  pingRoleId: string | null;
  stores: Store[];
  includeDlc: boolean;
  /** Beta / playtest / demo keys; off by default. */
  includeBeta: boolean;
  includeMobile: boolean;
  includeConsole: boolean;
}
