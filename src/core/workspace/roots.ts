// Rules for having several folders open at once.
//
// One of them stays the *primary* root. Plenty of things need exactly one
// directory and always will — where a command runs, which repo `git status`
// describes, which project a dev server belongs to, where a project memory is
// written. Making those ambiguous to support multi-folder would break far more
// than it fixed, so the primary is kept and extra folders are added beside it.
// Only the questions that are genuinely about *all* open folders — what the file
// tree shows, where a search looks, what @ can complete — span the whole set.
//
// Pure path arithmetic, so the awkward cases are pinned down in tests.

export interface AddRootResult {
  ok: boolean;
  /** The normalised path that was added, when ok. */
  path?: string;
  /** Why not, as a key the UI translates. */
  reason?: 'empty' | 'duplicate' | 'inside-existing' | 'contains-existing';
  /** For 'contains-existing': the roots this new one would swallow. */
  covered?: string[];
}

/** Trailing slashes make two spellings of the same folder look different. */
export function normalizeRoot(path: string): string {
  const trimmed = (path || '').trim().replace(/\/+$/, '');
  return trimmed;
}

/** Is `child` the same as, or inside, `parent`? */
export function isInside(child: string, parent: string): boolean {
  const c = normalizeRoot(child);
  const p = normalizeRoot(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + '/');
}

/**
 * Decide whether a folder can join the workspace.
 *
 * Nesting is refused in both directions, because it produces a workspace that
 * lies to the user: the same file appears under two roots, a search returns it
 * twice, and removing one root leaves it still open under the other. Better to
 * say so than to quietly show duplicates.
 */
export function canAddRoot(candidate: string, existing: string[]): AddRootResult {
  const path = normalizeRoot(candidate);
  if (!path) return { ok: false, reason: 'empty' };

  const roots = existing.map(normalizeRoot).filter(Boolean);
  if (roots.some((r) => r === path)) return { ok: false, reason: 'duplicate' };

  const container = roots.find((r) => isInside(path, r));
  if (container) return { ok: false, reason: 'inside-existing', covered: [container] };

  const covered = roots.filter((r) => isInside(r, path));
  if (covered.length) return { ok: false, reason: 'contains-existing', covered };

  return { ok: true, path };
}

/** Display label for a root: its folder name, or enough path to tell two apart. */
export function rootLabel(path: string, allRoots: string[]): string {
  const norm = normalizeRoot(path);
  const name = norm.split('/').pop() || norm;
  const clashes = allRoots
    .map(normalizeRoot)
    .filter((r) => r !== norm && (r.split('/').pop() || r) === name);
  if (!clashes.length) return name;
  // Two folders called "web" — show the parent so they can be told apart.
  const parent = norm.slice(0, norm.lastIndexOf('/')).split('/').pop();
  return parent ? `${parent}/${name}` : name;
}

/**
 * Which open root a path belongs to, or null when it is outside all of them.
 * Longest match wins so the answer stays right if nesting ever slips through.
 */
export function rootOf(path: string, roots: string[]): string | null {
  let best: string | null = null;
  for (const root of roots) {
    const norm = normalizeRoot(root);
    if (isInside(path, norm) && (!best || norm.length > best.length)) best = norm;
  }
  return best;
}

/**
 * Path shown to the model and in @-completion. Files outside the primary root
 * are prefixed with their folder's label, because a bare "src/index.ts" is
 * ambiguous the moment a second folder is open.
 */
export function displayPath(path: string, roots: string[]): string {
  const owner = rootOf(path, roots);
  if (!owner) return path;
  const relative = path.slice(owner.length).replace(/^\//, '');
  // The primary root's files stay unprefixed — that is the common case and the
  // prefix would be noise on every single line.
  if (normalizeRoot(roots[0] || '') === owner) return relative;
  return `${rootLabel(owner, roots)}/${relative}`;
}

/**
 * Turn a display path back into a real one. The inverse of displayPath, and it
 * has to exist: @-completion offers labelled paths, and pasting one onto the
 * primary root would point at a file that isn't there.
 */
export function resolveDisplayPath(display: string, roots: string[]): string | null {
  const value = (display || '').trim();
  if (!value) return null;
  if (value.startsWith('/')) return value;

  const normalized = roots.map(normalizeRoot).filter(Boolean);
  if (!normalized.length) return null;

  // A labelled path names the folder it came from; try the labels first so a
  // folder literally called "api" inside the primary root can't shadow the
  // separate "api" workspace folder.
  for (const root of normalized.slice(1)) {
    const label = rootLabel(root, normalized);
    if (value === label) return root;
    if (value.startsWith(label + '/')) return `${root}/${value.slice(label.length + 1)}`;
  }
  return `${normalized[0]}/${value}`;
}
