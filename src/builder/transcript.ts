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

/** Where the time of one assistant message went (ms; null = unknown). */
export interface TranscriptTiming {
  firstTokenMs: number | null;
  totalMs: number | null;
  toolsMs: number | null;
  retry: string | null;
}

export type TranscriptEntry =
  | { kind: 'user'; id: string; time: number | null; gapMs: number | null; text: string; attachments: string[] }
  | {
      kind: 'assistant';
      id: string;
      time: number | null;
      /** Idle time between the previous entry's end and this entry's start. */
      gapMs: number | null;
      timing: TranscriptTiming;
      agent: string | null;
      model: string | null;
      finish: string | null;
      error: string | null;
      tokens: TranscriptTokens | null;
      cost: number | null;
      parts: TranscriptPart[];
    }
  | { kind: 'event'; id: string; time: number | null; gapMs: number | null; type: string; label: string };

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

function diff(a: number | null, b: number | null): number | null {
  return a !== null && b !== null && b >= a ? b - a : null;
}

function retryText(v: unknown): string | null {
  if (!isRec(v)) return null;
  const attempt = num(v.attempt);
  const err = errorText(v.error);
  const parts = [attempt !== null ? `attempt ${attempt}` : '', err ? clipText(err, MAX_EVENT_CHARS) : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(': ') : 'retrying';
}

function timingOf(raw: Rec, content: unknown[]): TranscriptTiming {
  const t = isRec(raw.time) ? raw.time : {};
  const created = num(t.created);
  let tools = 0;
  let anyTool = false;
  for (const part of content) {
    if (!isRec(part) || part.type !== 'tool') continue;
    const p = partOf(part);
    if (p && p.kind === 'tool' && p.durationMs !== null) {
      tools += p.durationMs;
      anyTool = true;
    }
  }
  return { firstTokenMs: diff(created, num(t.firstToken)), totalMs: diff(created, num(t.completed)), toolsMs: anyTool ? tools : null, retry: retryText(raw.retry) };
}

/** Raw OpenCode messages (chronological order) -> display entries, in the same order. Never throws. */
export function normalizeTranscript(messages: readonly unknown[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let prevEnd: number | null = null;
  messages.forEach((raw, i) => {
    if (!isRec(raw)) return;
    const id = str(raw.id) ?? `m${i}`;
    const time = isRec(raw.time) ? num(raw.time.created) : null;
    const type = str(raw.type) ?? 'unknown';
    const gapMs = diff(prevEnd, time);
    prevEnd = time;
    if (type === 'user') {
      const files = Array.isArray(raw.files) ? raw.files : [];
      const attachments = files.filter(isRec).map((f) => `[file: ${str(f.name) || str(f.mime) || 'unknown'}]`);
      out.push({ kind: 'user', id, time, gapMs, text: clipText(str(raw.text) ?? '', MAX_TEXT_CHARS), attachments });
    } else if (type === 'assistant') {
      const content = Array.isArray(raw.content) ? raw.content : [];
      if (isRec(raw.time)) prevEnd = num(raw.time.completed) ?? time;
      out.push({
        kind: 'assistant',
        id,
        time,
        gapMs,
        timing: timingOf(raw, content),
        agent: str(raw.agent),
        model: modelOf(raw.model),
        finish: str(raw.finish),
        error: errorText(raw.error),
        tokens: tokensOf(raw.tokens),
        cost: num(raw.cost),
        parts: content.map(partOf).filter((p): p is TranscriptPart => p !== null),
      });
    } else {
      out.push({ kind: 'event', id, time, gapMs, type, label: eventLabel(raw, type) });
    }
  });
  return out;
}

/** The part of the OpenCode client this module needs. */
export interface MessageListClient {
  message: {
    list(input: { sessionID: string; order?: 'asc' | 'desc'; limit: number; cursor?: string }): Promise<{ data: readonly unknown[]; cursor?: { previous?: string | null; next?: string | null } }>;
  };
}

export interface TranscriptPage {
  /** Newest first (the order the page shows them). */
  entries: TranscriptEntry[];
  /** Pass as `cursor` to load the next older page; null when this is the oldest page. */
  olderCursor: string | null;
}

/** Stable newest-first sort by time; entries without a time keep their slot. */
function sortNewestFirst(entries: TranscriptEntry[]): TranscriptEntry[] {
  const slots: number[] = [];
  entries.forEach((e, i) => {
    if (e.time !== null) slots.push(i);
  });
  const sorted = slots.map((i) => entries[i]!).sort((a, b) => (b.time as number) - (a.time as number));
  const out = [...entries];
  slots.forEach((slot, k) => {
    out[slot] = sorted[k]!;
  });
  return out;
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
    // The server rejects `order` together with a cursor (the cursor carries the order of the first request).
    const request = opts.cursor ? { sessionID, cursor: opts.cursor, limit } : { sessionID, order: 'desc' as const, limit };
    const res = await Promise.race([client.message.list(request), timeout]);
    const data = Array.isArray(res.data) ? res.data : [];
    // Descending order: `next` continues towards older messages.
    const older = data.length >= limit ? (res.cursor?.next ?? null) : null;
    // Normalize in chronological order, then flip back, then make sure the page is newest first.
    return { entries: sortNewestFirst(normalizeTranscript([...data].reverse()).reverse()), olderCursor: older };
  } finally {
    clearTimeout(timer);
  }
}
