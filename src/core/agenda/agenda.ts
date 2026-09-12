// "Find me something to do": the agent looks at the actual state of the
// workspace and proposes concrete, startable work instead of leaving the user
// staring at an empty prompt.
//
// Split in two on purpose:
//   1. A LOCAL scan (git state, TODO comments, scripts, tests) — free, instant,
//      and useful on its own.
//   2. A model pass that turns those raw facts into ranked, actionable tasks.
//
// This module is pure: types, prompt construction, parsing and ranking. No IPC,
// no store — so the format contract is testable without a provider.

export type TaskKind = 'bug' | 'feature' | 'refactor' | 'test' | 'docs' | 'chore';
export type TaskEffort = 'quick' | 'medium' | 'large';
export type TaskRisk = 'low' | 'medium' | 'high';

export interface SuggestedTask {
  id: string;
  title: string;
  /** Why this is worth doing, grounded in something the scan actually saw. */
  rationale: string;
  kind: TaskKind;
  effort: TaskEffort;
  risk: TaskRisk;
  /** Files the work touches, for the card's footer. */
  files: string[];
  /** The instruction sent to the agent when the user starts this task. */
  prompt: string;
}

export interface TodoComment {
  file: string;
  line: number;
  text: string;
}

export interface WorkspaceScan {
  rootPath: string;
  scannedAt: number;
  git: { isRepo: boolean; branch: string | null; dirty: number };
  /** Truncated `git status` — what is uncommitted right now. */
  statusText: string;
  /** Truncated `git diff` so proposals can reference real in-flight edits. */
  diffText: string;
  todoComments: TodoComment[];
  /** npm scripts, so proposals can suggest the project's real commands. */
  scripts: string[];
  projectName: string | null;
  readmeHead: string;
  hasTests: boolean;
  fileCount: number;
  /** True when the walk hit its cap, so fileCount is a floor, not a total. */
  fileCountCapped?: boolean;
  languages: string[];
}

export const TASK_KINDS: TaskKind[] = ['bug', 'feature', 'refactor', 'test', 'docs', 'chore'];
const EFFORTS: TaskEffort[] = ['quick', 'medium', 'large'];
const RISKS: TaskRisk[] = ['low', 'medium', 'high'];

export const MAX_TASKS = 6;

export const SUGGEST_SYSTEM_PROMPT = `You are the "what should I work on next?" planner inside ConeCode, a coding agent.

You are given a factual scan of a real codebase. Propose between 3 and ${MAX_TASKS} concrete pieces of work the agent could start RIGHT NOW, ordered most valuable first. Reply with JSON and nothing else:

{"tasks":[{"title":"...","rationale":"...","kind":"bug|feature|refactor|test|docs|chore","effort":"quick|medium|large","risk":"low|medium|high","files":["relative/path.ts"],"prompt":"..."}]}

Requirements for every task:
- title: under 60 characters, an imperative outcome ("Fix the stale cache in FileTree"), never vague ("improve code").
- rationale: one sentence, and it MUST cite something from the scan — a TODO comment, an uncommitted change, a missing test, a script that exists. No speculation about code you were not shown.
- files: the relative paths you actually expect to touch (empty array if genuinely unknown).
- prompt: a complete, self-contained instruction for the coding agent, written as the user would write it. Say what to do and how to verify it (run the project's real test/build script when there is one). 2-4 sentences.
- effort: quick = under ~15 minutes, medium = under an hour, large = more than that.
- risk: how likely the change is to break something in use.

Rules:
- Prefer finishing what is already in flight (uncommitted work, TODO/FIXME comments) over inventing new features.
- Never propose committing, pushing, deploying, or deleting data.
- Do not propose the same thing twice in different words.
- If the scan is nearly empty, propose orientation work instead (read the entry points and write AGENTS.md, add the first test).`;

