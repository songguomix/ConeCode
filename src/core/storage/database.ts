import fs from 'fs';
import path from 'path';

let dataDir: string | null = null;

/** Both the main process and the conversation worker supply their data path. */
export function configureStorageDirectory(directory: string): void {
  if (!path.isAbsolute(directory)) throw new Error('Storage requires an absolute data directory');
  if (dataDir === directory) return;
  if (dataDir) throw new Error('Storage directory has already been configured');
  fs.mkdirSync(directory, { recursive: true });
  dataDir = directory;
}

function getDataDir(): string {
  if (!dataDir) throw new Error('Storage directory has not been configured');
  return dataDir;
}

interface CachedJsonEntry {
  mtimeMs: number;
  size: number;
  data: unknown;
}

const jsonCache = new Map<string, CachedJsonEntry>();

function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}

function readSnapshot<T>(filename: string, defaultValue: T): T {
  const filePath = path.join(getDataDir(), filename);
  // The primary can be damaged by an interrupted write from an older build, or by any writer
  // outside this process. Keep the last good version recoverable instead of silently handing
  // back the default (which for conversations.json means "all chat history is gone").
  for (const candidate of [filePath, `${filePath}.bak`]) {
    try {
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        const cached = jsonCache.get(candidate);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          return cached.data as T;
        }
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        jsonCache.set(candidate, { mtimeMs: stat.mtimeMs, size: stat.size, data: parsed });
        return parsed as T;
      }
    } catch (error) {
      jsonCache.delete(candidate);
      if (candidate === filePath && fs.existsSync(`${filePath}.bak`)) {
        console.warn(`[storage] ${filename} is unreadable, falling back to its backup`, error);
      }
    }
  }
  return defaultValue;
}

export function readJSON<T>(filename: string, defaultValue: T): T {
  return cloneJson(readSnapshot(filename, defaultValue));
}

/** Project a cached collection before copying it across the storage boundary. */
export function selectJSON<T, R>(filename: string, defaultValue: T, select: (snapshot: Readonly<T>) => R): R {
  return cloneJson(select(readSnapshot(filename, defaultValue)));
}

/** Append to an isolated snapshot without copying every existing record. */
export function appendUniqueJSON<T>(filename: string, matches: (item: Readonly<T>) => boolean, create: () => T): T {
  const items = readSnapshot<readonly T[]>(filename, []);
  const existing = items.find(matches);
  if (existing !== undefined) return cloneJson(existing);

  const item = cloneJson(create());
  persistJSON(filename, [...items, item], true);
  return cloneJson(item);
}

export function writeJSON(filename: string, data: any): void {
  persistJSON(filename, data, false);
}

/**
 * Persist `data` so that a crash, `kill -9`, or a full disk can never leave a half-written file:
 * serialize fully, write a temp file, fsync it, rotate the previous version to `.bak`, then rename
 * the temp file into place. Every step before the final rename leaves the previous state readable.
 */
function persistJSON(filename: string, data: unknown, ownedSnapshot: boolean): void {
  const dir = getDataDir();
  const filePath = path.join(dir, filename);
  const tmpPath = path.join(dir, `.${filename}.tmp`);
  const serialized = JSON.stringify(data, null, 2);

  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, serialized);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.bak`);
  } catch {
    // A failed rotation must not block the actual write; worst case we lose the fallback copy.
  }
  fs.renameSync(tmpPath, filePath);
  jsonCache.delete(`${filePath}.bak`);
  try {
    const stat = fs.statSync(filePath);
    jsonCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, data: ownedSnapshot ? data : cloneJson(data) });
  } catch {
    jsonCache.delete(filePath);
  }
}

export function deleteJSON(filename: string): boolean {
  const filePath = path.join(getDataDir(), filename);
  jsonCache.delete(filePath);
  jsonCache.delete(`${filePath}.bak`);
  // Drop the backup too, otherwise a missing primary would resurrect deleted data via readJSON.
  try { fs.unlinkSync(`${filePath}.bak`); } catch { /* no backup */ }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}
