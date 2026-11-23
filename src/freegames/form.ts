import { ALL_STORES, type FreeSettings, type Store } from './types.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Parse the dashboard "Free games" form. Unknown channel/role ids become null; unknown stores are dropped. */
export function parseFreeForm(
  form: Record<string, unknown>,
  guildId: string,
  channelIds: ReadonlySet<string>,
  roleIds: ReadonlySet<string>,
): FreeSettings {
  const rawStores = form.stores;
  const list = Array.isArray(rawStores) ? rawStores.map(String) : rawStores ? [String(rawStores)] : [];
  const channelId = str(form.channel);
  const roleId = str(form.pingRole);
  return {
    guildId,
    channelId: channelIds.has(channelId) ? channelId : null,
    pingRoleId: roleIds.has(roleId) ? roleId : null,
    stores: ALL_STORES.filter((s: Store) => list.includes(s)),
    includeDlc: form.includeDlc === '1',
    includeBeta: form.includeBeta === '1',
    includeMobile: form.includeMobile === '1',
    includeConsole: form.includeConsole === '1',
  };
}

/**
 * True when saving `next` over `prev` could make already-free games newly
 * announceable: the channel changed (incl. disabled -> set), or a store /
 * include-* switch was newly enabled. Disabling the channel never needs a seed.
 */
export function needsSeed(prev: FreeSettings, next: FreeSettings): boolean {
  if (next.channelId === null) return false;
  if (prev.channelId !== next.channelId) return true;
  if (next.stores.some((s) => !prev.stores.includes(s))) return true;
  return (
    (next.includeDlc && !prev.includeDlc) ||
    (next.includeBeta && !prev.includeBeta) ||
    (next.includeMobile && !prev.includeMobile) ||
    (next.includeConsole && !prev.includeConsole)
  );
}
