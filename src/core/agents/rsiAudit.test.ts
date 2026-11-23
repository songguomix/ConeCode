import { describe, expect, it } from 'vitest';
import { parseTscOutput, parseVitestSummary, defaultMetricBindings } from './rsiVerify';
import {
  appendLesson, MAX_LESSONS, parseReflections, rebuildLoopStateFromTrees, hashContent, loadLoopState,
} from './rsiPersistence';
import { replayScore, DEFAULT_EXPLORATION_POLICY } from './rsiReplay';
import { createDiscoveryTree, appendExperiment, type RsiFs } from './rsiTree';
import {
  createLoopState, evaluateStop, recordEpisodeOutcome, toExperimentRecord,
  type CandidateDeclaration, type GoalVector,
} from './rsiLoop';
import { bestOnEachMetric, REWARD_FAIL } from './rsiReward';
import { runRsiEpisode, bootstrapSearch } from './rsiEpisode';
import { snapshotWorkspace, verifyAndAdjudicate, type AsyncRsiFs } from './rsiBridge';

function memFs(seed: Record<string, string> = {}): RsiFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => { files.set(p, c); },
    mkdir: () => {},
    listDir: (dir) => {
      const prefix = dir.replace(/\/+$/, '') + '/';
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
    },
  };
}

function memAsyncFs(seed: Record<string, string> = {}): AsyncRsiFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFile: async (p) => files.get(p) ?? null,
    pathExists: async (p) => files.has(p),
    writeFile: async (p, c) => { files.set(p, c); },
    mkdir: async () => {},
    listFiles: async (dir) => {
      const prefix = dir.replace(/\/+$/, '') + '/';
      return [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).sort();
    },
    deleteFile: async (p) => { files.delete(p); },
  };
}

const goal: GoalVector = {
  charter: 'reliability',
  metrics: [{ id: 'test.failures', command: 'npm test', direction: 'lower', baseline: 1 }],
  frozenAt: '2026-11-23',
  nonGoals: [],
};
const GOAL_MD = '# Goal\nFrozen 2026-11-23\n## Charter\nreliability\n';

function cand(over: Partial<CandidateDeclaration> = {}): CandidateDeclaration {
  return {
    id: 'audit-001',
    module: 'product',
    hypothesis: 'fix defect',
    successCriteria: [{ metric: 'npm test', threshold: 'exit 0', external: true }],
    blastRadius: { touch: ['/ws/a.ts'], doNotTouch: [] },
    editBudget: { maxFiles: 2, maxLines: 50 },
    costBudgetUsd: 0.5,
    ...over,
  };
}

