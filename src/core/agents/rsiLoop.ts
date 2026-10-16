// RSI executable loop — program-controlled gates, not prompt prose.
//
// The model proposes candidates and reasons about them; THIS module owns the
// thresholds that decide accept / reject / rollback / stop. Every gate is a
// pure, unit-tested function so the closed loop is auditable as code:
//
//   candidate validation (frozen goal, workspace, eval region, budgets)
//   -> VERIFY result + computeReward / selectForArchive (rsiReward)
//   -> rollback decision (reject => restore snapshot)
//   -> archive + history + discovery-tree append (rsiTree)
//   -> stop evaluation (budget-limited local convergence, never "global optimum")
//   -> slow registration gate (single wins never become permanent lore)
//
// Snapshots and FS writes are injected: tests use memory, prod wires node:fs.

import {
  REWARD_FAIL,
  computeReward,
  selectForArchive,
  type ArchiveVerdict,
  type EpisodeResult,
  type ParetoCandidate,
} from './rsiReward';
import { appendExperiment, type DiscoveryTree, type ExperimentStatus, type RsiModule } from './rsiTree';

// ---------------------------------------------------------------------------
// Phases — strict order, program-owned.
// ---------------------------------------------------------------------------

export type RsiPhase = 'ASSESS' | 'DISCOVER' | 'SAMPLE' | 'DECLARE' | 'EXECUTE' | 'VERIFY' | 'SCORE' | 'DREAM' | 'STOP';

export const RSI_PHASE_ORDER: RsiPhase[] = [
  'ASSESS', 'DISCOVER', 'SAMPLE', 'DECLARE', 'EXECUTE', 'VERIFY', 'SCORE', 'DREAM', 'STOP',
];

export function nextPhase(phase: RsiPhase): RsiPhase | null {
  if (phase === 'STOP') return null;
  if (phase === 'DREAM') return 'ASSESS';
  const i = RSI_PHASE_ORDER.indexOf(phase);
  return i < 0 ? null : (RSI_PHASE_ORDER[i + 1] ?? null);
}

// ---------------------------------------------------------------------------
// Goal vector (frozen) + candidate declaration validation.
// ---------------------------------------------------------------------------

export interface FrozenMetric {
  id: string;
  command: string;
  direction: 'higher' | 'lower';
  baseline: number;
}

export interface GoalVector {
  charter: string;
  metrics: FrozenMetric[];
  frozenAt: string;
  nonGoals: string[];
}

export interface CandidateDeclaration {
  id: string;
  module: RsiModule;
  hypothesis: string;
  successCriteria: { metric: string; threshold: string; external: boolean }[];
  blastRadius: { touch: string[]; doNotTouch: string[] };
  editBudget: { maxFiles: number; maxLines: number };
  costBudgetUsd: number;
}

/** Paths the candidate may never touch to "pass" (EVOLVE-BLOCK). */
export const RSI_FROZEN_PATHS = ['.conecode/rsi/GOAL_VECTOR.md'];

