// RSI episode orchestrator — the program-owned single-candidate run.
//
// This is the executable link that was missing: instead of the prompt telling
// the model to "remember to snapshot/verify/rollback/record", THIS function
// performs the gates in a fixed order with injected side effects, so every
// step is unit-testable and auditable as code:
//
//   duplicate? → goal frozen? → validate → snapshot → mutate → verify
//   → record → rollback-if-rejected → persist (tree + iteration + state)
//   → slow-register → stop-eval
//
// The model still proposes the candidate and writes the code (via `mutate`);
// the program owns thresholds, rollback, records, and stop. Approval/sandbox
// policy stays with the existing tool executor: `mutate`/`verify` run inside
// it, this module never bypasses it.

import { type ArchiveVerdict, type EpisodeResult } from './rsiReward';
import {
  appendToTree, applyRestore, createLoopState, evaluateStop, planRestore,
  recordEpisodeOutcome, slowRegisterGate, takeSnapshot,
  validateCandidate,
  type CandidateDeclaration, type EpisodeOutcome, type GoalVector, type LoopState, type StopOutcome,
} from './rsiLoop';
import {
  appendEvolutionLog, checkGoalFrozen, loadLoopState, rebuildLoopStateFromTrees, saveLoopState, saveStrategy,
  writeIterationFile,
  type IterationRecord,
} from './rsiPersistence';
import { appendExperiment, createDiscoveryTree, loadAllTrees, loadTree, saveTree, type DiscoveryTree, type RsiFs } from './rsiTree';
import { selectExplorationPolicy, type ExplorationPolicy, type SelectOpts } from './rsiReplay';

export interface EpisodeDeps {
  fs: RsiFs;
  /** e.g. "<workspace>/.conecode/rsi" (absolute). */
  rsiDir: string;
  treesDir: string;
  episodeId: string;
  goal: GoalVector;
  /** Goal-file hash captured when the search started (freeze fingerprint). */
  goalHash: string;
  workspaceRoot: string;
  candidate: CandidateDeclaration;
  parentId: string | null;
  baselineId: string;
  strategyId: string;
  /** Snapshot source / rollback writers over workspace files. */
  readWorkspaceFile(path: string): string | null;
  writeWorkspaceFile(path: string, content: string): void;
  deleteWorkspaceFile(path: string): void;
  /**
   * Optional: file names (not full paths) directly inside a dir. When present,
   * the orchestrator also snapshots parent-dir listings of blastRadius.touch,
   * so files the mutation created WITHOUT declaring are found and removed on
   * rollback (and reported in diagnostics when accepted).
   */
  listDir?(dirPath: string): string[] | null;
  /** Execute the candidate change (runs inside approval/sandbox policy). */
  mutate(): void;
  /** Run the declared external verification cascade. */
  verify(): EpisodeResult;
  retentionPassed?: boolean;
  costUsd: number;
  costSteps?: number;
  diagnostics?: string;
  stopConfig: { budgetCapUsd: number; costLockOn: boolean; maxEpisodes: number };
  userApprovedWin?: boolean;
  now?: number;
}

export interface EpisodeRunResult {
  outcome: EpisodeOutcome;
  state: LoopState;
  tree: DiscoveryTree;
  iterationPath: string | null;
  evolutionAppended: boolean;
  stop: StopOutcome;
  /** Why the run ended before mutation (validation / freeze / duplicate). */
  preempted: string | null;
  rolledBack: { restored: string[]; deleted: string[] } | null;
}

function stopInputFrom(state: LoopState, stopConfig: EpisodeDeps['stopConfig'], extra: { userInterrupted?: boolean; cannotVerify?: boolean } = {}) {
  return {
    rewardHistory: state.rewardHistory,
    acceptedCount: state.acceptedCount,
    consecutiveNonImproving: state.consecutiveNonImproving,
    consecutiveHardFails: state.consecutiveHardFails,
    spentUsd: state.spentUsd,
    budgetCapUsd: stopConfig.budgetCapUsd,
    costLockOn: stopConfig.costLockOn,
    recentFailures: state.recentFailures,
    recentModules: state.recentModules,
    maxEpisodes: stopConfig.maxEpisodes,
    episodesRun: state.episodeIndex,
    ...extra,
  };
}

