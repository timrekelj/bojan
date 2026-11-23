import type { FreeGame, FreeSettings } from './types.js';

// ---- beta detection ---------------------------------------------------------

const BETA_TITLE_RE = /\b(?:play\s?test|open beta|closed beta|beta|alpha|demo|test key)\b/i;

/** Beta / playtest / demo keys are often labelled as normal games; spot them by title. */
export function isBetaTitle(title: string): boolean {
  return BETA_TITLE_RE.test(title);
}

// ---- filter ---------------------------------------------------------

/** Store toggles apply to PC games; mobile items are gated by their own switch. */
export function matchesFilters(g: FreeGame, s: Pick<FreeSettings, 'stores' | 'includeDlc' | 'includeBeta' | 'includeMobile'>): boolean {
  if (g.kind === 'dlc' && !s.includeDlc) return false;
  if (g.kind === 'beta' && !s.includeBeta) return false;
  if (g.platform === 'mobile') return s.includeMobile;
  return s.stores.includes(g.store);
}

export function filterGames(games: FreeGame[], s: FreeSettings): FreeGame[] {
  return games.filter((g) => matchesFilters(g, s));
}