function insideWorkspace(p: string, root: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/');
  const r = norm(root).replace(/\/+$/, '');
  const q = norm(p);
  if (q.includes('..')) {
    // Resolve lexically: any .. that escapes root is forbidden.
    const parts: string[] = [];
    for (const seg of q.split('/')) {
      if (seg === '..') {
        if (!parts.length) return false;
        parts.pop();
      } else if (seg !== '.' && seg !== '') parts.push(seg);
    }
    return parts.join('/').startsWith(r.replace(/^\//, '')) || `/${parts.join('/')}`.startsWith(r);
  }
  if (q.startsWith('/')) return q === r || q.startsWith(`${r}/`);
  return true; // relative paths resolve inside the workspace root
}

/**
 * Validate a candidate BEFORE any mutation. Returns error strings (empty =
 * valid). Enforces: external criteria, workspace containment, frozen eval
 * region untouched, sane budgets.
 */
export function validateCandidate(
  cand: CandidateDeclaration,
  goal: GoalVector,
  workspaceRoot: string,
): string[] {
  const errors: string[] = [];
  if (!cand.id.trim()) errors.push('id must be non-empty');
  if (!cand.hypothesis.trim()) errors.push('hypothesis must be non-empty');
  if (!cand.successCriteria.length) errors.push('at least one success criterion required');
  for (const c of cand.successCriteria) {
    if (!c.external) errors.push(`success criterion "${c.metric}" must set external:true`);
    if (!c.metric.trim()) errors.push('success criterion metric must be non-empty');
  }
  if (goal.metrics.length < 1) errors.push('goal vector must freeze at least one metric');
  if (!cand.blastRadius.touch.length) errors.push('blastRadius.touch must list at least one path');
  for (const p of cand.blastRadius.touch) {
    if (!insideWorkspace(p, workspaceRoot)) errors.push(`touch path escapes workspace: ${p}`);
    for (const frozen of RSI_FROZEN_PATHS) {
      if (p.replace(/\\/g, '/').endsWith(frozen)) errors.push(`touch path enters frozen eval region: ${p}`);
    }
  }
  if (!(cand.editBudget.maxFiles >= 1)) errors.push('editBudget.maxFiles must be >= 1');
  if (!(cand.editBudget.maxLines >= 1)) errors.push('editBudget.maxLines must be >= 1');
  if (!(cand.costBudgetUsd >= 0)) errors.push('costBudgetUsd must be >= 0');
  return errors;
}

// ---------------------------------------------------------------------------
// Failure classification + repetition detection.
// ---------------------------------------------------------------------------

export type FailureClass =
  | 'external-fail'
  | 'discipline-veto'
  | 'hard-floor-breach'
  | 'no-improvement'
  | 'dominated'
  | 'budget-exceeded';

export function classifyFailure(reason: ArchiveVerdict['reason'], costExceeded: boolean): FailureClass {
  if (costExceeded) return 'budget-exceeded';
  switch (reason) {
    case 'external-fail': return 'external-fail';
    case 'discipline-veto': return 'discipline-veto';
    case 'hard-floor-breach': return 'hard-floor-breach';
    case 'not-better-than-best':
    case 'not-better-than-baseline': return 'no-improvement';
    default: return 'dominated';
  }
}

/** True when the same failure class repeats back-to-back (thrashing signal). */
export function hasRepeatedFailure(recent: FailureClass[], streak = 3): boolean {
  if (recent.length < streak) return false;
  const tail = recent.slice(-streak);
  return tail.every((c) => c === tail[0]);
}

/** True when recent attempts pile onto one module (narrow search signal). */
export function isModuleConcentrated(recentModules: RsiModule[], window = 4, threshold = 0.75): boolean {
  if (recentModules.length < window) return false;
  const tail = recentModules.slice(-window);
  const counts = new Map<string, number>();
  for (const m of tail) counts.set(m, (counts.get(m) ?? 0) + 1);
  return Math.max(...counts.values()) / tail.length >= threshold;
}

// ---------------------------------------------------------------------------
// Loop state — what survives across episodes and restarts.
// ---------------------------------------------------------------------------

export interface LoopState {
  goal: GoalVector;
  workspaceRoot: string;
  episodeIndex: number;
  best: { reward: number; id: string | null };
  baselineReward: number;
  rewardHistory: number[];
  consecutiveNonImproving: number;
  consecutiveHardFails: number;
  acceptedCount: number;
  spentUsd: number;
  archive: ParetoCandidate[];
  seenIds: string[];
  recentFailures: FailureClass[];
  recentModules: RsiModule[];
  stopped: boolean;
  stopReasons: string[];
}

export function createLoopState(goal: GoalVector, workspaceRoot: string, baselineReward = 0): LoopState {
  return {
    goal, workspaceRoot, episodeIndex: 0,
    best: { reward: baselineReward, id: null },
    baselineReward, rewardHistory: [],
    consecutiveNonImproving: 0, consecutiveHardFails: 0, acceptedCount: 0,
    spentUsd: 0, archive: [], seenIds: [],
    recentFailures: [], recentModules: [],
    stopped: false, stopReasons: [],
  };
}

export interface EpisodeInput {
  candidate: CandidateDeclaration;
  result: EpisodeResult;
  costUsd: number;
  parentId: string | null;
  baselineId: string;
  strategyId: string;
  costSteps?: number;
  diagnostics?: string;
  /** Retention re-run of prior wins passed (anti-forgetting gate). */
  retentionPassed?: boolean;
}

export interface EpisodeOutcome {
  state: LoopState;
  reward: number;
  verdict: ArchiveVerdict;
  /** Reject => caller MUST restore the pre-candidate snapshot. */
  mustRollback: boolean;
  status: ExperimentStatus;
  failureReason?: string;
  /** Repeat delivery of an already-seen id: no state change. */
  duplicate: boolean;
}

/**
 * Record one verified episode: reward -> verdict -> archive/history update.
 * Idempotent on candidate.id: repeats return duplicate:true unchanged.
 */
export function recordEpisodeOutcome(prev: LoopState, input: EpisodeInput, epsilon = 1e-3): EpisodeOutcome {
  if (prev.seenIds.includes(input.candidate.id)) {
    return {
      state: prev, reward: NaN, verdict: { action: 'reject', reason: 'not-better-than-best' },
      mustRollback: false, status: 'rejected', duplicate: true,
    };
  }
  const costExceeded = input.costUsd > input.candidate.costBudgetUsd * 2;
  // Cost blowout without a matching win is churn: force a veto-shaped reject.
  const gated: EpisodeResult = costExceeded && input.result.externalPass
    ? { ...input.result, judges: { ...input.result.judges, discipline: 0 } }
    : input.result;
  // Retention regression is a hard reject (no silent forgetting).
  const effective: EpisodeResult = input.retentionPassed === false
    ? { ...gated, externalPass: false }
    : gated;
  const reward = computeReward(effective);
  const bestForSelect = prev.best.id == null ? null : { reward: prev.best.reward };
  const verdict = selectForArchive(
    effective, input.candidate.id,
    bestForSelect, { reward: prev.baselineReward },
    prev.archive, epsilon,
  );
  const accepted = verdict.action === 'replace-best';
  const hardFail = reward === REWARD_FAIL;
  const failureReason = accepted ? undefined : (costExceeded ? 'budget-exceeded' : verdict.reason);
  const failureClass: FailureClass | null = accepted
    ? null
    : classifyFailure(verdict.reason === 'not-better-than-best' || verdict.reason === 'not-better-than-baseline'
        ? verdict.reason : verdict.reason, costExceeded);
  const status: ExperimentStatus = accepted ? 'accepted' : hardFail ? 'failed' : 'rolled-back';
  const metrics: Record<string, number> = {};
  for (const m of effective.metrics) {
    const scale = m.scale ?? 1;
    metrics[m.id] = m.delta / Math.max(scale, 1e-9);
  }
  const nextArchive = [...prev.archive];
  if (verdict.action === 'retain-frontier' && !nextArchive.some((a) => a.id === input.candidate.id)) {
    nextArchive.push({ id: input.candidate.id, metrics });
  }
  // Prune newly-dominated archive members so the frontier stays honest.
  const pruned = pruneArchive(nextArchive);
  const state: LoopState = {
    ...prev,
    episodeIndex: prev.episodeIndex + 1,
    best: accepted ? { reward, id: input.candidate.id } : prev.best,
    rewardHistory: [...prev.rewardHistory, reward],
    consecutiveNonImproving: accepted ? 0 : prev.consecutiveNonImproving + 1,
    consecutiveHardFails: hardFail ? prev.consecutiveHardFails + 1 : 0,
    acceptedCount: accepted ? prev.acceptedCount + 1 : prev.acceptedCount,
    spentUsd: prev.spentUsd + Math.max(0, input.costUsd),
    archive: pruned,
    seenIds: [...prev.seenIds, input.candidate.id],
    recentFailures: failureClass ? [...prev.recentFailures, failureClass].slice(-10) : prev.recentFailures,
    recentModules: [...prev.recentModules, input.candidate.module].slice(-10),
  };
  return { state, reward, verdict, mustRollback: !accepted, status, failureReason, duplicate: false };
}

/** Drop archive members dominated by another member (stable, keeps ties). */
export function pruneArchive(archive: ParetoCandidate[]): ParetoCandidate[] {
  return archive.filter((c) => !archive.some((o) => o !== c && dominatesArch(o, c)));
}

function dominatesArch(a: ParetoCandidate, b: ParetoCandidate): boolean {
  const keys = new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)]);
  if (!keys.size) return false;
  let better = false;
  for (const k of keys) {
    const av = a.metrics[k] ?? -Infinity;
    const bv = b.metrics[k] ?? -Infinity;
    if (av < bv) return false;
    if (av > bv) better = true;
  }
  return better;
}

