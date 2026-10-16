// RSI renderer bridge — production wiring for the program-owned loop.
//
// The sync core (rsiLoop/rsiTree/rsiReplay/rsiVerify/rsiPersistence) stays
// pure and unit-tested. THIS module is the thin async shell that connects it
// to the real Electron runtime, reusing the exact primitives the agent's own
// tool executor uses:
//
//   exec      → window.electronAPI.exec.run (same IPC + sandbox params as
//               codeChanges.store applyEffect, chat.store.ts:2580 path)
//   fs        → window.electronAPI.fs.* (same primitives as undoEffect/
//               revertChange, which likewise bypass the approval loop —
//               rollback must not ask permission to undo)
//   settings  → settings.store sandbox mode (no import cycle: settings.store
//               depends only on zustand)
//
// Nothing here invents a parallel execution path: verification runs the same
// commands through the same sandbox the agent loop uses.

import {
  recordEpisodeOutcome, evaluateStop, slowRegisterGate, planRestore,
  validateCandidate,
  type CandidateDeclaration, type EpisodeOutcome, type GoalVector, type LoopState,
  type SnapshotHandle, type StopOutcome,
} from './rsiLoop';
import {
  appendEvolutionLog, hashContent, loadBaseline,
} from './rsiPersistence';
import { appendExperiment, createDiscoveryTree, parseTree, serializeTree, type RsiFs } from './rsiTree';
import {
  buildMetricDeltas, runVerifyCascade,
  type CascadeStage, type CommandRunner, type MetricBinding,
} from './rsiVerify';
import type { EpisodeResult, JudgeScores } from './rsiReward';

// ---------------------------------------------------------------------------
// Async FS over the Electron IPC bridge (renderer-safe: no node:fs).
// ---------------------------------------------------------------------------

export interface AsyncRsiFs {
  readFile(path: string): Promise<string | null>;
  /** Must ensure parent dirs (fs:writeFile does NOT mkdir — main.ts:933). */
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Full paths of FILES directly inside dir (dirs excluded). */
  listFiles(dir: string): Promise<string[] | null>;
  deleteFile(path: string): Promise<void>;
}

interface ElectronFsApi {
  readFile(p: string): Promise<string | null>;
  writeFile(p: string, c: string): Promise<boolean>;
  createDir(p: string): Promise<boolean>;
  readDir(p: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }> | null>;
  deleteFile(p: string): Promise<boolean>;
}

function electronFsApi(): ElectronFsApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { electronAPI?: { fs?: ElectronFsApi } }).electronAPI?.fs;
  return api && typeof api.readFile === 'function' ? api : null;
}

