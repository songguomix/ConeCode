// Long-term memory: what ConeCode has learned about this user across sessions.
//
// The goal is a conversation that fits the person in front of it — so the agent
// remembers two things a transcript alone can't carry between sessions:
//   - the code problems they keep hitting (so it checks for them proactively)
//   - how they talk and want to be talked to (language, tone, length, process)
//
// This module is deliberately pure: extraction prompt, parsing, dedupe/merge and
// prompt rendering, with no IPC or store access, so all of it is testable.

// The two kinds that carry the most weight for a coding assistant are
// `workflow` (how work should be done here) and `project` (what is true about
// this codebase). They used to be a vague `preference` and a `fact` with a path
// attached, which made them read as trivia; both now have their own kind and
// their own reason, because a rule whose reason is unknown gets cargo-culted
// long after it stopped applying.
export type MemoryKind = 'workflow' | 'project' | 'codeIssue' | 'style' | 'fact';

export const MEMORY_KINDS: MemoryKind[] = ['workflow', 'project', 'codeIssue', 'style', 'fact'];

/** Kinds retired in favour of the two above, still present in stored memory. */
const LEGACY_KINDS: Record<string, MemoryKind> = { preference: 'workflow' };

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  /** One durable fact, written as an instruction to the assistant. */
  text: string;
  /**
   * Why this holds — the evidence or reasoning behind it. Optional, but asked
   * for on workflow and project entries: it is what lets a later session decide
   * the rule still applies instead of following it blindly, and what lets the
   * user judge whether the assistant learned the right lesson.
   */
  why?: string;
  /** Project memories only apply inside that workspace. */
  scope: 'global' | 'project';
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
  /** How many times this has been re-observed — used to rank and to prune. */
  hits: number;
}

/**
 * Bring a stored entry up to the current shape. Memory is persisted as plain
 * JSON that predates these kinds, so every read goes through here rather than
 * trusting the file — an unmigrated entry would land under a heading that no
 * longer exists and silently drop out of the prompt.
 */