/** Render the scan as the compact factual briefing the model reasons over. */
export function buildScanBriefing(scan: WorkspaceScan): string {
  const lines: string[] = [];
  lines.push(`Project: ${scan.projectName || scan.rootPath.split('/').pop() || 'unknown'}`);
  lines.push(`Path: ${scan.rootPath}`);
  if (scan.languages.length) lines.push(`Languages: ${scan.languages.join(', ')}`);
  lines.push(`Files: ${scan.fileCountCapped ? scan.fileCount + '+' : '~' + scan.fileCount}`);
  lines.push(`Tests present: ${scan.hasTests ? 'yes' : 'no'}`);
  if (scan.scripts.length) lines.push(`npm scripts: ${scan.scripts.join(', ')}`);

  if (scan.git.isRepo) {
    lines.push(`Git: branch ${scan.git.branch || '?'}, ${scan.git.dirty} uncommitted file(s)`);
  } else {
    lines.push('Git: not a repository');
  }
  if (scan.statusText.trim()) lines.push(`\n--- git status ---\n${scan.statusText.trim()}`);
  if (scan.diffText.trim()) lines.push(`\n--- git diff (truncated) ---\n${scan.diffText.trim()}`);

  if (scan.todoComments.length) {
    lines.push(
      `\n--- TODO/FIXME comments (${scan.todoComments.length}) ---\n` +
        scan.todoComments.map((c) => `${c.file}:${c.line}: ${c.text}`).join('\n'),
    );
  }
  if (scan.readmeHead.trim()) lines.push(`\n--- README (head) ---\n${scan.readmeHead.trim()}`);
  return lines.join('\n');
}

/**
 * Parse the planner's reply. Tolerates fences and surrounding prose, and drops
 * any task that isn't actionable — a card the user can't click is worse than no
 * card. Returns [] rather than throwing on garbage.
 */
export function parseSuggestions(raw: string, makeId: () => string): SuggestedTask[] {
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
  const list = Array.isArray(parsed?.tasks) ? parsed.tasks : null;
  if (!list) return [];

  const out: SuggestedTask[] = [];
  for (const t of list) {
    const title = typeof t?.title === 'string' ? t.title.trim() : '';
    const prompt = typeof t?.prompt === 'string' ? t.prompt.trim() : '';
    // Both are load-bearing: the title is the card, the prompt is the action.
    if (!title || !prompt) continue;
    if (out.some((existing) => existing.title.toLowerCase() === title.toLowerCase())) continue;

    out.push({
      id: makeId(),
      title: title.slice(0, 120),
      rationale: typeof t.rationale === 'string' ? t.rationale.trim().slice(0, 300) : '',
      kind: TASK_KINDS.includes(t?.kind) ? t.kind : 'chore',
      effort: EFFORTS.includes(t?.effort) ? t.effort : 'medium',
      risk: RISKS.includes(t?.risk) ? t.risk : 'low',
      files: Array.isArray(t?.files)
        ? t.files.filter((f: any) => typeof f === 'string' && f.trim()).slice(0, 6)
        : [],
      prompt,
    });
    if (out.length >= MAX_TASKS) break;
  }
  return out;
}

/**
 * What a "resume yesterday" card needs to be worth clicking: not just a title,
 * but what state the work was left in.
 */
export interface ResumeCandidate {
  conversationId: string;
  title: string;
  rootPath?: string | null;
  updatedAt: number;
  /** Last thing said, for a one-line preview. */
  lastMessage: string;
  /** Unfinished checklist items recovered from the transcript's last update_todos. */
  openTodos: string[];
  /** Changes proposed in that conversation that were never resolved. */
  pendingChanges: number;
}

/**
 * Recover the last checklist the agent published in a conversation, so a resume
 * card can show what is still open. The todo store is per-session, so the
 * transcript is the only durable record of it.
 */
export function recoverOpenTodos(messages: { content: string; role: string }[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content || '';
    if (!content.includes('update_todos')) continue;
    const todos = extractTodosFromText(content);
    if (todos) return todos.filter((td) => td.status !== 'completed').map((td) => td.content);
  }
  return [];
}

