// Main-process file search (grep) and glob finder.
//
// Both walk the tree the same way:
//   - dependency trees, build output and caches are never descended into;
//   - a child directory that carries its own `.git` is a *separate checkout*
//     (a linked worktree, a vendored copy) — a search that descends into it
//     returns stale duplicates of the project itself and can exhaust the whole
//     result budget before the real tree is reached, so it is skipped too.
//     Passing that directory as the root explicitly still searches it;
//   - the walk is asynchronous, so a large tree cannot block the main process;
//   - callers learn via `capped` when a result list stopped at its cap.
//
// Argument problems (missing folder, a path that is not a directory, a broken
// regular expression) throw a message meant to be handed back to the model,
// instead of silently degrading into a false "no matches".

import fs from 'fs';
import path from 'path';
import type { SearchMatch, SearchScanResult, GlobScanResult } from '../src/types/ipc.types';

export const DEFAULT_SEARCH_MAX_RESULTS = 200;
export const DEFAULT_GLOB_MAX_RESULTS = 300;

/** Files above this size are never read — not source the agent can act on. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Dependency trees, build output and caches — never worth searching. */
const IGNORED_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'release', 'build', 'out',
  '.next', '.cache', 'coverage', '.worktrees', '.venv', 'venv', '__pycache__',
  'target', '.pytest_cache', '.turbo', '.parcel-cache',
]);

/** True when the child directory is a repository/checkout of its own. */
async function isNestedCheckout(dir: string): Promise<boolean> {
  try {
    await fs.promises.access(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** Reject values the walk cannot honour, with a model-correctable message. */
async function assertSearchRoot(root: string): Promise<void> {
  if (!root || !root.trim()) {
    throw new Error('No folder is open — open a project folder first, or pass an absolute path.');
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(root);
  } catch {
    throw new Error(`path does not exist: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`path is not a directory (got a file): ${root}. Pass a directory, or omit the path to scan the open folder.`);
  }
}

/**
 * Depth-first walk over files, skipping ignored directories and nested
 * checkouts. The visitor returns `true` to stop the walk early (cap reached).
 */
async function walkFiles(
  root: string,
  visit: (filePath: string, name: string) => Promise<boolean | void> | boolean | void,
): Promise<boolean> {
  let stopped = false;
  const walk = async (dir: string): Promise<void> => {
    if (stopped) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory (permissions, race) — skip it.
    }
    for (const entry of entries) {
      if (stopped) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        if (await isNestedCheckout(full)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if ((await visit(full, entry.name)) === true) {
          stopped = true;
          return;
        }
      }
    }
  };
  await walk(root);
  return stopped;
}

export interface SearchFilesOptions {
  /** Absolute directory to scan (the IPC layer passes the open folder). */
  root: string;
  query: string;
  isRegex?: boolean;
  maxResults?: number;
}

export async function searchFiles(opts: SearchFilesOptions): Promise<SearchScanResult> {
  await assertSearchRoot(opts.root);
  const query = opts.query ?? '';
  if (!query) throw new Error('the search query is empty.');

  let re: RegExp | null = null;
  if (opts.isRegex) {
    try {
      re = new RegExp(query, 'i');
    } catch (e: any) {
      throw new Error(
        `invalid regular expression "${query}": ${e?.message || String(e)}. Fix the pattern, or pass isRegex=false.`,
      );
    }
  }
  const needle = query.toLowerCase();
  const max = opts.maxResults && opts.maxResults > 0
    ? Math.floor(opts.maxResults)
    : DEFAULT_SEARCH_MAX_RESULTS;

  const matches: SearchMatch[] = [];
  await walkFiles(opts.root, async (full) => {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      return;
    }
    if (stat.size > MAX_FILE_BYTES) return;
    let content: string;
    try {
      content = await fs.promises.readFile(full, 'utf-8');
    } catch {
      return;
    }
    if (content.includes('\u0000')) return; // Binary — not searchable text.
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle);
      if (!hit) continue;
      matches.push({ file: full, line: i + 1, text: lines[i].trim().slice(0, 240) });
      if (matches.length >= max) return true; // Stop the whole walk.
    }
  });
  // `capped` means the walk stopped at the cap, so more matches may exist.
  return { matches, capped: matches.length >= max };
}

/**
 * Compile a simple glob (`**`, `*`, `?`) into a RegExp. Consecutive stars
 * followed by a slash match any depth INCLUDING zero folders, so an
 * everything-pattern also matches files at the root — the expectation every
 * user has.
 */
export function globToRegExp(pattern: string): RegExp {
  // Question marks become dots BEFORE any group is inserted, so the `?` inside
  // the inserted `(?:…)?` is never treated as a glob wildcard.
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\?/g, '.')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\u0001/g, '(?:.*/)?');
  return new RegExp(`^${source}$`, 'i');
}

export interface FindFilesOptions {
  root: string;
  pattern: string;
  maxResults?: number;
}

export async function findFiles(opts: FindFilesOptions): Promise<GlobScanResult> {
  await assertSearchRoot(opts.root);
  const pattern = (opts.pattern ?? '').trim();
  if (!pattern) throw new Error('the glob pattern is empty.');
  const re = globToRegExp(pattern);
  const max = opts.maxResults && opts.maxResults > 0
    ? Math.floor(opts.maxResults)
    : DEFAULT_GLOB_MAX_RESULTS;

  const files: string[] = [];
  await walkFiles(opts.root, (full, name) => {
    // Patterns use `/`; relative paths use the platform separator.
    const rel = path.relative(opts.root, full).split(path.sep).join('/');
    if (!re.test(rel) && !re.test(name)) return;
    files.push(full);
    if (files.length >= max) return true;
  });
  return { files, capped: files.length >= max };
}
