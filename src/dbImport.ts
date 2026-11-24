import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

const SQLITE_MAGIC = 'SQLite format 3\0';

/** True when the bytes start with the 16-byte SQLite file header. */
export function isSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

export function importPath(databasePath: string): string {
  return `${databasePath}.import`;
}

/** Pure decision: which renames the startup swap performs (empty = nothing staged). */
export function planImportSwap(databasePath: string, exists: (path: string) => boolean, stamp: string): { from: string; to: string }[] {
  const staged = importPath(databasePath);
  if (!exists(staged)) return [];
  const moves: { from: string; to: string }[] = [];
  for (const suffix of ['', '-wal', '-shm']) {
    if (exists(databasePath + suffix)) moves.push({ from: databasePath + suffix, to: `${databasePath}.bak-${stamp}${suffix}` });
  }
  moves.push({ from: staged, to: databasePath });
  return moves;
}

/**
 * Startup swap: if an import is staged, back up the current database and move
 * the import into place. Never throws; on failure the bot continues with
 * whatever database is there.
 */
export function applyPendingImport(databasePath: string, now: Date = new Date()): boolean {
  try {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const moves = planImportSwap(databasePath, existsSync, stamp);
    if (moves.length === 0) return false;
    for (const m of moves) {
      renameSync(m.from, m.to);
      console.log(`[db] import: ${m.from} -> ${m.to}`);
    }
    console.log(`[db] imported database is now active at ${databasePath}`);
    return true;
  } catch (err) {
    console.error('[db] import swap failed, continuing with the existing database:', err);
    return false;
  }
}

/** Opens the file read-only; returns null when it is a healthy bot database, else an error message. */
export function validateImportedDb(path: string): string | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') return 'database failed the integrity check';
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
    if (!table) return "database has no 'messages' table (not a Bojan database?)";
    return null;
  } catch (err) {
    return `could not open as a database: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Writes an uploaded file to `<db>.import` (via a temp name so a partial write
 * never looks complete) and validates it. Returns null on success, else an error message.
 */
export function stageImport(databasePath: string, bytes: Uint8Array): string | null {
  if (bytes.length === 0) return 'the uploaded file is empty';
  if (bytes.length > MAX_IMPORT_BYTES) return 'the file is larger than 500 MB';
  if (!isSqliteHeader(bytes)) return 'the file is not a SQLite database';
  const staged = importPath(databasePath);
  const tmp = `${staged}.part`;
  // Opening a WAL-mode file (even read-only) leaves -wal/-shm sidecars; stale ones
  // must never pair with a different staged file, so clear them before and after.
  const clearSidecars = (): void => {
    for (const s of ['-wal', '-shm']) rmSync(staged + s, { force: true });
  };
  clearSidecars();
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, staged);
  } catch (err) {
    rmSync(tmp, { force: true });
    return `could not write the file: ${err instanceof Error ? err.message : String(err)}`;
  }
  const problem = validateImportedDb(staged);
  clearSidecars();
  if (problem) {
    rmSync(staged, { force: true });
    return problem;
  }
  return null;
}