export function migrateEntry(raw: any): MemoryEntry | null {
  if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) return null;

  const scope: 'global' | 'project' = raw.scope === 'project' ? 'project' : 'global';
  let kind: MemoryKind = LEGACY_KINDS[raw.kind] ?? raw.kind;
  // A durable fact tied to one workspace is exactly what `project` now means.
  if (kind === 'fact' && scope === 'project') kind = 'project';
  if (!MEMORY_KINDS.includes(kind)) kind = 'fact';

  const now = Date.now();
  return {
    id: typeof raw.id === 'string' ? raw.id : `mem-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    text: raw.text.trim(),
    why: typeof raw.why === 'string' && raw.why.trim() ? raw.why.trim() : undefined,
    scope,
    projectPath: scope === 'project' && typeof raw.projectPath === 'string' ? raw.projectPath : undefined,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
    hits: Number.isFinite(raw.hits) && raw.hits > 0 ? raw.hits : 1,
  };
}

/** Migrate a whole stored list, dropping anything unreadable. */
export function migrateEntries(raw: unknown): MemoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(migrateEntry).filter((e): e is MemoryEntry => e !== null);
}

/** Hard cap so memory can never grow into a context-window problem. */
export const MAX_MEMORIES = 60;
/** Per-entry cap; anything longer is a summary, not a memory. */
export const MAX_MEMORY_LENGTH = 240;

export const EXTRACTION_SYSTEM_PROMPT = `You maintain the long-term memory of a coding assistant, so future sessions fit this user and this codebase without being told twice.

From the exchange you are given, extract ONLY durable facts worth remembering weeks from now. Reply with JSON and nothing else:

{"memories":[{"kind":"workflow|project|codeIssue|style|fact","scope":"global|project","text":"...","why":"..."}]}

The two that matter most:

- workflow — how work should be DONE here: the process, the checks, the habits. What they insist on before something counts as finished, what they want asked first, what they never want done. These are the highest-value memories; look for them hardest.
  e.g. "Run the test suite and report real output before calling a task done" / "Ask before adding a dependency"
- project  — what is durably TRUE about this codebase: stack, architecture decisions, conventions, constraints, and the traps that are not obvious from reading the code.
  e.g. "Pure logic lives in src/core so it can be tested; anything touching the OS goes in electron/"

The rest:
- codeIssue — a defect pattern this user's code keeps hitting. Include the SYMPTOM so it can be checked for.
- style     — how they communicate and want to be answered: language, tone, how much detail, how blunt.
- fact      — a durable fact that fits none of the above.

why: for workflow and project entries, give ONE short clause of evidence — what happened that makes this true ("after a rebuild silently shipped the old code"). A rule with no reason gets followed long after it stops applying, and the user cannot tell whether you learned the right lesson. Omit it if you would have to invent one.

scope: "project" if it only holds inside this codebase, "global" if it holds for this person everywhere. workflow can be either; project is always "project".

Rules:
- Return [] unless something is genuinely durable. Most exchanges produce nothing. Never invent.
- One specific fact per entry, under 200 characters, written as guidance to the assistant ("Prefers...", "Always...", "Uses...").
- Prefer what the user SHOWED — a correction, a repeated request, a complaint — over anything said once in passing. A correction is the strongest signal there is; when you see one, record the general rule behind it, not the specific incident.
- NEVER record secrets, API keys, tokens, passwords, or file contents.
- Do not repeat anything already in the existing memory list — only genuinely new or meaningfully sharper facts.`;

/** Normalized key for dedupe: same idea written slightly differently collapses. */
function memoryKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Two memories count as the same when one's wording contains the other's — the
 * model rarely repeats itself word for word, so exact matching would let near
 * duplicates pile up until the memory block is all restatements of one fact.
 */
export function isSameMemory(a: string, b: string): boolean {
  const ka = memoryKey(a);
  const kb = memoryKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  // Ignore trivially short strings, where containment means nothing.
  return short.length >= 12 && long.includes(short);
}

export interface ParsedMemory {
  kind: MemoryKind;
  text: string;
  scope: 'global' | 'project';
  why?: string;
}

/**
 * Pull the memory list out of an extraction reply. Models wrap JSON in prose or
 * fences often enough that a plain JSON.parse would throw away good extractions,
 * so this scans for the object. Returns [] on anything unusable — a failed
 * extraction must never break the turn that triggered it.
 */
export function parseExtraction(raw: string): ParsedMemory[] {
  if (!raw) return [];
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  if (start === -1) return [];

  let parsed: any = null;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
      break;
    } catch {}
  }
  if (!parsed || !Array.isArray(parsed.memories)) return [];

  const out: ParsedMemory[] = [];
  for (const m of parsed.memories) {
    const value = typeof m?.text === 'string' ? m.text.trim() : '';
    if (!value || value.length > MAX_MEMORY_LENGTH) continue;
    if (looksLikeSecret(value)) continue;

    const kind: MemoryKind = LEGACY_KINDS[m?.kind] ?? (MEMORY_KINDS.includes(m?.kind) ? m.kind : 'fact');
    const why = typeof m?.why === 'string' ? m.why.trim() : '';
    out.push({
      kind,
      // A project fact that isn't scoped to the project is a contradiction; the
      // scope is what makes it a project memory at all.
      scope: kind === 'project' || m?.scope === 'project' ? 'project' : 'global',
      text: value,
      why: why && why.length <= MAX_MEMORY_LENGTH && !looksLikeSecret(why) ? why : undefined,
    });
  }
  return out;
}

// Never persist credentials, whatever the model decided was memorable.
const SECRET_PATTERNS = [
  /\bsk-[a-z0-9-]{16,}/i,
  /\b(?:api[-_ ]?key|secret|token|password|passwd|bearer)\b\s*[:=]/i,
  /\bgh[pousr]_[a-z0-9]{20,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/**
 * Fold newly extracted memories into the existing set: reinforce what's already
 * known (bumping its hit count instead of duplicating), add what's new, and cap
 * the total by dropping the least-reinforced, oldest entries.
 */
export function mergeMemories(
  existing: MemoryEntry[],
  incoming: ParsedMemory[],
  ctx: { projectPath?: string | null; now?: number; makeId: () => string },
): MemoryEntry[] {
  const now = ctx.now ?? Date.now();
  const out = [...existing];

  for (const item of incoming) {
    const scope = item.scope === 'project' && ctx.projectPath ? 'project' : 'global';
    const projectPath = scope === 'project' ? ctx.projectPath || undefined : undefined;

    const match = out.find(
      (e) => e.scope === scope && e.projectPath === projectPath && isSameMemory(e.text, item.text),
    );
    if (match) {
      match.hits += 1;
      match.updatedAt = now;
      // Keep the sharper (longer) phrasing of the same idea.
      if (item.text.length > match.text.length) match.text = item.text;
      // A reason learned later still applies to what was recorded earlier.
      if (item.why && !match.why) match.why = item.why;
      continue;
    }
    out.push({
      id: ctx.makeId(),
      kind: item.kind,
      text: item.text,
      why: item.why,
      scope,
      projectPath,
      createdAt: now,
      updatedAt: now,
      hits: 1,
    });
  }

  if (out.length <= MAX_MEMORIES) return out;
  // Prune: least reinforced first, then least recently confirmed.
  return [...out]
    .sort((a, b) => b.hits - a.hits || b.updatedAt - a.updatedAt)
    .slice(0, MAX_MEMORIES);
}

/** The memories that apply right now: global ones plus this project's. */
export function selectRelevant(entries: MemoryEntry[], projectPath?: string | null): MemoryEntry[] {
  return entries
    .filter((e) => e.scope === 'global' || (!!projectPath && e.projectPath === projectPath))
    .sort((a, b) => b.hits - a.hits || b.updatedAt - a.updatedAt);
}

const KIND_HEADINGS: Record<MemoryKind, string> = {
  workflow: 'HOW THIS USER WANTS WORK DONE — follow these unless they say otherwise',
  project: 'ABOUT THIS PROJECT — things that are true here and not obvious from the code',
  codeIssue: 'Recurring problems in their code — watch for these',
  style: 'How they communicate — match this',
  fact: 'Durable facts',
};

// Workflow first: it changes what the assistant *does*, so it should be read
// before anything else. Project second, for the same reason. Style and trivia
// last — they only shape the wording.
const KIND_ORDER: MemoryKind[] = ['workflow', 'project', 'codeIssue', 'style', 'fact'];

function renderEntry(entry: MemoryEntry): string {
  // The reason rides along so the assistant can tell an applicable rule from a
  // stale one, rather than following every line literally forever.
  return entry.why ? `- ${entry.text}\n  (learned: ${entry.why})` : `- ${entry.text}`;
}

/**
 * Render memories as a system message. Returns '' when there is nothing to say,
 * so an empty memory never costs a prompt slot.
 */
export function formatMemoryPrompt(entries: MemoryEntry[]): string {
  if (!entries.length) return '';
  const sections: string[] = [];
  for (const kind of KIND_ORDER) {
    const group = entries.filter((e) => e.kind === kind);
    if (!group.length) continue;
    sections.push(`${KIND_HEADINGS[kind]}:\n${group.map(renderEntry).join('\n')}`);
  }
  if (!sections.length) return '';
  return `What previous sessions learned about this user and this project. Apply it silently: follow the workflow rules, treat the project notes as established context, adapt your language and depth to match, and proactively check for the code problems listed.

A reason in parentheses is the evidence the rule came from — if the situation it describes no longer holds, say so instead of following the rule blindly. Never announce that you are using memory, and drop any item the user contradicts.

${sections.join('\n\n')}`;
}
