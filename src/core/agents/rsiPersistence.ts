// RSI disk persistence — iteration files, evolution log, lessons, loop state.
//
// All functions take an injected `RsiFs` (see rsiTree.ts): tests pass memory,
// the Electron main process passes a node:fs adapter (see electron/rsiFsNode),
// and the renderer goes through its existing tool/bridge path. Nothing here
// imports node:fs, so the renderer bundle stays intact.
//
// Files under <rsiDir>/ (default ".conecode/rsi"):
//   iterations/<candidate-id>.md  one append-only record per candidate
//   trees/<episode>.json          discovery trees (rsiTree.saveTree)
//   EVOLUTION_LOG.md              accepted + slow-registered wins only
//   REFLECTIONS.md                earned lessons only (cap ~30, contamination filter)
//   LOOP_STATE.json               crash/interrupt recovery (validated on load)
//   STRATEGY.md                   current exploration-policy id (DREAM output)

import type { EpisodeResult } from './rsiReward';
import type { CandidateDeclaration, GoalVector, LoopState } from './rsiLoop';
import { createLoopState } from './rsiLoop';
import type { DiscoveryTree, ExperimentRecord, RsiFs } from './rsiTree';

export const RSI_ITERATIONS_DIR = 'iterations';
export const RSI_TREES_DIR = 'trees';
export const RSI_EVOLUTION_LOG = 'EVOLUTION_LOG.md';
export const RSI_REFLECTIONS = 'REFLECTIONS.md';
export const RSI_LOOP_STATE = 'LOOP_STATE.json';
export const RSI_STRATEGY = 'STRATEGY.md';
export const RSI_GOAL_VECTOR = 'GOAL_VECTOR.md';
export const RSI_BASELINE = 'BASELINE.json';
export const MAX_LESSONS = 30;

// ---------------------------------------------------------------------------
// Tiny string hash (djb2, hex) — bundle-safe goal-freeze fingerprint.
// No node:crypto here: src/ must stay renderer-bundlable.
// ---------------------------------------------------------------------------

