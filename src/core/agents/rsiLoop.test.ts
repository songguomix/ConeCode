import { describe, expect, it } from 'vitest';
import {
  appendToTree, applyRestore, createLoopState, evaluateStop, planRestore,
  recordEpisodeOutcome, slowRegisterGate, takeSnapshot,
  validateCandidate, nextPhase, type CandidateDeclaration, type GoalVector,
} from './rsiLoop';
import { createDiscoveryTree, loadTree, saveTree, appendExperiment, type RsiFs } from './rsiTree';
import { DEFAULT_EXPLORATION_POLICY, selectExplorationPolicy } from './rsiReplay';
import type { EpisodeResult } from './rsiReward';

const goal: GoalVector = {
  charter: 'Improve reliability of the test workspace.',
  metrics: [{ id: 'test.failures', command: 'npm test', direction: 'lower', baseline: 1 }],
  frozenAt: '2026-10-16',
  nonGoals: ['no new scope'],
};

function cand(over: Partial<CandidateDeclaration> = {}): CandidateDeclaration {
  return {
    id: 'rsi-001', module: 'product', hypothesis: 'fix flake, move test.failures 1->0',
    successCriteria: [{ metric: 'npm test', threshold: 'exit 0', external: true }],
    blastRadius: { touch: ['/ws/src/a.ts'], doNotTouch: ['/ws/.conecode/rsi/GOAL_VECTOR.md'] },
    editBudget: { maxFiles: 2, maxLines: 50 }, costBudgetUsd: 0.5,
    ...over,
  };
}

function goodResult(): EpisodeResult {
  return {
    externalPass: true, metrics: [{ id: 'test.failures', delta: 1, scale: 1 }],
    judges: { alignment: 0.9, simplicity: 0.8, discipline: 0.9 },
    filesTouched: 1, linesChanged: 20,
  };
}

function memFs(): RsiFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
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