/** Build the discovery-tree record for this episode (for rsiTree.appendExperiment). */
export function toExperimentRecord(
  input: EpisodeInput, outcome: EpisodeOutcome, timestamp = Date.now(),
): import('./rsiTree').ExperimentRecord {
  const metrics: Record<string, number> = {};
  for (const m of input.result.metrics) {
    metrics[m.id] = m.delta / Math.max(m.scale ?? 1, 1e-9);
  }
  return {
    id: input.candidate.id,
    parentId: input.parentId,
    baselineId: input.baselineId,
    candidateId: input.candidate.id,
    module: input.candidate.module,
    strategyId: input.strategyId,
    externalPass: input.result.externalPass,
    metrics,
    reward: outcome.reward,
    costUsd: Math.max(0, input.costUsd),
    costSteps: input.costSteps ?? 0,
    budgetUsd: input.candidate.costBudgetUsd,
    attempts: 1,
    status: outcome.status,
    failureReason: outcome.failureReason,
    diagnostics: input.diagnostics,
    timestamp,
  };
}

/** Append the episode to the discovery tree (thin wrapper; dup-safe). */
export function appendToTree(tree: DiscoveryTree, input: EpisodeInput, outcome: EpisodeOutcome): DiscoveryTree {
  return appendExperiment(tree, toExperimentRecord(input, outcome)).tree;
}

