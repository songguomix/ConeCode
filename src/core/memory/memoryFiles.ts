// Memory that lives in files, the way Claude Code does it.
//
// The store in memory.ts holds what the assistant *inferred* about the user. This
// module holds what they wrote down on purpose — and the difference matters, so
// the two are kept apart rather than merged into one opaque blob:
//
//   ~/.conecode/CLAUDE.md   applies to every project this person opens
//   <project>/CLAUDE.md     belongs to the project, gets committed, shows up in
//                           a diff, and is still there when the folder is renamed
//   <ancestor>/CLAUDE.md    a monorepo root's rules reach the packages beneath it
//
// A JSON blob in userData keyed by absolute path can't do any of that: it dies
// when the folder moves and no teammate ever sees it. Everything here is pure —
// path arithmetic and string transforms — so the rules are testable without a
// filesystem; the caller supplies the reads and writes.

/** Filenames recognised as project memory, best first. */
export const PROJECT_MEMORY_FILES = ['CLAUDE.md', 'AGENTS.md', '.conecode/AGENTS.md'];

/** Where a person's own cross-project memory lives, relative to the home dir. */
export const USER_MEMORY_FILE = '.conecode/CLAUDE.md';

/** The section ConeCode appends to, so what it wrote stays distinguishable. */
export const MEMORY_HEADING = '## Memory';

/**
 * How far up the tree to look for inherited memory. Deep enough for a package
 * inside a monorepo to pick up the root's rules, shallow enough that opening a
 * folder in your home directory doesn't drag in something from three levels up.
 */
export const MAX_ANCESTOR_DEPTH = 4;

export type MemoryFileScope = 'user' | 'project' | 'ancestor';

export interface MemoryFile {
  path: string;
  scope: MemoryFileScope;
  /** Absent until the caller reads it; null means the file isn't there. */
  content?: string | null;
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}

function parentOf(dir: string): string | null {
  const trimmed = dir.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut <= 0) return null;
  return trimmed.slice(0, cut);
}

/**
 * Every path that could hold memory for this workspace, ordered furthest-first:
 * the user's own file, then ancestors from the top down, then the project. The
 * order is the precedence order — the nearest file is read last, so when two
 * files disagree the more specific one is what the model saw most recently.
 */
export function memoryFileCandidates(opts: { homeDir: string; rootPath?: string | null }): MemoryFile[] {
  const out: MemoryFile[] = [{ path: joinPath(opts.homeDir, USER_MEMORY_FILE), scope: 'user' }];
  if (!opts.rootPath) return out;

  const root = opts.rootPath.replace(/\/+$/, '');

  // Walk up first, then reverse, so the outermost ancestor comes before the
  // ones nested inside it.
  const ancestors: string[] = [];
  let dir = parentOf(root);
  for (let depth = 0; dir && depth < MAX_ANCESTOR_DEPTH; depth++) {
    // Stop at the home directory: everything above it is somebody's whole disk,
    // not a project, and the user file already covers that level.
    if (dir === opts.homeDir.replace(/\/+$/, '')) break;
    ancestors.push(dir);
    dir = parentOf(dir);
  }
  for (const ancestor of ancestors.reverse()) {
    for (const name of PROJECT_MEMORY_FILES) out.push({ path: joinPath(ancestor, name), scope: 'ancestor' });
  }

  for (const name of PROJECT_MEMORY_FILES) out.push({ path: joinPath(root, name), scope: 'project' });
  return out;
}

/**
 * Narrow the candidates to the files that exist. Within one directory only the
 * first hit counts — a repo with both CLAUDE.md and AGENTS.md means one of them
 * is the real one, and loading both would double every rule.
 */
export function selectExistingFiles(candidates: MemoryFile[]): MemoryFile[] {
  const out: MemoryFile[] = [];
  const claimed = new Set<string>();
  for (const file of candidates) {
    if (file.content == null || !file.content.trim()) continue;
    const dir = file.path.slice(0, file.path.lastIndexOf('/'));
    // `.conecode/AGENTS.md` sits one level down; credit it to the project dir.
    const owner = dir.endsWith('/.conecode') ? dir.slice(0, -'/.conecode'.length) : dir;
    if (claimed.has(owner)) continue;
    claimed.add(owner);
    out.push(file);
  }
  return out;
}

/**
 * Which file a newly captured memory should be written to. Project memory goes
 * to the project's own file — creating CLAUDE.md if the repo has no memory file
 * yet, but writing to AGENTS.md when that is the one the repo already uses.
 */
export function targetFileFor(
  scope: 'user' | 'project',
  opts: { homeDir: string; rootPath?: string | null; existing?: MemoryFile[] },
): string | null {
  if (scope === 'user') return joinPath(opts.homeDir, USER_MEMORY_FILE);
  if (!opts.rootPath) return null;

  const root = opts.rootPath.replace(/\/+$/, '');
  const alreadyUsed = (opts.existing || []).find((f) => f.scope === 'project');
  return alreadyUsed?.path ?? joinPath(root, PROJECT_MEMORY_FILES[0]);
}

/**
 * Add a line to a memory file, under ConeCode's own heading so it stays obvious
 * which lines were captured and which the human wrote. Returns the file's new
 * contents, or null when the line is already there — re-recording the same rule
 * should be a no-op, not a second copy of it.
 */
export function appendMemoryLine(existing: string | null, text: string): string | null {
  const line = `- ${text.trim().replace(/^[-*]\s*/, '')}`;
  if (!line.slice(2).trim()) return null;

  const content = existing ?? '';
  if (hasLine(content, line)) return null;

  const headingAt = content.split('\n').findIndex((l) => l.trim().toLowerCase() === MEMORY_HEADING.toLowerCase());
  if (headingAt === -1) {
    const base = content.trimEnd();
    return `${base ? base + '\n\n' : ''}${MEMORY_HEADING}\n\n${line}\n`;
  }

  // Insert at the end of that section — before the next heading, not after it,
  // or the line lands under somebody else's title.
  const lines = content.split('\n');
  let end = lines.length;
  for (let i = headingAt + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  }
  while (end > headingAt + 1 && lines[end - 1].trim() === '') end--;

  lines.splice(end, 0, line);
  return lines.join('\n').replace(/\n*$/, '\n');
}

function hasLine(content: string, line: string): boolean {
  const wanted = normalize(line);
  return content.split('\n').some((l) => normalize(l) === wanted);
}

function normalize(line: string): string {
  return line.trim().replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Render the loaded files as one system message. Nearest last, each labelled
 * with where it came from so the model can tell a project rule from a personal
 * one and weigh them accordingly.
 */
export function formatMemoryFiles(files: MemoryFile[]): string {
  const usable = files.filter((f) => f.content && f.content.trim());
  if (!usable.length) return '';

  const sections = usable.map((file) => {
    const label = file.scope === 'user'
      ? 'Your instructions for every project'
      : file.scope === 'ancestor'
        ? `Inherited from ${file.path}`
        : `This project (${file.path})`;
    return `--- ${label} ---\n${file.content!.trim()}`;
  });

  return `Instructions the user wrote down for you to follow. Later sections are more specific and win where they conflict; treat all of it as standing direction rather than as something to acknowledge.\n\n${sections.join('\n\n')}`;
}
