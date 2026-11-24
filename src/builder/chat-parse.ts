// Pure helpers for the chat assistant: reply parsing, message chunking and prompt formatting.
import { parseAgentReply } from './parse.js';

export interface ChatReply {
  /** Whether the visible text should be posted. */
  reply: boolean;
  /** Text to post ('' when `reply` is false). */
  visible: string;
  /** Self-contained description of a requested bot feature, or null. */
  featureRequest: string | null;
}

/**
 * Parse a chat agent reply. A missing or invalid json block counts as `reply: true` with the whole
 * visible text (an empty text is then not posted). `reply: false` suppresses the visible text.
 */
export function parseChatReply(text: string): ChatReply {
  const { visible, result } = parseAgentReply(text);
  if (!result) return { reply: visible.length > 0, visible, featureRequest: null };
  const fr = typeof result.feature_request === 'string' ? result.feature_request.trim() : '';
  const wantsReply = result.reply !== false && visible.length > 0;
  return { reply: wantsReply, visible: wantsReply ? visible : '', featureRequest: fr.length > 0 ? fr : null };
}

/** Split text into chunks of at most `max` chars, breaking at line boundaries (long lines at spaces, then hard). */
export function chunkMessage(text: string, max = 2000): string[] {
  const out: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur.trim().length > 0) out.push(cur);
    cur = '';
  };
  const pushPiece = (piece: string): void => {
    // `piece` is a single line, possibly longer than max.
    let rest = piece;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      const head = rest.slice(0, cut);
      if (cur.length > 0) flush();
      out.push(head);
      rest = rest.slice(cut).replace(/^ /, '');
    }
    if (cur.length === 0) cur = rest;
    else if (cur.length + 1 + rest.length <= max) cur += `\n${rest}`;
    else {
      flush();
      cur = rest;
    }
  };
  for (const line of (text ?? '').trim().split('\n')) pushPiece(line);
  flush();
  return out;
}

export interface ChatMessageInfo {
  name: string;
  id: string;
  text: string;
  /** Attachment urls and embed urls/titles, already flattened. */
  extras?: string[];
}

/** "<display name> (<user id>): <text>" followed by attachment/embed lines. */
export function formatChatMessage(m: ChatMessageInfo): string {
  const head = `${m.name} (${m.id}): ${m.text.trim()}`.trimEnd();
  const extras = (m.extras ?? []).filter((e) => e.length > 0);
  return extras.length > 0 ? `${head}\n${extras.map((e) => `  ${e}`).join('\n')}` : head;
}

/** First prompt of a chat: only the tagging message and, when it is a reply, the message it replies to. */
export function formatInitialPrompt(opts: { channelName: string | null; trigger: ChatMessageInfo; referenced: ChatMessageInfo | null }): string {
  const where = opts.channelName ? ` in #${opts.channelName}` : '';
  const parts = [`You were mentioned${where}. This is the start of the conversation.`];
  if (opts.referenced) parts.push(`Message that was replied to:\n${formatChatMessage(opts.referenced)}`);
  parts.push(`Message that mentioned you:\n${formatChatMessage(opts.trigger)}`);
  return parts.join('\n\n');
}

/** Short recent-thread transcript for the planner: last `maxMessages`, each trimmed, oldest dropped over `maxChars`. */
export function formatTranscript(entries: readonly ChatMessageInfo[], opts: { maxMessages?: number; maxChars?: number; perMessage?: number } = {}): string {
  const { maxMessages = 20, maxChars = 4000, perMessage = 500 } = opts;
  const lines = entries.slice(-maxMessages).map((e) => {
    const flat = e.text.replace(/\s+/g, ' ').trim();
    const text = flat.length > perMessage ? `${flat.slice(0, perMessage - 1)}…` : flat;
    return `${e.name} (${e.id}): ${text}`;
  });
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  while (lines.length > 1 && total > maxChars) total -= lines.shift()!.length + 1;
  return lines.join('\n');
}

/** Thread names are limited to 100 characters. */
export function chatThreadNameFor(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const name = flat.length > 0 ? flat : 'chat';
  return name.length <= 100 ? name : `${name.slice(0, 99).trimEnd()}…`;
}

/** Replace the bot's mention markup with a readable name so the agent can tell it was addressed. */
export function replaceBotMention(content: string, botId: string, botName: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, 'g'), `@${botName}`);
}

export interface BuildNoteInfo {
  jobId: number;
  title: string | null;
  event: 'approved' | 'queued' | 'resumed' | 'conflict_fix_started' | 'conflict_fixed' | 'conflict_failed' | 'pr_opened' | 'merged' | 'closed' | 'failed' | 'cancelled';
  plan?: string;
  /** 1-based place in the build queue ('queued'). */
  position?: number;
  prUrl?: string | null;
  summary?: string;
  reason?: string;
}

/** One-line-ish context note telling the chat agent what happened to a build job. */
export function formatBuildNote(n: BuildNoteInfo): string {
  const head = `[build update] job #${n.jobId}${n.title ? ` "${n.title}"` : ''}:`;
  const pr = n.prUrl ? ` ${n.prUrl}` : '';
  const clip = (t: string, max: number): string => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
  switch (n.event) {
    case 'approved':
      return `${head} plan approved, building now.${n.plan ? ` Plan:\n${clip(n.plan.trim(), 2500)}` : ''}`;
    case 'queued':
      return `${head} plan approved, queued for a build slot (#${n.position ?? 1} in line).${n.plan ? ` Plan:\n${clip(n.plan.trim(), 2500)}` : ''}`;
    case 'resumed':
      return `${head} the bot restarted while this was running; resuming the agent.`;
    case 'conflict_fix_started':
      return `${head} PR has merge conflicts with main; trying to fix them automatically.${pr}`;
    case 'conflict_fixed':
      return `${head} merge conflicts fixed.${pr}`;
    case 'conflict_failed':
      return `${head} could not fix the merge conflicts automatically, needs a manual merge.${pr}${n.reason ? ` ${clip(n.reason.replace(/\s+/g, ' ').trim(), 400)}` : ''}`;
    case 'pr_opened':
      return `${head} PR opened${pr}${n.summary ? ` — ${clip(n.summary.replace(/\s+/g, ' ').trim(), 600)}` : ''}`;
    case 'merged':
      return `${head} PR merged${pr}`;
    case 'closed':
      return `${head} PR closed without merging${pr}`;
    case 'failed':
      return `${head} failed — ${clip((n.reason ?? 'no reason given').replace(/\s+/g, ' ').trim(), 600)}`;
    case 'cancelled':
      return `${head} cancelled`;
  }
}

/** Prepend pending notes to the next chat prompt. */
export function withNotes(notes: readonly string[], prompt: string): string {
  return notes.length === 0 ? prompt : `${notes.join('\n')}\n\n${prompt}`;
}