export function runRsiEpisode(prev: LoopState, deps: EpisodeDeps): EpisodeRunResult {
  const now = deps.now ?? Date.now();
  const stopCfg = deps.stopConfig;

  // 0. Repeat delivery: never mutate or double-register.
  if (prev.seenIds.includes(deps.candidate.id)) {
    const stop = evaluateStop(stopInputFrom(prev, stopCfg));
    return {
      outcome: {
        state: prev, reward: NaN,
        verdict: { action: 'reject', reason: 'not-better-than-best' } as ArchiveVerdict,
        mustRollback: false, status: 'rejected', duplicate: true,
      },
      state: prev,
      tree: loadTree(deps.fs, deps.treesDir, deps.episodeId) ?? createDiscoveryTree(deps.episodeId, deps.strategyId, now),
      iterationPath: null, evolutionAppended: false, stop,
      preempted: 'duplicate-candidate-id', rolledBack: null,
    };
  }

  // 1. Goal-vector freeze: the oracle must not move mid-search.
  const freeze = checkGoalFrozen(deps.fs, deps.rsiDir, deps.goalHash);
  if (freeze.actualHash != null && !freeze.frozen) {
    const stop = evaluateStop(stopInputFrom(prev, stopCfg, { cannotVerify: true }));
    const st: LoopState = { ...prev, stopped: true, stopReasons: [...prev.stopReasons, 'goal-vector-mutated'] };
    saveLoopState(deps.fs, deps.rsiDir, st);
    return {
      outcome: {
        state: st, reward: NaN,
        verdict: { action: 'reject', reason: 'external-fail' } as ArchiveVerdict,
        mustRollback: false, status: 'failed', failureReason: 'goal-vector-mutated', duplicate: false,
      },
      state: st,
      tree: loadTree(deps.fs, deps.treesDir, deps.episodeId) ?? createDiscoveryTree(deps.episodeId, deps.strategyId, now),
      iterationPath: null, evolutionAppended: false, stop,
      preempted: 'goal-vector-mutated', rolledBack: null,
    };
  }

  // 2. Candidate validation: invalid candidates never touch the workspace.
  const errors = validateCandidate(deps.candidate, deps.goal, deps.workspaceRoot);
  if (errors.length > 0) {
    const tree0 = loadTree(deps.fs, deps.treesDir, deps.episodeId) ?? createDiscoveryTree(deps.episodeId, deps.strategyId, now);
    const rec = {
      id: deps.candidate.id, parentId: deps.parentId, baselineId: deps.baselineId,
      candidateId: deps.candidate.id, module: deps.candidate.module, strategyId: deps.strategyId,
      externalPass: false, metrics: {}, reward: -999, costUsd: 0, costSteps: 0,
      budgetUsd: deps.candidate.costBudgetUsd, attempts: 1, status: 'rejected' as const,
      failureReason: 'invalid-declaration', diagnostics: errors.join('; '), timestamp: now,
    };
    const appended = appendExperiment(tree0, rec);
    const tree = appended.tree;
    saveTree(deps.fs, deps.treesDir, tree);
    const irec: IterationRecord = {
      candidate: deps.candidate,
      result: { externalPass: false, metrics: [], judges: { alignment: 0, simplicity: 0, discipline: 0 }, filesTouched: 0, linesChanged: 0 },
      reward: -999, verdict: 'reject', reason: 'invalid-declaration', status: 'rejected',
      costUsd: 0, failureReason: 'invalid-declaration', diagnostics: errors.join('; '),
      parentId: deps.parentId, baselineId: deps.baselineId, strategyId: deps.strategyId, timestamp: now,
    };
    const { path } = writeIterationFile(deps.fs, deps.rsiDir, irec);
    const st: LoopState = {
      ...prev, episodeIndex: prev.episodeIndex + 1, seenIds: [...prev.seenIds, deps.candidate.id],
      consecutiveNonImproving: prev.consecutiveNonImproving + 1,
      recentFailures: [...prev.recentFailures, 'no-improvement' as const].slice(-10),
      recentModules: [...prev.recentModules, deps.candidate.module].slice(-10),
    };
    saveLoopState(deps.fs, deps.rsiDir, st);
    const stop = evaluateStop(stopInputFrom(st, stopCfg));
    return {
      outcome: {
        state: st, reward: -999,
        verdict: { action: 'reject', reason: 'external-fail' } as ArchiveVerdict,
        mustRollback: false, status: 'rejected', failureReason: 'invalid-declaration', duplicate: false,
      },
      state: st, tree, iterationPath: path, evolutionAppended: false, stop,
      preempted: 'invalid-declaration', rolledBack: null,
    };
  }

  // 3. Snapshot the declared blast radius BEFORE mutation.
  const snapFiles: Record<string, string> = {};
  for (const p of deps.candidate.blastRadius.touch) {
    const content = deps.readWorkspaceFile(p);
    if (content != null) snapFiles[p] = content;
  }
  const snapshot = takeSnapshot(deps.candidate.id, snapFiles, now);
  // Parent-dir listings for undeclared-creation detection (best-effort).
  const snapListings = snapshotDirListings(deps);

  // 4. Mutate. A throwing mutator counts as a failed episode, never a pass.
  let mutateError: string | null = null;
  try {
    deps.mutate();
  } catch (e) {
    mutateError = e instanceof Error ? e.message : String(e);
  }

  // 5. Verify. A throwing verifier is infrastructure failure → hard fail.
  let result: EpisodeResult;
  let verifyError: string | null = null;
  if (mutateError != null) {
    result = {
      externalPass: false, metrics: [],
      judges: { alignment: 0, simplicity: 0, discipline: 0 },
      filesTouched: 0, linesChanged: 0,
    };
  } else {
    try {
      result = deps.verify();
    } catch (e) {
      verifyError = e instanceof Error ? e.message : String(e);
      result = {
        externalPass: false, metrics: [],
        judges: { alignment: 0, simplicity: 0, discipline: 0 },
        filesTouched: 0, linesChanged: 0,
      };
    }
  }

  // 6. Program-owned record/select.
  const undeclaredCreated = diffDirListings(deps, snapListings);
  const diagnostics = [
    mutateError ? `mutate threw: ${mutateError}` : null,
    verifyError ? `verify threw: ${verifyError}` : null,
    undeclaredCreated.length ? `undeclared files created mid-mutation: ${undeclaredCreated.join(', ')}` : null,
    deps.diagnostics ?? null,
  ].filter(Boolean).join('\n');
  const outcome = recordEpisodeOutcome(prev, {
    candidate: deps.candidate, result, costUsd: deps.costUsd,
    parentId: deps.parentId, baselineId: deps.baselineId, strategyId: deps.strategyId,
    costSteps: deps.costSteps, diagnostics: diagnostics || undefined,
    retentionPassed: deps.retentionPassed,
  });
  if (mutateError != null) outcome.failureReason = 'mutate-error';
  else if (verifyError != null) outcome.failureReason = 'verify-error';

  // 7. Rollback on any non-accept (restores snapshot, deletes new residue).
  let rolledBack: { restored: string[]; deleted: string[] } | null = null;
  if (outcome.mustRollback) {
    const current: Record<string, string> = {};
    for (const p of Object.keys(snapshot.files)) {
      const c = deps.readWorkspaceFile(p);
      if (c != null) current[p] = c;
    }
    // Include candidate-declared paths that may have been created mid-mutation.
    for (const p of deps.candidate.blastRadius.touch) {
      if (!(p in current)) {
        const c = deps.readWorkspaceFile(p);
        if (c != null) current[p] = c;
      }
    }
    rolledBack = applyRestore(
      planRestore(snapshot, current),
      (p, c) => deps.writeWorkspaceFile(p, c),
      (p) => deps.deleteWorkspaceFile(p),
    );
    for (const f of undeclaredCreated) {
      if (!rolledBack.deleted.includes(f)) {
        deps.deleteWorkspaceFile(f);
        rolledBack.deleted.push(f);
      }
    }
    rolledBack.deleted.sort();
  }

  // 8. Persist: tree + iteration file + loop state.
  let tree = loadTree(deps.fs, deps.treesDir, deps.episodeId)
    ?? createDiscoveryTree(deps.episodeId, deps.strategyId, now);
  tree = appendToTree(tree, {
    candidate: deps.candidate, result, costUsd: deps.costUsd,
    parentId: deps.parentId, baselineId: deps.baselineId, strategyId: deps.strategyId,
    costSteps: deps.costSteps, diagnostics: diagnostics || undefined,
    retentionPassed: deps.retentionPassed,
  }, outcome);
  // appendToTree is dup-safe; on duplicate ids the tree is unchanged.
  saveTree(deps.fs, deps.treesDir, tree);
  const irec: IterationRecord = {
    candidate: deps.candidate, result, reward: outcome.reward,
    verdict: outcome.verdict.action, reason: outcome.verdict.reason, status: outcome.status,
    costUsd: deps.costUsd, failureReason: outcome.failureReason,
    diagnostics: diagnostics || undefined,
    parentId: deps.parentId, baselineId: deps.baselineId, strategyId: deps.strategyId, timestamp: now,
  };
  const { path: iterationPath } = writeIterationFile(deps.fs, deps.rsiDir, irec);

  // 9. Slow registration: accepted wins enter the evolution log only when earned.
  let evolutionAppended = false;
  if (outcome.verdict.action === 'replace-best' && slowRegisterGate({
    acceptedCount: outcome.state.acceptedCount, userApproved: deps.userApprovedWin,
  })) {
    appendEvolutionLog(deps.fs, deps.rsiDir, {
      id: deps.candidate.id, module: deps.candidate.module, reward: outcome.reward,
      summary: `${deps.candidate.hypothesis} (strategy ${deps.strategyId}, parent ${deps.parentId ?? 'none'})`,
      timestamp: now,
    });
    evolutionAppended = true;
  }

  // 10. Stop evaluation.
  const stop = evaluateStop(stopInputFrom(outcome.state, stopCfg));
  const state: LoopState = stop.shouldStop
    ? { ...outcome.state, stopped: true, stopReasons: [...outcome.state.stopReasons, ...stop.reasons] }
    : outcome.state;
  saveLoopState(deps.fs, deps.rsiDir, state);

  return { outcome: { ...outcome, state }, state, tree, iterationPath, evolutionAppended, stop, preempted: null, rolledBack };
}