// ---------------------------------------------------------------------------
// Stop evaluation — budget-limited, evidence-aware, never "global optimum".
// ---------------------------------------------------------------------------

export interface StopInput {
  rewardHistory: number[];
  acceptedCount: number;
  consecutiveNonImproving: number;
  consecutiveHardFails: number;
  spentUsd: number;
  budgetCapUsd: number;
  costLockOn: boolean;
  recentFailures: FailureClass[];
  recentModules: RsiModule[];
  maxEpisodes: number;
  episodesRun: number;
  userInterrupted?: boolean;
  cannotVerify?: boolean;
}

export interface StopOutcome {
  shouldStop: boolean;
  reasons: string[];
  /** Plateau within budget — explicitly NOT a global-optimality proof. */
  isLocalPlateau: boolean;
  report: string;
}

const PLATEAU_WINDOW = 3;

export function evaluateStop(input: StopInput, epsilon = 1e-3): StopOutcome {
  const reasons: string[] = [];
  if (input.userInterrupted) reasons.push('user-interrupt');
  if (input.cannotVerify) reasons.push('unverifiable-oracle');
  if (input.consecutiveHardFails >= 2) reasons.push('two-consecutive-hard-fails');
  if (input.episodesRun >= input.maxEpisodes) reasons.push('episode-budget-exhausted');
  if (input.costLockOn && input.spentUsd > input.budgetCapUsd * 2) reasons.push('cost-lock-tripped');
  if (input.spentUsd > input.budgetCapUsd * 4) reasons.push('spend-cap-exceeded');
  if (hasRepeatedFailure(input.recentFailures, 3)) {
    reasons.push(`repeated-failure:${input.recentFailures.slice(-3).join(',')}`);
  }
  // Local convergence ONLY counts with evidence: >=1 accepted win, a full
  // window of non-improving tries, and no unexplored breadth signal forcing
  // continuation. It reports "no better candidate within budget".
  let isLocalPlateau = false;
  if (input.acceptedCount >= 1 && input.consecutiveNonImproving >= PLATEAU_WINDOW) {
    const hist = input.rewardHistory.filter((r) => r !== REWARD_FAIL);
    if (hist.length >= PLATEAU_WINDOW + 1) {
      const tail = hist.slice(-PLATEAU_WINDOW);
      const priorBest = Math.max(...hist.slice(0, -PLATEAU_WINDOW));
      const tailBest = Math.max(...tail);
      if (tailBest <= priorBest + epsilon) {
        isLocalPlateau = true;
        const narrow = isModuleConcentrated(input.recentModules);
        reasons.push(narrow ? 'local-plateau-narrow-search' : 'local-plateau');
      }
    } else if (input.consecutiveNonImproving >= PLATEAU_WINDOW) {
      // No accepted history to compare against beyond the window: still stop
      // rather than churn, but label it plainly.
      isLocalPlateau = true;
      reasons.push('local-plateau');
    }
  }
  const shouldStop = reasons.length > 0;
  const report = shouldStop
    ? `STOP [${reasons.join(' | ')}]: no better candidate found within the current budget. ` +
      `This is budget-limited local convergence, NOT a proof of global optimality. ` +
      `Episodes=${input.episodesRun} accepted=${input.acceptedCount} spent=$${input.spentUsd.toFixed(2)}.`
    : `CONTINUE: episodes=${input.episodesRun} accepted=${input.acceptedCount} ` +
      `nonImprovingStreak=${input.consecutiveNonImproving} hardFails=${input.consecutiveHardFails}.`;
  return { shouldStop, reasons, isLocalPlateau, report };
}

