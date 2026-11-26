/**
 * In-memory set of user message ids the bot deleted itself (e.g. the embed
 * converter removing the original link message), so the MessageDelete handler
 * doesn't count them as the user deleting their own message.
 */
const botDeleted = new Map<string, number>();
const TTL_MS = 5 * 60_000;

/** Call before the bot deletes a user's message. */
export function markBotDeleted(messageId: string, now = Date.now()): void {
  for (const [id, exp] of botDeleted) if (exp <= now) botDeleted.delete(id);
  botDeleted.set(messageId, now + TTL_MS);
}

/** True (once) when the bot deleted this message; the marker is removed. */
export function consumeBotDeleted(messageId: string): boolean {
  return botDeleted.delete(messageId);
}

/** Undo a marker when the delete failed. */
export function unmarkBotDeleted(messageId: string): void {
  botDeleted.delete(messageId);
}
