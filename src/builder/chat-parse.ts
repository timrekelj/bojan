// Pure helpers for the chat assistant: reply parsing, message chunking and prompt formatting.
import { parseAgentReply } from './parse.js';

export interface ChatReply {
  /** Whether the visible text should be posted. */
  reply: boolean;
  /** Text to post ('' when `reply` is false). */
  visible: string;
  /** No valid json block was found: the text is never posted (the caller may ask once more). */
  missingBlock: boolean;
}

/**
 * Parse a chat agent reply (`{"reply": bool}` block). A missing or invalid json block is never
 * posted: `reply: false` with `missingBlock: true`. With a valid block, any visible text is posted.
 */
export function parseChatReply(text: string): ChatReply {
  const { visible, result } = parseAgentReply(text);
  if (!result) return { reply: false, visible: '', missingBlock: true };
  // The bot is only called when someone addresses it, so any visible text is posted (the block's `reply` flag is ignored).
  const hasText = visible.length > 0;
  return { reply: hasText, visible, missingBlock: false };
}

export const FEATURE_REQUEST_QUESTION = {
  name: 'feature_request',
  instructions:
    'You get recent thread messages (context) and a "Latest message" to classify. Does the latest message ask for a new feature, a change or a bug fix in this Discord bot itself? ' +
    'A short instruction such as "ship this", "build it" or "do it" counts when the thread discussed a change to the bot and the latest message tells the bot to go ahead. ' +
    'Not a general question, not just discussing an idea without asking for it to be built, not about other software.',
  criteria: {
    true: 'The latest message clearly asks for the Discord bot to gain a feature, change its behavior or get a bug fixed, or tells the bot to build/ship a bot change discussed earlier in the thread.',
    false: 'A general question, small talk, only discussing an idea (no ask to build it), or about anything other than this bot.',
  },
};

/** Probability from the decision model -> yes/no (null = no decision = no). */
export function isFeatureRequest(probability: number | null, threshold = 0.5): boolean {
  return probability !== null && Number.isFinite(probability) && probability >= threshold;
}

/** The decision model runs only for a directed message from an admin while building is enabled, with text to judge. */
export function shouldRunDecision(opts: { directed: boolean; admin: boolean; buildingEnabled: boolean; text: string }): boolean {
  return opts.directed && opts.admin && opts.buildingEnabled && opts.text.trim().length > 0;
}

/**
 * Plain decision-model input: recent thread history (oldest first, plain `name: text`, oldest dropped
 * over `maxChars`), the replied-to message (if any) and the latest message to classify.
 */
export function formatDecisionInput(opts: {
  text: string;
  replyTo?: { name: string; text: string } | null;
  history?: readonly { name: string; text: string }[];
  maxChars?: number;
  perMessage?: number;
}): string {
  const { maxChars = 6000, perMessage = 500 } = opts;
  const parts: string[] = [];
  const lines = (opts.history ?? [])
    .map((h) => {
      const flat = h.text.replace(/\s+/g, ' ').trim();
      return flat.length === 0 ? '' : `${h.name}: ${flat.length > perMessage ? `${flat.slice(0, perMessage - 1)}…` : flat}`;
    })
    .filter((l) => l.length > 0);
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  while (lines.length > 0 && total > maxChars) total -= lines.shift()!.length + 1;
  if (lines.length > 0) parts.push(`Recent thread messages (oldest first, context):\n${lines.join('\n')}`);
  const ref = opts.replyTo?.text.trim();
  if (opts.replyTo && ref) parts.push(`The latest message replies to ${opts.replyTo.name}: ${ref}`);
  parts.push(`Latest message (the one to classify):\n${opts.text.trim()}`);
  return parts.join('\n\n');
}

/** Non-directed thread messages buffered since the bot's last reply, as background for the next directed turn. Empty for none. */
/** Items (oldest first) sent after the last one authored by the bot; all of them when the bot never spoke. */
export function sinceLastBotMessage<T extends { authorId: string }>(items: readonly T[], botId: string): T[] {
  let last = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.authorId === botId) {
      last = i;
      break;
    }
  }
  return items.slice(last + 1);
}

