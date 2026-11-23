import { format } from 'node:util';
import type { BotDatabase, LogLevel } from './db.js';

const MAX_MESSAGE_CHARS = 8000;

/** Splits a leading `[tag]` off a message. */
export function parseLogTag(message: string): { tag: string | null; message: string } {
  const m = /^\[([A-Za-z0-9_.:-]{1,32})\]\s*/.exec(message);
  return m ? { tag: m[1] ?? null, message: message.slice(m[0].length) } : { tag: null, message };
}

export function formatLogMessage(args: unknown[]): string {
  const text = format(...args);
  return text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) + '… [truncated]' : text;
}

let installed = false;

/** Wraps console.log/info/warn/error so output is also persisted to the logs table. */
export function installLogCapture(db: BotDatabase): void {
  if (installed) return;
  installed = true;
  const levels: [keyof Pick<Console, 'log' | 'info' | 'warn' | 'error'>, LogLevel][] = [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
  ];
  let capturing = false; // guards against re-entrancy
  for (const [method, level] of levels) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]): void => {
      original(...args);
      if (capturing) return;
      capturing = true;
      try {
        const { tag, message } = parseLogTag(formatLogMessage(args));
        db.addLog({ ts: Date.now(), level, tag, message });
      } catch {
        // Never let capture break logging; don't log this failure (would recurse).
      } finally {
        capturing = false;
      }
    };
  }
}