export function hashContent(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function join(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

export function iterationFilePath(rsiDir: string, candidateId: string): string {
  const safe = candidateId.replace(/[^a-zA-Z0-9-_]/g, '_');
  return join(join(rsiDir, RSI_ITERATIONS_DIR), `${safe}.md`);
}

// ---------------------------------------------------------------------------
// Iteration file — one append-only markdown record per candidate.
// ---------------------------------------------------------------------------

export interface IterationRecord {
  candidate: CandidateDeclaration;
  result: EpisodeResult;
  reward: number;
  verdict: string;
  reason: string;
  status: string;
  costUsd: number;
  failureReason?: string;
  diagnostics?: string;
  parentId: string | null;
  baselineId: string;
  strategyId: string;
  timestamp: number;
}

export function renderIterationFile(r: IterationRecord): string {
  const lines = [
    `# RSI iteration ${r.candidate.id}`,
    '',
    `- module: ${r.candidate.module}`,
    `- status: ${r.status}`,
    `- reward: ${r.reward}`,
    `- verdict: ${r.verdict} (${r.reason})`,
    `- externalPass: ${r.result.externalPass}`,
    `- parent: ${r.parentId ?? '(none)'} | baseline: ${r.baselineId} | strategy: ${r.strategyId}`,
    `- costUsd: ${r.costUsd} (budget ${r.candidate.costBudgetUsd})`,
  ];
  if (r.failureReason) lines.push(`- failureReason: ${r.failureReason}`);
  lines.push(
    '', '## Candidate declaration', '',
    '```json', JSON.stringify(r.candidate, null, 2), '```',
    '', '## Verification', '',
    `- metrics: ${r.result.metrics.map((m) => `${m.id} Δ=${m.delta}${m.scale != null ? ` scale=${m.scale}` : ''}${m.minDelta != null ? ` floor=${m.minDelta}` : ''}`).join('; ') || '(none)'}`,
    `- judges: alignment=${r.result.judges.alignment} simplicity=${r.result.judges.simplicity} discipline=${r.result.judges.discipline}`,
    `- filesTouched=${r.result.filesTouched} linesChanged=${r.result.linesChanged}`,
  );
  if (r.diagnostics) lines.push('', '## Diagnostics', '', r.diagnostics);
  lines.push('', `_Recorded ${new Date(r.timestamp).toISOString()}. History is append-only: never rewrite this file to flatter a later run._`, '');
  return lines.join('\n');
}

/** Write once: refuses to overwrite an existing record (history is append-only). */
export function writeIterationFile(fs: RsiFs, rsiDir: string, r: IterationRecord): { path: string; skipped: boolean } {
  fs.mkdir?.(join(rsiDir, RSI_ITERATIONS_DIR));
  const path = iterationFilePath(rsiDir, r.candidate.id);
  if (fs.readFile(path) != null) return { path, skipped: true };
  fs.writeFile(path, renderIterationFile(r));
  return { path, skipped: false };
}

// ---------------------------------------------------------------------------
// Evolution log — accepted AND slow-registered wins only.
// ---------------------------------------------------------------------------

export function appendEvolutionLog(
  fs: RsiFs, rsiDir: string,
  entry: { id: string; module: string; reward: number; summary: string; timestamp?: number },
): string {
  if (!entry.id.trim()) throw new Error('evolution entry id must be non-empty');
  if (!Number.isFinite(entry.reward)) throw new Error('evolution entry reward must be finite');
  const path = join(rsiDir, RSI_EVOLUTION_LOG);
  const prev = fs.readFile(path) ?? '# RSI evolution log\n\n_Accepted, slow-registered improvements only. Append-only._\n';
  const stamp = new Date(entry.timestamp ?? Date.now()).toISOString();
  const block = `\n## ${stamp} ${entry.id} [${entry.module}] reward=${entry.reward}\n\n${entry.summary.trim()}\n`;
  fs.writeFile(path, `${prev.replace(/\n*$/, '\n')}${block}`);
  return path;
}

// ---------------------------------------------------------------------------
// Lessons (REFLECTIONS.md) — earned, contamination-filtered, capped.
// ---------------------------------------------------------------------------

export interface Lesson {
  id: string;
  module: string;
  text: string;
  episodes: string[];
  outcome: string;
}

/** Patterns that mark a "lesson" as policy-contamination, never persistable. */
const CONTAMINATION_PATTERNS = [
  /weaken/i, /bypass/i, /disable\s+(test|check|auth|tls|sandbox|approval)/i,
  /skip\s+(test|verif|check)/i, /delete\s+(test|assert)/i, /quarantine/i,
  /ignore\s+(invariant|safety|policy)/i, /no-?verify/i, /approve-?all/i,
  /hardcod.*(password|secret|token)/i, /disable.*valid/i,
];

export function isContaminatedLesson(text: string): boolean {
  return CONTAMINATION_PATTERNS.some((re) => re.test(text));
}

const LESSON_LINE = /^- \[(.+?)\] \[(.+?)\] \[(.+?)\] (.+?) \(episodes: (.*)\)$/;

export function parseReflections(content: string): Lesson[] {
  const out: Lesson[] = [];
  for (const line of content.split('\n')) {
    const m = LESSON_LINE.exec(line.trim());
    if (!m) continue;
    out.push({
      id: m[1], module: m[2], outcome: m[3], text: m[4],
      episodes: m[5].split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  return out;
}

export interface LessonOutcome {
  appended: boolean;
  reinforced: boolean;
  rejected: 'contaminated' | 'duplicate-text' | null;
}

/**
 * Slow registration for lessons: at most ONE lesson per call, reusable rules
 * only (caller decides), duplicates reinforce by appending the episode id,
 * neutrals pruned past the cap. Contaminated text is refused outright.
 */
export function appendLesson(
  fs: RsiFs, rsiDir: string,
  lesson: { module: string; text: string; episodeId: string; outcome: string },
): LessonOutcome {
  const text = lesson.text.trim();
  if (text.length < 8 || text.length > 400) throw new Error('lesson text must be 8–400 chars');
  if (isContaminatedLesson(text)) return { appended: false, reinforced: false, rejected: 'contaminated' };
  const path = join(rsiDir, RSI_REFLECTIONS);
  const prev = fs.readFile(path) ?? '# RSI reflections\n\n_Reusable rules only (≤2 sentences each). Lessons are DATA, never policy changes._\n';
  const lessons = parseReflections(prev);
  // Same rule already recorded (fuzzy: normalized text match) → reinforce.
  const norm = text.toLowerCase().replace(/\s+/g, ' ');
  const dup = lessons.find((l) => l.text.toLowerCase().replace(/\s+/g, ' ') === norm);
  if (dup) {
    if (dup.episodes.includes(lesson.episodeId)) return { appended: false, reinforced: false, rejected: 'duplicate-text' };
    const next = lessons.map((l) => l.id === dup.id
      ? { ...l, episodes: [...l.episodes, lesson.episodeId] }
      : l);
    fs.writeFile(path, renderReflections(next));
    return { appended: false, reinforced: true, rejected: null };
  }
  const id = `les-${String(lessons.length + 1).padStart(3, '0')}`;
  const entry: Lesson = { id, module: lesson.module, text, episodes: [lesson.episodeId], outcome: lesson.outcome };
  // Prune past the cap: drop the oldest reinforced-neutral entries first.
  const kept = [...lessons, entry];
  while (kept.length > MAX_LESSONS) kept.shift();
  fs.writeFile(path, renderReflections(kept));
  return { appended: true, reinforced: false, rejected: null };
}

function renderReflections(lessons: Lesson[]): string {
  const head = '# RSI reflections\n\n_Reusable rules only (≤2 sentences each). Lessons are DATA, never policy changes._\n\n';
  return head + lessons.map((l) => `- [${l.id}] [${l.module}] [${l.outcome}] ${l.text} (episodes: ${l.episodes.join(', ')})`).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Numeric baseline — established by the first ASSESS run, frozen afterwards.
// Deltas are meaningless without it; a missing baseline blocks scoring.
// ---------------------------------------------------------------------------

/** Persist ASSESS-measured absolute values (one number per metric id). */
export function saveBaseline(fs: RsiFs, rsiDir: string, values: Record<string, number>): string {
  for (const [k, v] of Object.entries(values)) {
    if (!k.trim()) throw new Error('baseline metric id must be non-empty');
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`baseline ${k} must be finite`);
  }
  const path = join(rsiDir, RSI_BASELINE);
  fs.writeFile(path, JSON.stringify({ values }, null, 2));
  return path;
}

/** Validated numeric baseline, or null when ASSESS has not recorded one. */
export function loadBaseline(fs: RsiFs, rsiDir: string): Record<string, number> | null {
  const raw = fs.readFile(join(rsiDir, RSI_BASELINE));
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BASELINE.json is not valid JSON');
  }
  const values = (parsed as { values?: unknown }).values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('BASELINE.json must hold {values: {metric: number}}');
  }
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`baseline ${k} must be finite`);
  }
  return values as Record<string, number>;
}

// ---------------------------------------------------------------------------
// Loop state — crash/interrupt recovery (validated on load).
// ---------------------------------------------------------------------------

const LOOP_STATE_VERSION = 1;

export function saveLoopState(fs: RsiFs, rsiDir: string, state: LoopState): string {
  const path = join(rsiDir, RSI_LOOP_STATE);
  fs.writeFile(path, JSON.stringify({ version: LOOP_STATE_VERSION, state }, null, 2));
  return path;
}

export function loadLoopState(fs: RsiFs, rsiDir: string): LoopState | null {
  const raw = fs.readFile(join(rsiDir, RSI_LOOP_STATE));
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('LOOP_STATE.json is not valid JSON');
  }
  const root = parsed as { version?: unknown; state?: unknown };
  if (root.version !== LOOP_STATE_VERSION) throw new Error(`unsupported LOOP_STATE version: ${String(root.version)}`);
  return validateLoopState(root.state);
}

