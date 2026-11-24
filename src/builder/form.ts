import { clampMaxParallel, DEFAULT_BUILDER_MODEL, DEFAULT_CHAT_MODEL, type BuilderSettings } from '../db.js';
import { parseModelRef } from './parse.js';

/** Empty -> default; invalid -> keep `current` and report; otherwise the trimmed value. */
function pickModel(raw: unknown, fallback: string, current: string, label: string): { model: string; error: string | null } {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v === '') return { model: fallback, error: null };
  if (!parseModelRef(v) || /\s/.test(v)) return { model: current, error: `${label} must look like provider/model` };
  return { model: v, error: null };
}

/** Whole number clamped to 1–5; missing or not a number keeps `current`. */
export function parseMaxParallel(raw: unknown, current: number): number {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!/^-?\d+$/.test(v)) return current;
  return clampMaxParallel(Number(v));
}

const MAX_LANGUAGES = 8;
const MAX_LANGUAGE_CHARS = 30;

/**
 * Chat languages from the dashboard: one or more comma-separated names (also accepts an array of
 * them). Entries are trimmed and inner whitespace flattened, deduped case-insensitively, and capped.
 */
export function parseChatLanguages(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  const out: string[] = [];
  for (const part of parts.flatMap((s) => s.split(','))) {
    const v = part.trim().replace(/\s+/g, ' ').slice(0, MAX_LANGUAGE_CHARS);
    if (v.length === 0 || out.some((x) => x.toLowerCase() === v.toLowerCase())) continue;
    out.push(v);
    if (out.length >= MAX_LANGUAGES) break;
  }
  return out;
}

/** Parse the dashboard "AI assistant" form. An invalid model keeps `current` (the saved value). */
export function parseBuilderForm(form: Record<string, unknown>, current: BuilderSettings): { settings: BuilderSettings; modelError: string | null } {
  const build = pickModel(form.model, DEFAULT_BUILDER_MODEL, current.model, 'Build model');
  const chat = pickModel(form.chatModel, DEFAULT_CHAT_MODEL, current.chatModel, 'Chat model');
  return {
    settings: {
      enabled: form.enabled === '1',
      model: build.model,
      chatEnabled: form.chatEnabled === '1',
      chatModel: chat.model,
      chatLanguages: parseChatLanguages(form.chatLanguages),
      maxParallelBuilds: parseMaxParallel(form.maxParallelBuilds, current.maxParallelBuilds),
    },
    modelError: build.error ?? chat.error,
  };
}