export function formatThreadContext(lines: readonly string[], opts: { maxLines?: number; maxChars?: number } = {}): string {
  const { maxLines = 30, maxChars = 4000 } = opts;
  const kept = lines.filter((l) => l.trim().length > 0).slice(-maxLines);
  let total = kept.reduce((n, l) => n + l.length + 1, 0);
  while (kept.length > 1 && total > maxChars) total -= kept.shift()!.length + 1;
  if (kept.length === 0) return '';
  return `Other messages in the thread since your last reply (context, not addressed to you):\n${kept.join('\n')}`;
}

/** The build request text: what the requester wrote, prefixed by the message it replies to. */
export function featureRequestText(opts: { text: string; replyTo?: { name: string; text: string } | null }): string {
  const ref = opts.replyTo?.text.trim();
  const own = opts.text.trim();
  return opts.replyTo && ref ? `In reply to ${opts.replyTo.name}: ${ref}\n\n${own}` : own;
}

/** Message id a reply should attach to: the latest directed message, else the last one; null for an empty batch. */
export function pickReplyTarget(items: readonly { messageId: string; directed: boolean }[]): string | null {
  const directed = [...items].reverse().find((i) => i.directed);
  return (directed ?? items[items.length - 1])?.messageId ?? null;
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

/** Recent-thread transcript for the planner: last `maxMessages`, each trimmed, oldest dropped over `maxChars`. */
export function formatTranscript(entries: readonly ChatMessageInfo[], opts: { maxMessages?: number; maxChars?: number; perMessage?: number } = {}): string {
  const { maxMessages = 50, maxChars = 8000, perMessage = 500 } = opts;
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

export interface JobStatusInfo {
  jobId: number;
  title: string | null;
  request: string;
  status: string;
  queuePosition: number | null;
  /** Milliseconds spent in the current phase. */
  sinceMs: number;
  prUrl: string | null;
}

/** Status block for the chat prompt while the thread's newest build job is in flight. Empty for other statuses. */
export function formatJobStatus(info: JobStatusInfo): string {
  const minutes = Math.max(0, Math.round(info.sinceMs / 60_000));
  const label = info.title ? `job #${info.jobId} "${info.title}"` : `job #${info.jobId}`;
  const flat = info.request.replace(/\s+/g, ' ').trim();
  const request = flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
  let phase: string;
  switch (info.status) {
    case 'planning':
      phase = `planning (${minutes} min): the planner is writing or revising a plan. Messages sent now are shown to it as context together with the next reply to the plan.`;
      break;
    case 'awaiting_input':
      phase = 'plan posted, waiting for the requester to approve it or give feedback (as a reply to the posted plan).';
      break;
    case 'queued':
      phase = `queued: waiting for a free build slot${info.queuePosition ? `, position ${info.queuePosition}` : ''}.`;
      break;
    case 'building':
      phase = `building for ${minutes} min: implementing the approved plan.`;
      break;
    case 'pr_open':
      phase = `PR open${info.prUrl ? ` at ${info.prUrl}` : ''}, waiting for review.`;
      break;
    default:
      return '';
  }
  return `[build status] ${label} — ${phase} Request: ${request}`;
}

/** Prepend pending notes to the next chat prompt. */
export function withNotes(notes: readonly string[], prompt: string): string {
  return notes.length === 0 ? prompt : `${notes.join('\n')}\n\n${prompt}`;
}

/**
 * Standing rule naming the only languages the chat assistant may reply in. An empty language list
 * (the default) means no constraint and produces no rule.
 */
export function languageDirective(languages: readonly string[]): string {
  if (languages.length === 0) return '';
  return `[language rule] The admins limited the languages you may use. Whatever language a member writes in, your visible reply must be in one of these languages only: ${languages.join(', ')}.`;
}

/** Prepend the language rule (when any) to a chat prompt. */
export function withLanguageRule(prompt: string, languages: readonly string[]): string {
  const rule = languageDirective(languages);
  return rule.length === 0 ? prompt : `${rule}\n\n${prompt}`;
}