function extractTodosFromText(content: string): { content: string; status?: string }[] | null {
  // Matches both the fenced ```json action and a raw tool-call argument blob.
  const candidates: string[] = [];
  const fenced = content.matchAll(/```json\s*\n([\s\S]*?)\n```/g);
  for (const m of fenced) candidates.push(m[1]);
  const brace = content.indexOf('{');
  if (brace !== -1) candidates.push(content.slice(brace));

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (Array.isArray(obj?.todos)) return obj.todos;
    } catch {}
  }
  // Fall back to pulling the todos array out of a larger blob.
  const arrayMatch = content.match(/"todos"\s*:\s*(\[[\s\S]*?\])/);
  if (arrayMatch) {
    try {
      const arr = JSON.parse(arrayMatch[1]);
      if (Array.isArray(arr)) return arr;
    } catch {}
  }
  return null;
}

/** The instruction sent when the user clicks "continue" on a resume card. */
export function buildResumePrompt(candidate: ResumeCandidate): string {
  const parts: string[] = [
    'Pick this work back up where we left off. First re-read the relevant files to confirm the CURRENT state of the code before changing anything — do not trust the earlier transcript over what is on disk now.',
  ];
  if (candidate.openTodos.length) {
    parts.push(`Still open from last time:\n${candidate.openTodos.map((td) => `- ${td}`).join('\n')}`);
  }
  if (candidate.pendingChanges > 0) {
    parts.push(`${candidate.pendingChanges} proposed change(s) were never applied — re-evaluate whether they are still correct rather than reapplying them blindly.`);
  }
  parts.push('Then continue until it is done and verified. Tell me in one line what you are picking up before you start.');
  return parts.join('\n\n');
}

/** The instruction that scaffolds a brand-new project from a one-line idea. */
export function buildNewProjectPrompt(idea: string, targetDir: string): string {
  return `Create a new project in ${targetDir} for this idea:

${idea}

Do it properly: pick a suitable, current stack and explain the choice in one line; scaffold the real directory structure and config; write the initial working code (not placeholders); add a README with exact install/run/test commands; and add one test that actually passes. Run the install and the test to prove it works before reporting done. If the directory already has files, stop and ask me before touching anything.`;
}

/** Ranking for display: value first, then cheapness, then safety. */
export function rankTasks(tasks: SuggestedTask[]): SuggestedTask[] {
  const kindWeight: Record<TaskKind, number> = { bug: 0, test: 1, refactor: 2, feature: 3, docs: 4, chore: 5 };
  const effortWeight: Record<TaskEffort, number> = { quick: 0, medium: 1, large: 2 };
  const riskWeight: Record<TaskRisk, number> = { low: 0, medium: 1, high: 2 };
  return [...tasks].sort(
    (a, b) =>
      kindWeight[a.kind] - kindWeight[b.kind] ||
      effortWeight[a.effort] - effortWeight[b.effort] ||
      riskWeight[a.risk] - riskWeight[b.risk],
  );
}

// ---------------------------------------------------------------------------
// "What should I do next?"
// ---------------------------------------------------------------------------

export type RecommendationKind = 'resume' | 'review' | 'task' | 'tests' | 'start';

export interface Recommendation {
  kind: RecommendationKind;
  /** i18n key for the headline. */
  key: string;
  /** Concrete detail from real state — the count, the title, the branch. */
  detail?: string;
}

/**
 * The single next action to put in front of the user, chosen from what is
 * actually true about their workspace. Ordered by what a person would regret
 * skipping: unfinished work first, then work in flight, then new work.
 *
 * The point is that the screen makes the call — the user only has to agree.
 */
export function recommendNext(state: {
  hasFolder: boolean;
  dirty: number;
  hasTests: boolean;
  openTodos: number;
  topTask?: string;
}): Recommendation {
  if (!state.hasFolder) return { kind: 'start', key: 'recStart' };
  // Something was left half-done — finishing it beats starting anything.
  if (state.openTodos > 0) return { kind: 'resume', key: 'recResume', detail: String(state.openTodos) };
  // Uncommitted work is unreviewed work.
  if (state.dirty > 0) return { kind: 'review', key: 'recReview', detail: String(state.dirty) };
  if (state.topTask) return { kind: 'task', key: 'recTask', detail: state.topTask };
  if (!state.hasTests) return { kind: 'tests', key: 'recTests' };
  return { kind: 'start', key: 'recStartNew' };
}