/** Re-entry after a crash: load persisted state, or rebuild from trees. */
export function recoverLoopState(
  fs: RsiFs, rsiDir: string, treesDir: string,
  goal: GoalVector, workspaceRoot: string, baselineReward: number,
): { state: LoopState; rebuilt: boolean } {
  try {
    const saved = loadLoopState(fs, rsiDir);
    if (saved) return { state: saved, rebuilt: false };
  } catch {
    // Corrupt state file: fall through to tree rebuild (never crash recovery).
  }
  const { trees } = loadAllTrees(fs, treesDir);
  return { state: rebuildLoopStateFromTrees(goal, workspaceRoot, baselineReward, trees), rebuilt: true };
}

// ---------------------------------------------------------------------------
// DREAM step — run offline over persisted trees, persist the chosen policy.
// ---------------------------------------------------------------------------

export interface DreamDeps {
  fs: RsiFs;
  rsiDir: string;
  treesDir: string;
  incumbent: ExplorationPolicy;
  challengers: ExplorationPolicy[];
  opts?: SelectOpts;
}

export function runDreamStep(deps: DreamDeps): {
  policy: ExplorationPolicy; reason: string; evidenceSufficient: boolean; persisted: boolean; treeCount: number;
} {
  const { trees } = loadAllTrees(deps.fs, deps.treesDir);
  const sel = selectExplorationPolicy(deps.challengers, deps.incumbent, trees, deps.opts);
  let persisted = false;
  if (sel.evidenceSufficient && sel.policy.id !== deps.incumbent.id) {
    saveStrategy(deps.fs, deps.rsiDir, sel.policy.id, sel.reason);
    persisted = true;
  }
  return { policy: sel.policy, reason: sel.reason, evidenceSufficient: sel.evidenceSufficient, persisted, treeCount: trees.length };
}

