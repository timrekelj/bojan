// Pure view model of an OpenCode session transcript for the dashboard session page: raw messages
// from `client.message.list` become plain, already-clipped entries. Tolerates missing or
// malformed fields and unknown message types. No config/db imports.

export const MAX_TEXT_CHARS = 20_000;
export const MAX_TOOL_INPUT_CHARS = 4_000;
export const MAX_TOOL_OUTPUT_CHARS = 6_000;
const MAX_EVENT_CHARS = 300;
export const TRANSCRIPT_PAGE_SIZE = 30;
export const TRANSCRIPT_TIMEOUT_MS = 8_000;

export interface TranscriptTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export type TranscriptPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; /** Length before clipping. */ chars: number }
  | { kind: 'tool'; name: string; status: string; input: string; output: string; error: string | null; durationMs: number | null };

export type TranscriptEntry =
  | { kind: 'user'; id: string; time: number | null; text: string; attachments: string[] }
  | {
      kind: 'assistant';
      id: string;
      time: number | null;
      agent: string | null;
      model: string | null;
      finish: string | null;
      error: string | null;
      tokens: TranscriptTokens | null;
      cost: number | null;
      parts: TranscriptPart[];
    }
  | { kind: 'event'; id: string; time: number | null; type: string; label: string };

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Cut `s` to `max` chars and say how much was dropped. */
export function clipText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (${s.length - max} more chars)`;
}

function errorText(e: unknown): string | null {
  if (e === undefined || e === null) return null;
  if (typeof e === 'string') return e;
  if (isRec(e)) {
    const type = str(e.type);
    const message = str(e.message);
    if (type && message) return `${type}: ${message}`;
    if (message ?? type) return (message ?? type) as string;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return 'unknown error';
  }
}

function prettyInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

function toolOutput(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const item of content) {
    if (!isRec(item)) continue;
    if (item.type === 'text') out.push(str(item.text) ?? '');
    else if (item.type === 'file') out.push(`[file: ${str(item.name) || str(item.mime) || 'unknown'}]`);
  }
  return out.join('\n');
}

function tokensOf(v: unknown): TranscriptTokens | null {
  if (!isRec(v)) return null;
  const cache = isRec(v.cache) ? v.cache : {};
  return { input: num(v.input) ?? 0, output: num(v.output) ?? 0, reasoning: num(v.reasoning) ?? 0, cacheRead: num(cache.read) ?? 0, cacheWrite: num(cache.write) ?? 0 };
}

function modelOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (!isRec(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  const provider = str(v.providerID);
  return provider ? `${provider}/${id}` : id;
}

function partOf(raw: unknown): TranscriptPart | null {
  if (!isRec(raw)) return null;
  if (raw.type === 'text') return { kind: 'text', text: clipText(str(raw.text) ?? '', MAX_TEXT_CHARS) };
  if (raw.type === 'reasoning') {
    const text = str(raw.text) ?? '';
    return { kind: 'reasoning', text: clipText(text, MAX_TEXT_CHARS), chars: text.length };
  }
  if (raw.type === 'tool') {
    const state = isRec(raw.state) ? raw.state : {};
    const time = isRec(raw.time) ? raw.time : {};
    const started = num(time.ran) ?? num(time.created);
    const ended = num(time.completed);
    const err = errorText(state.error);
    return {
      kind: 'tool',
      name: str(raw.name) ?? 'tool',
      status: str(state.status) ?? 'unknown',
      input: clipText(prettyInput(state.input), MAX_TOOL_INPUT_CHARS),
      output: clipText(toolOutput(state.content), MAX_TOOL_OUTPUT_CHARS),
      error: err === null ? null : clipText(err, MAX_TOOL_OUTPUT_CHARS),
      durationMs: started !== null && ended !== null && ended >= started ? ended - started : null,
    };
  }
  return null;
}

function eventLabel(m: Rec, type: string): string {
  const clip = (s: string): string => clipText(s, MAX_EVENT_CHARS);
  switch (type) {
    case 'agent-switched':
      return `Agent: ${str(m.previous) ? `${str(m.previous)} → ` : ''}${str(m.agent) ?? '?'}`;
    case 'model-switched':
      return `Model: ${modelOf(m.model) ?? '?'}`;
    case 'synthetic':
    case 'system':
      return clip(str(m.description) || str(m.text) || type);
    case 'skill':
      return `Skill: ${str(m.name) ?? str(m.skill) ?? '?'}`;
    case 'shell': {
      const exit = m.exit !== undefined ? `, exit ${String(m.exit)}` : '';
      return clip(`$ ${str(m.command) ?? ''} (${str(m.status) ?? '?'}${exit})`);
    }
    case 'compaction':
      return `Compaction (${str(m.reason) ?? '?'}, ${str(m.status) ?? '?'})`;
    case 'idle': {
      const err = errorText(m.error);
      return clip(`Idle: ${str(m.outcome) ?? '?'}${err ? ` — ${err}` : ''}`);
    }
    default:
      return type;
  }
}

/** Raw OpenCode messages (any order) -> display entries, in the same order. Never throws. */
export function normalizeTranscript(messages: readonly unknown[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  messages.forEach((raw, i) => {
    if (!isRec(raw)) return;
    const id = str(raw.id) ?? `m${i}`;
    const time = isRec(raw.time) ? num(raw.time.created) : null;
    const type = str(raw.type) ?? 'unknown';
    if (type === 'user') {
      const files = Array.isArray(raw.files) ? raw.files : [];
      const attachments = files.filter(isRec).map((f) => `[file: ${str(f.name) || str(f.mime) || 'unknown'}]`);
      out.push({ kind: 'user', id, time, text: clipText(str(raw.text) ?? '', MAX_TEXT_CHARS), attachments });
    } else if (type === 'assistant') {
      const content = Array.isArray(raw.content) ? raw.content : [];
      out.push({
        kind: 'assistant',
        id,
        time,
        agent: str(raw.agent),
        model: modelOf(raw.model),
        finish: str(raw.finish),
        error: errorText(raw.error),
        tokens: tokensOf(raw.tokens),
        cost: num(raw.cost),
        parts: content.map(partOf).filter((p): p is TranscriptPart => p !== null),
      });
    } else {
      out.push({ kind: 'event', id, time, type, label: eventLabel(raw, type) });
    }
  });
  return out;
}

/** The part of the OpenCode client this module needs. */
export interface MessageListClient {
  message: {
    list(input: { sessionID: string; order: 'asc' | 'desc'; limit: number; cursor?: string }): Promise<{ data: readonly unknown[]; cursor?: { previous?: string | null; next?: string | null } }>;
  };
}

export interface TranscriptPage {
  /** Newest first (the order the page shows them). */
  entries: TranscriptEntry[];
  /** Pass as `cursor` to load the next older page; null when this is the oldest page. */
  olderCursor: string | null;
}

/** Newest-first page of messages, returned newest-first for display. Throws on failure or timeout. */
export async function fetchTranscript(
  client: MessageListClient,
  sessionID: string,
  opts: { limit?: number; cursor?: string; timeoutMs?: number } = {},
): Promise<TranscriptPage> {
  const limit = opts.limit ?? TRANSCRIPT_PAGE_SIZE;
  const timeoutMs = opts.timeoutMs ?? TRANSCRIPT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const res = await Promise.race([client.message.list({ sessionID, order: 'desc', limit, ...(opts.cursor ? { cursor: opts.cursor } : {}) }), timeout]);
    const data = Array.isArray(res.data) ? res.data : [];
    // Descending order: `next` continues towards older messages.
    const older = data.length >= limit ? (res.cursor?.next ?? null) : null;
    // The API already returns newest first; normalize in chronological order, then flip back.
    return { entries: normalizeTranscript([...data].reverse()).reverse(), olderCursor: older };
  } finally {
    clearTimeout(timer);
  }
}