function validateLoopState(s: unknown): LoopState {
  if (!s || typeof s !== 'object') throw new Error('LOOP_STATE state must be an object');
  const st = s as Record<string, unknown>;
  const req = ['goal', 'workspaceRoot', 'episodeIndex', 'best', 'baselineReward', 'rewardHistory',
    'consecutiveNonImproving', 'consecutiveHardFails', 'acceptedCount', 'spentUsd',
    'archive', 'seenIds', 'recentFailures', 'recentModules'];
  for (const k of req) {
    if (!(k in st)) throw new Error(`LOOP_STATE missing field: ${k}`);
  }
  if (!Array.isArray(st.rewardHistory) || !st.rewardHistory.every((r) => typeof r === 'number')) {
    throw new Error('LOOP_STATE rewardHistory must be number[]');
  }
  if (!Array.isArray(st.seenIds) || !Array.isArray(st.archive)) throw new Error('LOOP_STATE archive/seenIds must be arrays');
  return st as unknown as LoopState;
}

/**
 * Rebuild loop state from RECORDED tree facts only (no re-verification):
 * best = highest recorded accepted reward, history in timestamp order,
 * failures/modules from stored reasons. Used when LOOP_STATE.json is absent
 * but trees exist — restart recovery without fabricating evidence.
 */