/** Fresh search bootstrap (episode 0): default policy, empty state. */
export function bootstrapSearch(goal: GoalVector, workspaceRoot: string, baselineReward = 0): LoopState {
  return createLoopState(goal, workspaceRoot, baselineReward);
}

// ---------------------------------------------------------------------------
// Undeclared-creation detection — closes the "mutate touched files outside
// blastRadius.touch" gap. Lexical parent dirs of declared paths are listed
// before/after; newcomers are removed on rollback and named in diagnostics.
// exec/rename side effects remain unrestorable (same as undoEffect) and are
// reported, not silently absorbed.
// ---------------------------------------------------------------------------

function parentDirOf(p: string): string {
  const q = p.replace(/\\/g, '/');
  const cut = q.lastIndexOf('/');
  return cut <= 0 ? '/' : q.slice(0, cut);
}

function snapshotDirListings(deps: EpisodeDeps): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!deps.listDir) return out;
  for (const p of deps.candidate.blastRadius.touch) {
    const d = parentDirOf(p);
    if (d in out) continue;
    try {
      const list = deps.listDir(d);
      if (list) out[d] = [...list].sort();
    } catch {
      // Best-effort: a failed listing only narrows detection, never blocks.
    }
  }
  return out;
}

function diffDirListings(deps: EpisodeDeps, before: Record<string, string[]>): string[] {
  const out: string[] = [];
  if (!deps.listDir) return out;
  for (const [dir, names] of Object.entries(before)) {
    let after: string[] | null = null;
    try {
      after = deps.listDir(dir);
    } catch {
      continue;
    }
    if (!after) continue;
    const known = new Set(names);
    for (const n of after) {
      const full = `${dir === '/' ? '' : dir}/${n}`;
      if (!known.has(n) && !out.includes(full)) out.push(full);
    }
  }
  return out.sort();
}