describe('rsiLoop executable closed loop', () => {
  it('accepts a candidate with real metric improvement', () => {
    const s0 = createLoopState(goal, '/ws');
    expect(validateCandidate(cand(), goal, '/ws')).toEqual([]);
    const o = recordEpisodeOutcome(s0, {
      candidate: cand(), result: goodResult(), costUsd: 0.1,
      parentId: null, baselineId: 'base-0', strategyId: 'default',
    });
    expect(o.verdict.action).toBe('replace-best');
    expect(o.mustRollback).toBe(false);
    expect(o.status).toBe('accepted');
    expect(o.state.best.id).toBe('rsi-001');
    expect(o.state.acceptedCount).toBe(1);
  });

  it('rejects external failures and demands rollback (no residue)', () => {
    const s0 = createLoopState(goal, '/ws');
    const o = recordEpisodeOutcome(s0, {
      candidate: cand({ id: 'bad' }),
      result: { ...goodResult(), externalPass: false },
      costUsd: 0.1, parentId: null, baselineId: 'base-0', strategyId: 'default',
    });
    expect(o.verdict).toEqual({ action: 'reject', reason: 'external-fail' });
    expect(o.mustRollback).toBe(true);
    // Rollback plan removes files created after the snapshot.
    const snap = takeSnapshot('s', { '/ws/src/a.ts': 'v0' });
    const plan = planRestore(snap, { '/ws/src/a.ts': 'v0-hacked', '/ws/src/junk.ts': 'tmp' });
    const written: Record<string, string> = {};
    const deleted: string[] = [];
    const applied = applyRestore(plan, (p, c) => { written[p] = c; }, (p) => { deleted.push(p); });
    expect(applied.restored).toEqual(['/ws/src/a.ts']);
    expect(applied.deleted).toEqual(['/ws/src/junk.ts']);
  });

  it('rejects a high-composite candidate that breaches a frozen no-regression floor', () => {
    const s0 = createLoopState(goal, '/ws');
    const o = recordEpisodeOutcome(s0, {
      candidate: cand({ id: 'sneaky' }),
      result: {
        externalPass: true,
        metrics: [
          { id: 'speed', delta: 100, scale: 10 },
          { id: 'errors', delta: -5, minDelta: 0 },
        ],
        judges: { alignment: 1, simplicity: 1, discipline: 1 },
        filesTouched: 1, linesChanged: 10,
      },
      costUsd: 0.1, parentId: null, baselineId: 'base-0', strategyId: 'default',
    });
    expect(o.verdict.action).toBe('reject');
    expect(o.verdict.reason).toBe('hard-floor-breach');
    expect(o.mustRollback).toBe(true);
  });

  it('retains a non-best candidate on the Pareto frontier', () => {
    let s = createLoopState(goal, '/ws');
    const first = recordEpisodeOutcome(s, {
      candidate: cand({ id: 'fast' }),
      result: {
        externalPass: true,
        metrics: [{ id: 'speed', delta: 0.9 }, { id: 'mem', delta: 0.0 }],
        judges: { alignment: 0.9, simplicity: 0.9, discipline: 0.9 },
        filesTouched: 1, linesChanged: 10,
      },
      costUsd: 0.1, parentId: null, baselineId: 'base-0', strategyId: 'default',
    });
    s = first.state;
    // Force a high incumbent so the next candidate cannot win overall, then
    // check it survives as frontier on its unique axis.
    s = { ...s, best: { reward: 5, id: 'fast' } };
    s = { ...s, archive: [{ id: 'fast', metrics: { speed: 0.9, mem: 0.0 } }] };
    const second = recordEpisodeOutcome(s, {
      candidate: cand({ id: 'lean' }),
      result: {
        externalPass: true,
        metrics: [{ id: 'speed', delta: 0.1 }, { id: 'mem', delta: 0.8 }],
        judges: { alignment: 0.7, simplicity: 0.7, discipline: 0.9 },
        filesTouched: 1, linesChanged: 10,
      },
      costUsd: 0.1, parentId: 'fast', baselineId: 'base-0', strategyId: 'default',
    });
    expect(second.verdict).toEqual({ action: 'retain-frontier', reason: 'pareto-nondominated' });
    expect(second.state.archive.map((a) => a.id)).toContain('lean');
  });

  it('is idempotent on repeated delivery and survives restarts', () => {
    const fs = memFs();
    let s = createLoopState(goal, '/ws');
    const input = {
      candidate: cand({ id: 'dup' }), result: goodResult(), costUsd: 0.1,
      parentId: null, baselineId: 'base-0', strategyId: 'default',
    };
    const o1 = recordEpisodeOutcome(s, input);
    expect(o1.duplicate).toBe(false);
    const o2 = recordEpisodeOutcome(o1.state, input);
    expect(o2.duplicate).toBe(true);
    expect(o2.state.episodeIndex).toBe(o1.state.episodeIndex);
    // Persist the experiment; a "restart" reloads the same fact.
    let tree = createDiscoveryTree('ep-restart', 'default');
    tree = appendToTree(tree, input, o1);
    saveTree(fs, 'trees', tree);
    const reloaded = loadTree(fs, 'trees', 'ep-restart');
    expect(reloaded?.nodes.map((n) => n.id)).toEqual(['dup']);
  });

  it('DREAM adjusts the exploration strategy from history, but replay never verifies product', () => {
    const mk = (ep: string, rewards: number[]) => {
      let t = createDiscoveryTree(ep, 'default');
      rewards.forEach((r, i) => {
        const pass = r >= 0;
        t = appendExperiment(t, {
          id: `${ep}-e${i}`, parentId: null, baselineId: 'b', candidateId: `${ep}-e${i}`,
          module: 'product', strategyId: 'default', externalPass: pass,
          metrics: { m: r }, reward: r, costUsd: 0.1, costSteps: 5, budgetUsd: 0.5,
          attempts: i + 1, status: pass ? 'accepted' : 'failed', timestamp: i,
        }).tree;
      });
      return t;
    };
    const trees = [mk('a', [0.1, 0.1, 0.9]), mk('b', [0.1, 0.2, 0.85])];
    const out = selectExplorationPolicy(
      [{ ...DEFAULT_EXPLORATION_POLICY, id: 'patient', maxAttempts: 3 }],
      { ...DEFAULT_EXPLORATION_POLICY, maxAttempts: 1 },
      trees,
    );
    expect(out.evidenceSufficient).toBe(true);
    expect(out.policy.id).toBe('patient');
    // The new policy is exploration-only: it carries no product acceptance.
    expect('externalPass' in out.policy).toBe(false);
  });

  it('stops on budget-limited local convergence and never claims a global optimum', () => {
    const stop = evaluateStop({
      rewardHistory: [0.1, 0.5, 0.5, 0.5, 0.5], acceptedCount: 1,
      consecutiveNonImproving: 3, consecutiveHardFails: 0,
      spentUsd: 0.4, budgetCapUsd: 2, costLockOn: false,
      recentFailures: ['no-improvement', 'no-improvement', 'no-improvement'],
      recentModules: ['product', 'product', 'product', 'product'],
      maxEpisodes: 20, episodesRun: 5,
    });
    expect(stop.shouldStop).toBe(true);
    expect(stop.isLocalPlateau).toBe(true);
    expect(stop.report).toMatch(/within the current budget/i);
    expect(stop.report).toMatch(/NOT a proof of global optimality/);
  });

  it('stops on hard-fail streaks, cost lock, and user interrupt — and continues otherwise', () => {
    const base = {
      rewardHistory: [0.2], acceptedCount: 1, consecutiveNonImproving: 0,
      consecutiveHardFails: 0, spentUsd: 0.2, budgetCapUsd: 2, costLockOn: true,
      recentFailures: [] as never[], recentModules: [] as never[],
      maxEpisodes: 20, episodesRun: 1,
    };
    expect(evaluateStop({ ...base, consecutiveHardFails: 2 }).shouldStop).toBe(true);
    expect(evaluateStop({ ...base, spentUsd: 5 }).reasons).toContain('cost-lock-tripped');
    expect(evaluateStop({ ...base, userInterrupted: true }).shouldStop).toBe(true);
    expect(evaluateStop(base).shouldStop).toBe(false);
  });

  it('validates candidates: frozen region, workspace escape, and external gate', () => {
    expect(validateCandidate(cand(), goal, '/ws')).toEqual([]);
    expect(validateCandidate(
      cand({ blastRadius: { touch: ['/ws/.conecode/rsi/GOAL_VECTOR.md'], doNotTouch: [] } }), goal, '/ws',
    ).join(';')).toMatch(/frozen eval region/);
    expect(validateCandidate(
      cand({ blastRadius: { touch: ['/etc/passwd'], doNotTouch: [] } }), goal, '/ws',
    ).join(';')).toMatch(/escapes workspace/);
    expect(validateCandidate(
      cand({ successCriteria: [{ metric: 'vibes', threshold: 'looks good', external: false }] }), goal, '/ws',
    ).join(';')).toMatch(/external:true/);
  });

  it('slow registration refuses single-win lore', () => {
    expect(slowRegisterGate({ acceptedCount: 0 })).toBe(false);
    expect(slowRegisterGate({ acceptedCount: 1 })).toBe(false);
    expect(slowRegisterGate({ acceptedCount: 2 })).toBe(true);
    expect(slowRegisterGate({ acceptedCount: 1, userApproved: true })).toBe(true);
  });

  it('owns a strict phase order ending in STOP', () => {
    expect(nextPhase('ASSESS')).toBe('DISCOVER');
    expect(nextPhase('DREAM')).toBe('ASSESS');
    expect(nextPhase('STOP')).toBeNull();
  });
});