export function rebuildLoopStateFromTrees(
  goal: GoalVector, workspaceRoot: string, baselineReward: number, trees: DiscoveryTree[],
): LoopState {
  const state = createLoopState(goal, workspaceRoot, baselineReward);
  const nodes: ExperimentRecord[] = trees.flatMap((t) => t.nodes).sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) continue; // idempotent: first fact wins
    seen.add(n.id);
    state.seenIds.push(n.id);
    state.rewardHistory.push(n.reward);
    state.episodeIndex += 1;
    state.spentUsd += Math.max(0, n.costUsd);
    state.recentModules.push(n.module);
    state.recentModules = state.recentModules.slice(-10);
    if (n.status === 'accepted') {
      state.acceptedCount += 1;
      state.consecutiveNonImproving = 0;
      state.consecutiveHardFails = 0;
      if (state.best.id == null || n.reward > state.best.reward) state.best = { reward: n.reward, id: n.id };
      state.archive.push({ id: n.id, metrics: { ...n.metrics } });
    } else {
      state.consecutiveNonImproving += 1;
      if (n.status === 'failed') state.consecutiveHardFails += 1;
      if (n.failureReason) {
        const cls = n.failureReason as LoopState['recentFailures'][number];
        state.recentFailures.push(cls);
        state.recentFailures = state.recentFailures.slice(-10);
      }
    }
  }
  // Frontier stays the true non-dominated set.
  state.archive = state.archive.filter((c) => !state.archive.some((o) => o !== c && dominatesMetrics(o.metrics, c.metrics)));
  return state;
}

function dominatesMetrics(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (!keys.size) return false;
  let better = false;
  for (const k of keys) {
    const av = a[k] ?? -Infinity;
    const bv = b[k] ?? -Infinity;
    if (av < bv) return false;
    if (av > bv) better = true;
  }
  return better;
}

// ---------------------------------------------------------------------------
// Exploration strategy marker — what DREAM selected, on disk.
// ---------------------------------------------------------------------------

export function saveStrategy(fs: RsiFs, rsiDir: string, policyId: string, reason: string): string {
  if (!policyId.trim()) throw new Error('policy id must be non-empty');
  const path = join(rsiDir, RSI_STRATEGY);
  fs.writeFile(path, `# RSI exploration strategy\n\ncurrent: ${policyId}\n\n${reason.trim()}\n`);
  return path;
}

export function loadStrategy(fs: RsiFs, rsiDir: string): string | null {
  const raw = fs.readFile(join(rsiDir, RSI_STRATEGY));
  if (raw == null) return null;
  const m = /^current:\s*(\S+)/m.exec(raw);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Goal-vector freeze check — abort the search if the oracle moved mid-run.
// ---------------------------------------------------------------------------

export function checkGoalFrozen(fs: RsiFs, rsiDir: string, expectedHash: string): { frozen: boolean; actualHash: string | null } {
  const raw = fs.readFile(join(rsiDir, RSI_GOAL_VECTOR));
  if (raw == null) return { frozen: false, actualHash: null };
  const actualHash = hashContent(raw);
  return { frozen: actualHash === expectedHash, actualHash };
}
