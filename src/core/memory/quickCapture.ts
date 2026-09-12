import { appendMemoryLine, targetFileFor, type MemoryFile } from './memoryFiles';

// Claude Code's "#" shortcut: start a message with # and the rest of the line
// becomes a remembered instruction instead of a question.
//
// It exists because the moment someone thinks "it should always do X" is the
// moment they are typing, not later in a settings screen — and a memory that
// costs a round-trip to record mostly doesn't get recorded.

/** `# always run the tests` → `always run the tests`. Null if it isn't one. */
export function parseQuickCapture(input: string): string | null {
  // A markdown heading needs a space after the #; so does this, which keeps it
  // from swallowing "#1234" or a "#tag".
  const match = input.match(/^#\s+(.+)$/s);
  if (!match) return null;
  const text = match[1].trim();
  return text ? text : null;
}

export interface CaptureResult {
  ok: boolean;
  /** Message for the transcript — says where it went, or why it didn't. */
  message: string;
  path?: string;
}

/**
 * Write a captured line to the right memory file. Takes its file access as
 * arguments so the rules stay testable without touching a disk.
 */
export async function captureMemory(opts: {
  text: string;
  scope: 'user' | 'project';
  homeDir: string;
  rootPath?: string | null;
  existing?: MemoryFile[];
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<boolean>;
  createDir: (path: string) => Promise<boolean>;
}): Promise<CaptureResult> {
  const path = targetFileFor(opts.scope, opts);
  if (!path) {
    return { ok: false, message: 'No folder is open, so there is no project to remember this for.' };
  }

  const existing = await opts.readFile(path);
  const updated = appendMemoryLine(existing, opts.text);
  if (updated === null) {
    return { ok: true, path, message: `Already remembered in ${path}.` };
  }

  // The user file lives in ~/.conecode, which may not exist on a fresh install.
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir) await opts.createDir(dir).catch(() => false);

  const wrote = await opts.writeFile(path, updated);
  return wrote
    ? { ok: true, path, message: `Remembered in ${path}` }
    : { ok: false, path, message: `Could not write to ${path}.` };
}
