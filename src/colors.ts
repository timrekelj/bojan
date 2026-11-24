import { ContainerBuilder, MessageFlags, TextDisplayBuilder } from 'discord.js';
import { NO_MENTIONS } from './discord.js';
import { BLURPLE } from './weekly.js';

/** Marker reaction the bot adds to every colour message; any member reaction counts. */
export const COLOR_MARKER = '🎨';

/**
 * Which colour roles to remove and add when a member claims `chosenRoleId`.
 * A member keeps at most one colour role, so every other colour role they
 * already hold is dropped; claiming the role they already hold is a no-op.
 */
export function rolesToSwap(
  memberRoleIds: readonly string[],
  colorRoleIds: readonly string[],
  chosenRoleId: string,
): { remove: string[]; add: string[] } {
  const held = new Set(memberRoleIds);
  return {
    remove: colorRoleIds.filter((id) => id !== chosenRoleId && held.has(id)),
    add: held.has(chosenRoleId) ? [] : [chosenRoleId],
  };
}

/** Colour roles in posting order: highest role first, then by name. */
export function sortColorRoles<T extends { name: string; position: number }>(roles: readonly T[]): T[] {
  return [...roles].sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
}

/** One message per colour role: reacting to it assigns the role. */
export function buildColorMessage(roleId: string) {
  const container = new ContainerBuilder().setAccentColor(BLURPLE).addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      [
        `## 🎨 <@&${roleId}>`,
        'React to this message to wear this colour.',
        '-# One colour per member: a new reaction replaces the old colour, and removing your reaction drops it.',
      ].join('\n'),
    ),
  );
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    allowedMentions: NO_MENTIONS,
  };
}