describe('RSI logic audit & defect regression suite', () => {
  it('Defect 1: parses ANSI-colored vitest summaries and tsc --pretty diagnostics', () => {
    const ansiVitest = [
      '\x1b[1m\x1b[30m\x1b[46m RUN \x1b[49m\x1b[39m\x1b[22m \x1b[36mv4.1.11 \x1b[39m',
      '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m2 failed\x1b[39m\x1b[22m | \x1b[1m\x1b[32m250 passed\x1b[39m\x1b[22m | \x1b[33m3 skipped\x1b[39m\x1b[90m (255)\x1b[39m',
    ].join('\n');
    expect(parseVitestSummary(ansiVitest)).toEqual({ failed: 2, passed: 250, skipped: 3 });

    const ansiTsc = [
      '\x1b[96msrc/a.ts\x1b[0m:\x1b[93m1\x1b[0m:\x1b[93m5\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType mismatch.',
      '\x1b[96msrc/b.ts\x1b[0m:\x1b[93m9\x1b[0m:\x1b[93m2\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2304: \x1b[0mCannot find name.',
    ].join('\n');
    expect(parseTscOutput(ansiTsc)).toEqual({ errors: 2 });
  });

  it('Defect 2: keeps lesson IDs monotonically unique past MAX_LESSONS without cross-reinforcement', () => {
    const fs = memFs();
    for (let i = 1; i <= MAX_LESSONS + 5; i++) {
      appendLesson(fs, 'rsi', {
        module: 'product',
        text: `Distinct reusable engineering lesson number ${i}`,
        episodeId: `ep-${i}`,
        outcome: 'accepted',
      });
    }
    const afterCap = parseReflections(fs.readFile('rsi/REFLECTIONS.md')!);
    expect(afterCap).toHaveLength(MAX_LESSONS);
    const ids = afterCap.map((l) => l.id);
    expect(new Set(ids).size).toBe(MAX_LESSONS);
    expect(ids[ids.length - 1]).toBe(`les-${String(MAX_LESSONS + 5).padStart(3, '0')}`);

    // Reinforcing one post-cap lesson must NOT mutate any other lesson's episodes.
    const target = afterCap[afterCap.length - 1];
    const sibling = afterCap[afterCap.length - 2];
    const reinforced = appendLesson(fs, 'rsi', {
      module: 'product',
      text: target.text,
      episodeId: 'ep-reinforce',
      outcome: 'accepted',
    });
    expect(reinforced.reinforced).toBe(true);
    const updated = parseReflections(fs.readFile('rsi/REFLECTIONS.md')!);
    expect(updated.find((l) => l.id === target.id)?.episodes).toContain('ep-reinforce');
    expect(updated.find((l) => l.id === sibling.id)?.episodes).not.toContain('ep-reinforce');
  });

  it('Defect 3: verifyAndAdjudicate honors stopped/budget-exhausted boundary and rolls back mutation', async () => {
    const fs = memAsyncFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD, '/ws/a.ts': 'v0' });
    const snap = await snapshotWorkspace(fs, ['/ws/a.ts']);
    await fs.writeFile('/ws/a.ts', 'mutated-after-stop');
    let ran = 0;
    const stoppedPrev = { ...createLoopState(goal, '/ws'), stopped: true, stopReasons: ['local-plateau'] };
    const res = await verifyAndAdjudicate(stoppedPrev, {
      afs: fs, rsiDir: 'rsi', treesDir: 'rsi/trees', episodeId: 'ep1',
      goal, goalHash: hashContent(GOAL_MD), workspaceRoot: '/ws',
      candidate: cand(), parentId: null, baselineId: 'b0', strategyId: 'default',
      snapshot: snap,
      runner: async () => { ran++; return { stdout: 'Tests  1 passed (1)', stderr: '', exitCode: 0 }; },
      stages: [{ id: 'full', command: 'npm test' }],
      bindings: defaultMetricBindings(),
      baseline: { 'test.failures': 1 },
      judges: { alignment: 1, simplicity: 1, discipline: 1 },
      filesTouched: 1, linesChanged: 5, costUsd: 0.1,
      stopConfig: { budgetCapUsd: 2, costLockOn: false, maxEpisodes: 10 },
    });
    expect(res.preempted).toBe('loop-stopped');
    expect(ran).toBe(0);
    expect(res.cascadeStages).toBe(0);
    expect(res.rollback?.restored).toEqual(['/ws/a.ts']);
    expect(await fs.readFile('/ws/a.ts')).toBe('v0');
  });

  it('Defect 4: invalid-declaration persists stopped state and rewardHistory consistently in episode & bridge', async () => {
    // Sync orchestrator
    const fs = memFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD });
    const ws = new Map([['/ws/a.ts', 'v0']]);
    const r = runRsiEpisode(bootstrapSearch(goal, '/ws'), {
      fs, rsiDir: 'rsi', treesDir: 'rsi/trees', episodeId: 'ep1',
      goal, goalHash: hashContent(GOAL_MD), workspaceRoot: '/ws',
      candidate: cand({ successCriteria: [{ metric: 'vibes', threshold: 'ok', external: false }] }),
      parentId: null, baselineId: 'b0', strategyId: 'default',
      readWorkspaceFile: (p) => ws.get(p) ?? null,
      writeWorkspaceFile: (p, c) => { ws.set(p, c); },
      deleteWorkspaceFile: (p) => { ws.delete(p); },
      mutate: () => {},
      verify: () => ({ externalPass: false, metrics: [], judges: { alignment: 0, simplicity: 0, discipline: 0 }, filesTouched: 0, linesChanged: 0 }),
      costUsd: 0,
      stopConfig: { budgetCapUsd: 2, costLockOn: false, maxEpisodes: 1 },
    });
    expect(r.stop.shouldStop).toBe(true);
    expect(r.state.stopped).toBe(true);
    expect(r.state.rewardHistory).toEqual([REWARD_FAIL]);
    expect(loadLoopState(fs, 'rsi')?.stopped).toBe(true);

    // Async bridge rolls back mutation and persists stopped state
    const afs = memAsyncFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD, '/ws/a.ts': 'v0' });
    const snap = await snapshotWorkspace(afs, ['/ws/a.ts']);
    await afs.writeFile('/ws/a.ts', 'mutated-by-invalid-candidate');
    const br = await verifyAndAdjudicate(createLoopState(goal, '/ws'), {
      afs, rsiDir: 'rsi', treesDir: 'rsi/trees', episodeId: 'ep1',
      goal, goalHash: hashContent(GOAL_MD), workspaceRoot: '/ws',
      candidate: cand({ successCriteria: [{ metric: 'vibes', threshold: 'ok', external: false }] }),
      parentId: null, baselineId: 'b0', strategyId: 'default',
      snapshot: snap,
      runner: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      stages: [{ id: 'full', command: 'npm test' }],
      bindings: defaultMetricBindings(),
      baseline: { 'test.failures': 1 },
      judges: { alignment: 1, simplicity: 1, discipline: 1 },
      filesTouched: 1, linesChanged: 5, costUsd: 0.1,
      stopConfig: { budgetCapUsd: 2, costLockOn: false, maxEpisodes: 1 },
    });
    expect(br.preempted).toBe('invalid-declaration');
    expect(br.state.stopped).toBe(true);
    expect(br.state.rewardHistory).toEqual([REWARD_FAIL]);
    expect(await afs.readFile('/ws/a.ts')).toBe('v0');
  });

  it('Defect 5: +rollback-errors suffix does not bypass DREAM safety filter or corrupt tree rebuild', () => {
    let tree = createDiscoveryTree('ep-rollback', 'default');
    tree = appendExperiment(tree, {
      id: 'vetoed', parentId: null, baselineId: 'b0', candidateId: 'vetoed',
      module: 'product', strategyId: 'default', externalPass: true,
      metrics: { m: 1 }, reward: 1.5, costUsd: 0.1, costSteps: 1, budgetUsd: 0.5,
      attempts: 1, status: 'rolled-back', failureReason: 'discipline-veto+rollback-errors', timestamp: 1,
    }).tree;
    tree = appendExperiment(tree, {
      id: 'pareto-node', parentId: null, baselineId: 'b0', candidateId: 'pareto-node',
      module: 'tools', strategyId: 'default', externalPass: true,
      metrics: { m: 0.6 }, reward: 0.8, costUsd: 0.1, costSteps: 1, budgetUsd: 0.5,
      attempts: 1, status: 'rolled-back', failureReason: 'pareto-nondominated+rollback-errors', timestamp: 2,
    }).tree;

    // DREAM must ignore discipline-veto+rollback-errors (reward 1.5) and only see pareto-node (0.8).
    const score = replayScore(tree, { ...DEFAULT_EXPLORATION_POLICY, maxAttempts: 2 });
    expect(score.maxReward).toBe(0.8);

    // Crash recovery must classify discipline-veto+rollback-errors as discipline-veto (not dominated)
    // and preserve valid measured pareto-nondominated+rollback-errors in archive.
    const rebuilt = rebuildLoopStateFromTrees(goal, '/ws', 0, [tree]);
    expect(rebuilt.recentFailures[0]).toBe('discipline-veto');
    expect(rebuilt.archive.map((a) => a.id)).toEqual(['pareto-node']);
  });

  it('Defect 6: toExperimentRecord reflects retentionPassed=false on externalPass and filters non-finite metrics', () => {
    const prev = createLoopState(goal, '/ws');
    const input = {
      candidate: cand({ id: 'ret-fail' }),
      result: {
        externalPass: true,
        metrics: [{ id: 'test.failures', delta: 1 }, { id: 'bad', delta: NaN }],
        judges: { alignment: 1, simplicity: 1, discipline: 1 },
        filesTouched: 1, linesChanged: 10,
      },
      costUsd: 0.1, parentId: null, baselineId: 'b0', strategyId: 'default',
      retentionPassed: false,
    };
    const outcome = recordEpisodeOutcome(prev, input);
    const rec = toExperimentRecord(input, outcome, 100);
    expect(rec.externalPass).toBe(false);
    expect(rec.metrics).toEqual({ 'test.failures': 1 });
    expect(() => appendExperiment(createDiscoveryTree('ep', 'default'), rec)).not.toThrow();
  });

  it('Defect 7: evaluateStop and bestOnEachMetric are resilient to NaN values', () => {
    const stop = evaluateStop({
      rewardHistory: [NaN, 1.0, 0.8, 0.7, 0.9],
      acceptedCount: 1,
      consecutiveNonImproving: 3,
      consecutiveHardFails: 0,
      spentUsd: 0.2,
      budgetCapUsd: 5,
      costLockOn: false,
      recentFailures: [],
      recentModules: ['product', 'product', 'product', 'product'],
      maxEpisodes: 20,
      episodesRun: 5,
    });
    expect(stop.shouldStop).toBe(true);
    expect(stop.isLocalPlateau).toBe(true);
    expect(stop.reasons).toContain('local-plateau-narrow-search');

    const leaders = bestOnEachMetric([
      { id: 'nan-cand', metrics: { speed: NaN } },
      { id: 'real-cand', metrics: { speed: 0.7 } },
    ]);
    expect(leaders.speed).toEqual(['real-cand']);
  });
});
