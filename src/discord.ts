/** Allowed-mentions for sends that must never ping anyone (`repliedUser` only matters for replies). */
export const NO_MENTIONS = { parse: [] as never[], repliedUser: false };

/** Send options for `message`; when `replyTo` is given it is sent as a reply (without pinging) to that message. */
export function withReply<T extends object>(message: T, replyTo?: string | null): T & { allowedMentions: typeof NO_MENTIONS; reply?: { messageReference: string; failIfNotExists: false } } {
  return replyTo
    ? { ...message, reply: { messageReference: replyTo, failIfNotExists: false as const }, allowedMentions: NO_MENTIONS }
    : { ...message, allowedMentions: NO_MENTIONS };
}