/** Null when the bridge is absent (tests, non-Electron contexts). */
export function electronAsyncFs(): AsyncRsiFs | null {
  const api = electronFsApi();
  if (!api) return null;
  const parentDir = (p: string): string => {
    const q = p.replace(/\\/g, '/');
    const cut = q.lastIndexOf('/');
    return cut <= 0 ? '/' : q.slice(0, cut);
  };
  return {
    readFile: async (p) => {
      try {
        const c = await api.readFile(p);
        return typeof c === 'string' ? c : null;
      } catch {
        return null;
      }
    },
    writeFile: async (p, c) => {
      await api.createDir(parentDir(p));
      const ok = await api.writeFile(p, c);
      if (!ok) throw new Error(`writeFile failed: ${p}`);
    },
    mkdir: async (p) => {
      await api.createDir(p);
    },
    listFiles: async (dir) => {
      try {
        const entries = await api.readDir(dir);
        if (!Array.isArray(entries)) return null;
        return entries.filter((e) => e && !e.isDirectory && typeof e.path === 'string').map((e) => e.path);
      } catch {
        return null;
      }
    },
    deleteFile: async (p) => {
      try {
        await api.deleteFile(p);
      } catch {
        // Best-effort rollback: failures are collected by the caller.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Exec runner over the same IPC the agent loop uses.
// ---------------------------------------------------------------------------

/** Null when the bridge is absent. Sandbox params mirror codeChanges.store. */
export function electronExecRunner(): CommandRunner | null {
  if (typeof window === 'undefined') return null;
  const exec = (window as unknown as { electronAPI?: { exec?: { run(c: string, cwd?: string, s?: unknown): Promise<{ stdout?: string; stderr?: string; exitCode?: number } | null> } } }).electronAPI?.exec;
  if (!exec || typeof exec.run !== 'function') return null;
  return async (command, cwd) => {
    // settings.store is zustand-only: no import cycle with the agent loop.
    const { useSettingsStore } = await import('../../stores/settings.store');
    const st = useSettingsStore.getState();
    const res = await exec.run(command, cwd, { mode: st.sandboxMode, allowNetwork: st.sandboxAllowNetwork });
    return {
      stdout: typeof res?.stdout === 'string' ? res.stdout : '',
      stderr: typeof res?.stderr === 'string' ? res.stderr : '',
      exitCode: typeof res?.exitCode === 'number' ? res.exitCode : 1,
    };
  };
}

// ---------------------------------------------------------------------------
// Workspace snapshot / rollback over the async bridge.
// ---------------------------------------------------------------------------

export interface WorkspaceSnapshot extends SnapshotHandle {
  /** dir → files present when snapshotted (undeclared-creation detection). */
  scanned: Record<string, string[]>;
}

function parentDirOf(p: string): string {
  const q = p.replace(/\\/g, '/');
  const cut = q.lastIndexOf('/');
  return cut <= 0 ? '/' : q.slice(0, cut);
}

/** Snapshot declared touch contents + parent-dir listings. */
export async function snapshotWorkspace(fs: AsyncRsiFs, touchPaths: string[]): Promise<WorkspaceSnapshot> {
  const files: Record<string, string> = {};
  for (const p of touchPaths) {
    const c = await fs.readFile(p);
    if (c != null) files[p] = c;
  }
  const scanned: Record<string, string[]> = {};
  const dirs = [...new Set(touchPaths.map(parentDirOf))];
  for (const d of dirs) {
    const list = await fs.listFiles(d);
    if (list) scanned[d] = [...list].sort();
  }
  return { id: touchPaths.join(','), files, takenAt: Date.now(), scanned };
}

export interface RollbackReport {
  restored: string[];
  deleted: string[];
  /** Undeclared files the mutation created (removed on rollback, kept on accept). */
  undeclaredCreated: string[];
  errors: string[];
}

/**
 * Roll back to a snapshot: restore declared contents, delete created files —
 * including UNDECLARED creations found by re-scanning listed dirs. Delete
 * failures are reported, never thrown (mirrors revertToMessage's retained
 * accounting: partial rollback must be visible, not silent).
 */
export async function rollbackWorkspace(
  fs: AsyncRsiFs,
  snapshot: SnapshotHandle & { scanned?: Record<string, string[]> },
  readCurrent: (path: string) => Promise<string | null>,
): Promise<RollbackReport> {
  const errors: string[] = [];
  const current: Record<string, string> = {};
  for (const p of Object.keys(snapshot.files)) {
    const c = await readCurrent(p);
    if (c != null) current[p] = c;
  }
  const plan = planRestore(snapshot, current);
  // Pure plan, async execution: every op awaited, failures collected.
  const restored: string[] = [];
  const deleted: string[] = [];
  for (const [p, c] of Object.entries(plan.overwrite)) {
    try {
      await fs.writeFile(p, c);
      restored.push(p);
    } catch (e) {
      errors.push(`restore ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  restored.sort();
  for (const p of plan.delete) {
    try {
      await fs.deleteFile(p);
      deleted.push(p);
    } catch (e) {
      errors.push(`delete ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  deleted.sort();
  // Undeclared creations: present in re-scanned dirs but absent before.
  const undeclaredCreated: string[] = [];
  const scanned = (snapshot as { scanned?: Record<string, string[]> }).scanned ?? {};
  for (const [dir, before] of Object.entries(scanned)) {
    const after = await fs.listFiles(dir);
    if (!after) continue;
    const known = new Set([...before, ...Object.keys(snapshot.files)]);
    for (const f of after) {
      if (!known.has(f) && !undeclaredCreated.includes(f)) undeclaredCreated.push(f);
    }
  }
  undeclaredCreated.sort();
  const extraDeleted: string[] = [];
  for (const f of undeclaredCreated) {
    try {
      await fs.deleteFile(f);
      extraDeleted.push(f);
    } catch (e) {
      errors.push(`delete undeclared ${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { restored, deleted: [...deleted, ...extraDeleted].sort(), undeclaredCreated, errors };
}

// ---------------------------------------------------------------------------
// Verify-and-adjudicate: the program-owned post-mutation gate.
//
// In the renderer the model edits through the chat loop (approval/sandbox
// enforced there); THIS function owns what happens after: re-run the declared
// verification cascade on the same exec bridge, score, accept/reject, roll
// back on reject, and persist every fact. It never invents results.
// ---------------------------------------------------------------------------

export interface AdjudicateDeps {
  afs: AsyncRsiFs;
  rsiDir: string;
  treesDir: string;
  episodeId: string;
  goal: GoalVector;
  goalHash: string;
  workspaceRoot: string;
  candidate: CandidateDeclaration;
  parentId: string | null;
  baselineId: string;
  strategyId: string;
  /** Taken at DECLARE time, before the chat loop performed the mutation. */
  snapshot: WorkspaceSnapshot;
  runner: CommandRunner;
  /** Usually one stage per frozen-metric command, cheapest first. */
  stages: CascadeStage[];
  bindings: MetricBinding[];
  baseline: Record<string, number>;
  judges: JudgeScores;
  filesTouched: number;
  linesChanged: number;
  costUsd: number;
  costSteps?: number;
  retentionPassed?: boolean;
  diagnostics?: string;
  stopConfig: { budgetCapUsd: number; costLockOn: boolean; maxEpisodes: number };
  userApprovedWin?: boolean;
  now?: number;
}

export interface AdjudicateResult {
  outcome: EpisodeOutcome;
  state: LoopState;
  iterationPath: string | null;
  evolutionAppended: boolean;
  stop: StopOutcome;
  preempted: string | null;
  rollback: RollbackReport | null;
  cascadeStages: number;
  missingMetrics: string[];
}

export async function verifyAndAdjudicate(prev: LoopState, deps: AdjudicateDeps): Promise<AdjudicateResult> {
  const now = deps.now ?? Date.now();
  const stopInput = (s: LoopState) => ({
    rewardHistory: s.rewardHistory,
    acceptedCount: s.acceptedCount,
    consecutiveNonImproving: s.consecutiveNonImproving,
    consecutiveHardFails: s.consecutiveHardFails,
    spentUsd: s.spentUsd,
    budgetCapUsd: deps.stopConfig.budgetCapUsd,
    costLockOn: deps.stopConfig.costLockOn,
    recentFailures: s.recentFailures,
    recentModules: s.recentModules,
    maxEpisodes: deps.stopConfig.maxEpisodes,
    episodesRun: s.episodeIndex,
  });
  const emptyStop = (s: LoopState) => evaluateStop(stopInput(s));

  // 0. Duplicate delivery: no work, no double-register.
  if (prev.seenIds.includes(deps.candidate.id)) {
    return {
      outcome: {
        state: prev, reward: NaN,
        verdict: { action: 'reject', reason: 'not-better-than-best' },
        mustRollback: false, status: 'rejected', duplicate: true,
      },
      state: prev, iterationPath: null, evolutionAppended: false,
      stop: emptyStop(prev), preempted: 'duplicate-candidate-id',
      rollback: null, cascadeStages: 0, missingMetrics: [],
    };
  }

  // 1. Goal freeze + candidate validation — before spending verification budget.
  const rawGoal = await deps.afs.readFile(`${deps.rsiDir.replace(/\/+$/, '')}/GOAL_VECTOR.md`);
  if (rawGoal != null && hashContent(rawGoal) !== deps.goalHash) {
    const st: LoopState = { ...prev, stopped: true, stopReasons: [...prev.stopReasons, 'goal-vector-mutated'] };
    await deps.afs.writeFile(
      `${deps.rsiDir.replace(/\/+$/, '')}/LOOP_STATE.json`,
      JSON.stringify({ version: 1, state: st }, null, 2),
    );
    return {
      outcome: {
        state: st, reward: NaN,
        verdict: { action: 'reject', reason: 'external-fail' },
        mustRollback: false, status: 'failed', failureReason: 'goal-vector-mutated', duplicate: false,
      },
      state: st, iterationPath: null, evolutionAppended: false,
      stop: evaluateStop({ ...stopInput(st), cannotVerify: true }),
      preempted: 'goal-vector-mutated', rollback: null, cascadeStages: 0, missingMetrics: [],
    };
  }
  const errors = validateCandidate(deps.candidate, deps.goal, deps.workspaceRoot);
  if (errors.length > 0) {
    return recordRejection(prev, deps, now, 'invalid-declaration', errors.join('; '), emptyStop);
  }

  // 2. Run the declared cascade on the real exec bridge.
  const cascade = await runVerifyCascade(deps.runner, deps.workspaceRoot, deps.stages);
  const { deltas, missing } = buildMetricDeltas(deps.bindings, deps.baseline, cascade.stages);
  const extraDiags = [
    cascade.stoppedAt ? `cascade stopped at ${cascade.stoppedAt} (${cascade.costSteps}/${deps.stages.length} stages)` : null,
    missing.length ? `missing metrics: ${missing.join('; ')}` : null,
    deps.diagnostics ?? null,
  ].filter(Boolean).join('\n');

  const result: EpisodeResult = {
    externalPass: cascade.passedAll,
    metrics: deltas.map((d) => ({ id: d.id, delta: d.delta, ...(d.scale != null ? { scale: d.scale } : {}), ...(d.minDelta != null ? { minDelta: d.minDelta } : {}) })),
    judges: deps.judges,
    filesTouched: deps.filesTouched,
    linesChanged: deps.linesChanged,
  };
  const outcome = recordEpisodeOutcome(prev, {
    candidate: deps.candidate, result, costUsd: deps.costUsd,
    parentId: deps.parentId, baselineId: deps.baselineId, strategyId: deps.strategyId,
    costSteps: cascade.costSteps, diagnostics: extraDiags || undefined,
    retentionPassed: deps.retentionPassed,
  });

  // 3. Roll back every non-accept through the same fs primitives as undoEffect.
  let rollback: RollbackReport | null = null;
  if (outcome.mustRollback) {
    rollback = await rollbackWorkspace(deps.afs, deps.snapshot, (p) => deps.afs.readFile(p));
    if (rollback.errors.length) {
      outcome.failureReason = `${outcome.failureReason ?? 'rollback'}+rollback-errors`;
    }
  }

  // 4. Persist: tree + iteration + state (sync serializers, async writes).
  const treePath = `${deps.treesDir.replace(/\/+$/, '')}/${deps.episodeId.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`;
  const prevRaw = await deps.afs.readFile(treePath);
  let tree = prevRaw != null ? parseTree(prevRaw) : createDiscoveryTree(deps.episodeId, deps.strategyId, now);
  const appended = appendExperiment(tree, {
    id: deps.candidate.id, parentId: deps.parentId, baselineId: deps.baselineId,
    candidateId: deps.candidate.id, module: deps.candidate.module, strategyId: deps.strategyId,
    externalPass: result.externalPass, metrics: Object.fromEntries(deltas.map((d) => [d.id, d.delta])),
    reward: outcome.reward, costUsd: Math.max(0, deps.costUsd), costSteps: cascade.costSteps,
    budgetUsd: deps.candidate.costBudgetUsd, attempts: 1, status: outcome.status,
    ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
    ...(extraDiags ? { diagnostics: extraDiags } : {}),
    timestamp: now,
  });
  tree = appended.tree;
  await deps.afs.mkdir(deps.treesDir);
  await deps.afs.writeFile(treePath, serializeTree(tree));

  const { renderIterationFile } = await import('./rsiPersistence');
  const ipath = `${deps.rsiDir.replace(/\/+$/, '')}/iterations/${deps.candidate.id.replace(/[^a-zA-Z0-9-_]/g, '_')}.md`;
  let iterationPath: string | null = null;
  if ((await deps.afs.readFile(ipath)) == null) {
    await deps.afs.mkdir(`${deps.rsiDir.replace(/\/+$/, '')}/iterations`);
    await deps.afs.writeFile(ipath, renderIterationFile({
      candidate: deps.candidate, result, reward: outcome.reward,
      verdict: outcome.verdict.action, reason: outcome.verdict.reason, status: outcome.status,
      costUsd: deps.costUsd,
      ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
      ...(extraDiags ? { diagnostics: extraDiags } : {}),
      parentId: deps.parentId, baselineId: deps.baselineId, strategyId: deps.strategyId, timestamp: now,
    }));
    iterationPath = ipath;
  }

  let evolutionAppended = false;
  if (outcome.verdict.action === 'replace-best' && slowRegisterGate({
    acceptedCount: outcome.state.acceptedCount, userApproved: deps.userApprovedWin,
  })) {
    await writeThrough(deps.afs, deps.rsiDir, (fs) => {
      appendEvolutionLog(fs, deps.rsiDir, {
        id: deps.candidate.id, module: deps.candidate.module, reward: outcome.reward,
        summary: `${deps.candidate.hypothesis} (strategy ${deps.strategyId}, parent ${deps.parentId ?? 'none'})`,
        timestamp: now,
      });
    });
    evolutionAppended = true;
  }

  const stop = evaluateStop(stopInput(outcome.state));
  const state: LoopState = stop.shouldStop
    ? { ...outcome.state, stopped: true, stopReasons: [...outcome.state.stopReasons, ...stop.reasons] }
    : outcome.state;
  await deps.afs.writeFile(
    `${deps.rsiDir.replace(/\/+$/, '')}/LOOP_STATE.json`,
    JSON.stringify({ version: 1, state }, null, 2),
  );
  return {
    outcome: { ...outcome, state }, state, iterationPath, evolutionAppended,
    stop, preempted: null, rollback,
    cascadeStages: cascade.costSteps, missingMetrics: missing,
  };
}

// Write-through helper for the sync serializers: stage writes in a scratch
// list, then flush them through the async bridge in order.
interface PendingWrite { path: string; content: string }

async function writeThrough(afs: AsyncRsiFs, _rsiDir: string, fn: (fs: RsiFs) => void): Promise<void> {
  const pending: PendingWrite[] = [];
  const capturing: RsiFs = {
    readFile: () => { throw new Error('writeThrough is write-only'); },
    writeFile: (p, c) => { pending.push({ path: p, content: c }); },
    mkdir: () => {},
    listDir: () => [],
  };
  fn(capturing);
  for (const w of pending) {
    await afs.writeFile(w.path, w.content);
  }
}

async function recordRejection(
  prev: LoopState, deps: AdjudicateDeps, now: number, reason: string, diagnostics: string,
  emptyStop: (s: LoopState) => StopOutcome,
): Promise<AdjudicateResult> {
  const st: LoopState = {
    ...prev, episodeIndex: prev.episodeIndex + 1, seenIds: [...prev.seenIds, deps.candidate.id],
    consecutiveNonImproving: prev.consecutiveNonImproving + 1,
    recentFailures: [...prev.recentFailures, 'no-improvement' as const].slice(-10),
    recentModules: [...prev.recentModules, deps.candidate.module].slice(-10),
  };
  await deps.afs.writeFile(
    `${deps.rsiDir.replace(/\/+$/, '')}/LOOP_STATE.json`,
    JSON.stringify({ version: 1, state: st }, null, 2),
  );
  return {
    outcome: {
      state: st, reward: -999,
      verdict: { action: 'reject', reason: 'external-fail' },
      mustRollback: false, status: 'rejected', failureReason: reason, duplicate: false,
    },
    state: st, iterationPath: null, evolutionAppended: false,
    stop: emptyStop(st), preempted: reason, rollback: null,
    cascadeStages: 0, missingMetrics: [],
  };
}

// ---------------------------------------------------------------------------
// One-tap bootstrap: initialize program-side search state on real disk.
// Best-effort by design — a failure here must never block the agent run.
// ---------------------------------------------------------------------------

export interface BootstrapReport {
  bootstrapped: boolean;
  rsiDir: string;
  created: string[];
  skipped: string;
}

/**
 * Called by RsiView.start() before the kickoff message: ensures STRATEGY.md
 * exists and, when a frozen GOAL_VECTOR.md is present, seeds LOOP_STATE.json
 * (existing files are never overwritten — resume, don't reset).
 */
export async function bootstrapRsiWorkspace(
  afs: AsyncRsiFs, workspaceRoot: string, goalHash: (content: string) => string = hashContent,
): Promise<BootstrapReport> {
  const rsiDir = `${workspaceRoot.replace(/\/+$/, '')}/.conecode/rsi`;
  const created: string[] = [];
  try {
    const strategyPath = `${rsiDir}/STRATEGY.md`;
    if ((await afs.readFile(strategyPath)) == null) {
      await afs.writeFile(strategyPath, '# RSI exploration strategy\n\ncurrent: default\n\nbootstrapped: small serial budget until history says otherwise\n');
      created.push(strategyPath);
    }
    const statePath = `${rsiDir}/LOOP_STATE.json`;
    if ((await afs.readFile(statePath)) == null) {
      const goalRaw = await afs.readFile(`${rsiDir}/GOAL_VECTOR.md`);
      if (goalRaw != null) {
        void goalHash;
        const { parseGoalVector } = await import('./rsiVerify');
        const parsed = parseGoalVector(goalRaw);
        if (parsed.metrics.length > 0) {
          const state: LoopState = {
            goal: {
              charter: parsed.charter, frozenAt: parsed.frozenAt || new Date().toISOString(),
              metrics: parsed.metrics.map((m) => ({ id: m.id, command: m.command, direction: m.direction, baseline: 0 })),
              nonGoals: parsed.nonGoals ? [parsed.nonGoals] : [],
            },
            workspaceRoot, episodeIndex: 0,
            best: { reward: 0, id: null }, baselineReward: 0, rewardHistory: [],
            consecutiveNonImproving: 0, consecutiveHardFails: 0, acceptedCount: 0,
            spentUsd: 0, archive: [], seenIds: [], recentFailures: [], recentModules: [],
            stopped: false, stopReasons: [],
          };
          await afs.writeFile(statePath, JSON.stringify({ version: 1, state }, null, 2));
          created.push(statePath);
        }
      }
    }
    return { bootstrapped: true, rsiDir, created, skipped: created.length ? '' : 'all present' };
  } catch {
    return { bootstrapped: false, rsiDir, created, skipped: 'bridge error (agent run proceeds)' };
  }
}

// Re-export for tests that load a baseline through the bridge layer.
export { loadBaseline };
export type { JudgeScores };