// ---------------------------------------------------------------------------
// Slow registration — single wins never become permanent lore.
// ---------------------------------------------------------------------------

/**
 * A lesson/skill may persist only after EARNED evidence: at least two
 * accepted episodes (independent wins) or one accepted win plus an explicit
 * user approval. One failure — or one unverified guess — never registers.
 */
export function slowRegisterGate(args: { acceptedCount: number; userApproved?: boolean }): boolean {
  if (args.userApproved) return args.acceptedCount >= 1;
  return args.acceptedCount >= 2;
}

// ---------------------------------------------------------------------------
// Workspace snapshot — auditable diff + reliable rollback.
// ---------------------------------------------------------------------------

export interface SnapshotHandle {
  id: string;
  files: Record<string, string>;
  takenAt: number;
}

export function takeSnapshot(id: string, files: Record<string, string>, takenAt = Date.now()): SnapshotHandle {
  return { id, files: { ...files }, takenAt };
}

export interface RestorePlan {
  /** Files to (over)write with snapshot contents. */
  overwrite: Record<string, string>;
  /** Files created after the snapshot — must be deleted to avoid residue. */
  delete: string[];
}

/** Diff current files against the snapshot: what rollback must do. */
export function planRestore(snapshot: SnapshotHandle, current: Record<string, string>): RestorePlan {
  const overwrite: Record<string, string> = {};
  const del: string[] = [];
  for (const [path, content] of Object.entries(snapshot.files)) {
    if (current[path] !== content) overwrite[path] = content;
  }
  for (const path of Object.keys(current)) {
    if (!(path in snapshot.files)) del.push(path);
  }
  del.sort();
  return { overwrite, delete: del };
}

/** Apply a restore plan via injected writers. Returns restored + deleted lists. */
export function applyRestore(
  plan: RestorePlan,
  writeFile: (path: string, content: string) => void,
  deleteFile: (path: string) => void,
): { restored: string[]; deleted: string[] } {
  const restored = Object.keys(plan.overwrite).sort();
  for (const p of restored) writeFile(p, plan.overwrite[p]);
  const deleted = [...plan.delete].sort();
  for (const p of deleted) deleteFile(p);
  return { restored, deleted };
}
