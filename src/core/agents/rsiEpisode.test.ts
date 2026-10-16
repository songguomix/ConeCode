import { describe, expect, it } from 'vitest';
import { bootstrapSearch, recoverLoopState, runDreamStep, runRsiEpisode, type EpisodeDeps } from './rsiEpisode';
import { createLoopState } from './rsiLoop';
import { hashContent, loadLoopState } from './rsiPersistence';
import { DEFAULT_EXPLORATION_POLICY } from './rsiReplay';
import { appendExperiment, createDiscoveryTree, loadTree, saveTree } from './rsiTree';
import type { RsiFs } from './rsiTree';
import type { EpisodeResult } from './rsiReward';
import type { CandidateDeclaration, GoalVector } from './rsiLoop';

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

const goal: GoalVector = {
  charter: 'c', metrics: [{ id: 'test.failures', command: 'npm test', direction: 'lower', baseline: 1 }],
  frozenAt: '2026-10-16', nonGoals: [],
};
const GOAL_MD = '# goal\nfrozen metrics: test.failures\n';
const goalHashOf = () => hashContent(GOAL_MD);

function cand(over: Partial<CandidateDeclaration> = {}): CandidateDeclaration {
  return {
    id: 'rsi-001', module: 'product', hypothesis: 'fix flake',
    successCriteria: [{ metric: 'npm test', threshold: 'exit 0', external: true }],
    blastRadius: { touch: ['/ws/a.ts'], doNotTouch: [] },
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

function baseDeps(fs: RsiFs & { files: Map<string, string> }, ws: Map<string, string>, over: Partial<EpisodeDeps> = {}): EpisodeDeps {
  return {
    fs, rsiDir: 'rsi', treesDir: 'rsi/trees', episodeId: 'ep1',
    goal, goalHash: goalHashOf(), workspaceRoot: '/ws',
    candidate: cand(), parentId: null, baselineId: 'base-0', strategyId: 'default',
    readWorkspaceFile: (p) => ws.get(p) ?? null,
    writeWorkspaceFile: (p, c) => { ws.set(p, c); },
    deleteWorkspaceFile: (p) => { ws.delete(p); },
    mutate: () => { ws.set('/ws/a.ts', 'v1-fixed'); },
    verify: () => goodResult(),
    costUsd: 0.1,
    stopConfig: { budgetCapUsd: 2, costLockOn: false, maxEpisodes: 20 },
    ...over,
  };
}

describe('runRsiEpisode (executable closed loop)', () => {
  it('runs success end-to-end: mutate stays, tree+iteration+state persist', () => {
    const fs = memFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD });
    const ws = new Map([['/ws/a.ts', 'v0']]);
    const s0 = bootstrapSearch(goal, '/ws');
    const r = runRsiEpisode(s0, baseDeps(fs, ws));
    expect(r.preempted).toBeNull();
    expect(r.outcome.verdict.action).toBe('replace-best');
    expect(r.rolledBack).toBeNull();
    expect(ws.get('/ws/a.ts')).toBe('v1-fixed');
    expect(loadTree(fs, 'rsi/trees', 'ep1')?.nodes.map((n) => n.id)).toEqual(['rsi-001']);
    expect(r.iterationPath).toContain('rsi-001');
    expect(loadLoopState(fs, 'rsi')?.best.id).toBe('rsi-001');
    expect(r.stop.shouldStop).toBe(false);
  });

  it('rolls back workspace files and deletes residue on rejection', () => {
    const fs = memFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD });
    const ws = new Map([['/ws/a.ts', 'v0']]);
    const s0 = bootstrapSearch(goal, '/ws');
    const r = runRsiEpisode(s0, baseDeps(fs, ws, {
      candidate: cand({ id: 'bad', blastRadius: { touch: ['/ws/a.ts', '/ws/junk.ts'], doNotTouch: [] } }),
      mutate: () => { ws.set('/ws/a.ts', 'broken'); ws.set('/ws/junk.ts', 'tmp'); },
      verify: () => ({ ...goodResult(), externalPass: false }),
    }));
    expect(r.outcome.verdict.action).toBe('reject');
    expect(r.rolledBack).toEqual({ restored: ['/ws/a.ts'], deleted: ['/ws/junk.ts'] });
    expect(ws.get('/ws/a.ts')).toBe('v0');
    expect(ws.has('/ws/junk.ts')).toBe(false);
  });

  it('treats a throwing mutator as failed and restores partial edits', () => {
    const fs = memFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD });
    const ws = new Map([['/ws/a.ts', 'v0']]);
    const r = runRsiEpisode(bootstrapSearch(goal, '/ws'), baseDeps(fs, ws, {
      mutate: () => { ws.set('/ws/a.ts', 'half-written'); throw new Error('disk full'); },
    }));
    expect(r.outcome.status).toBe('failed');
    expect(r.outcome.failureReason).toBe('mutate-error');
    expect(ws.get('/ws/a.ts')).toBe('v0');
  });

  it('treats a throwing verifier as a hard fail (never a pass)', () => {
    const fs = memFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD });
    const ws = new Map([['/ws/a.ts', 'v0']]);
    const r = runRsiEpisode(bootstrapSearch(goal, '/ws'), baseDeps(fs, ws, {
      verify: () => { throw new Error('harness crashed'); },
    }));
    expect(r.outcome.status).toBe('failed');
    expect(r.outcome.failureReason).toBe('verify-error');
    expect(ws.get('/ws/a.ts')).toBe('v0'); // rolled back
  });

  it('never mutates on invalid declarations or duplicates', () => {
    const fs = memFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD });
    const ws = new Map([['/ws/a.ts', 'v0']]);
    let mutated = false;
    const bad = baseDeps(fs, ws, {
      candidate: cand({ successCriteria: [{ metric: 'vibes', threshold: 'x', external: false }] }),
      mutate: () => { mutated = true; },
    });
    const r1 = runRsiEpisode(bootstrapSearch(goal, '/ws'), bad);
    expect(r1.preempted).toBe('invalid-declaration');
    expect(mutated).toBe(false);
    expect(ws.get('/ws/a.ts')).toBe('v0');

    const ok = runRsiEpisode(bootstrapSearch(goal, '/ws'), baseDeps(fs, ws));
    const dup = runRsiEpisode(ok.state, baseDeps(fs, ws, { mutate: () => { mutated = true; } }));
    expect(dup.preempted).toBe('duplicate-candidate-id');
    expect(mutated).toBe(false);
  });

  it('aborts without mutation when the goal vector moved mid-search', () => {
    const fs = memFs({ 'rsi/GOAL_VECTOR.md': 'WEAKENED charter -- tests optional now' });
    const ws = new Map([['/ws/a.ts', 'v0']]);
    let mutated = false;
    const r = runRsiEpisode(bootstrapSearch(goal, '/ws'), baseDeps(fs, ws, {
      mutate: () => { mutated = true; },
    }));
    expect(r.preempted).toBe('goal-vector-mutated');
    expect(mutated).toBe(false);
    expect(r.state.stopped).toBe(true);
  });

  it('recovers after interruption: persisted state reloads, history continues', () => {
    const fs = memFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD });
    const ws = new Map([['/ws/a.ts', 'v0']]);
    const first = runRsiEpisode(bootstrapSearch(goal, '/ws'), baseDeps(fs, ws));
    // Simulate process restart: fresh state object rebuilt from disk.
    const rec = recoverLoopState(fs, 'rsi', 'rsi/trees', goal, '/ws', 0);
    expect(rec.rebuilt).toBe(false);
    expect(rec.state.best.id).toBe('rsi-001');
    const second = runRsiEpisode(rec.state, baseDeps(fs, ws, { candidate: cand({ id: 'rsi-002' }) }));
    // Same metrics as best: not better overall, but non-dominated → frontier.
    expect(second.outcome.verdict.action).toBe('retain-frontier');
    expect(second.state.best.id).toBe('rsi-001'); // incumbent untouched
    expect(second.state.episodeIndex).toBe(first.state.episodeIndex + 1);
    // Corrupt LOOP_STATE.json falls back to tree rebuild, never crashes.
    fs.writeFile('rsi/LOOP_STATE.json', '{broken');
    const rec2 = recoverLoopState(fs, 'rsi', 'rsi/trees', goal, '/ws', 0);
    expect(rec2.rebuilt).toBe(true);
    expect(rec2.state.seenIds).toContain('rsi-001');
  });

  it('stops after the episode budget is exhausted', () => {
    const fs = memFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD });
    const ws = new Map([['/ws/a.ts', 'v0']]);
    const r = runRsiEpisode(createLoopState(goal, '/ws'), baseDeps(fs, ws, {
      stopConfig: { budgetCapUsd: 2, costLockOn: false, maxEpisodes: 0 },
    }));
    expect(r.stop.shouldStop).toBe(true);
    expect(r.stop.reasons).toContain('episode-budget-exhausted');
  });

  it('DREAM persists an evidence-backed policy switch, keeps default on thin data', () => {
    const fs = memFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD });
    const ws = new Map([['/ws/a.ts', 'v0']]);
    // Thin history: one episode only → keep default.
    runRsiEpisode(bootstrapSearch(goal, '/ws'), baseDeps(fs, ws, { episodeId: 'ep-a' }));
    const thin = runDreamStep({
      fs, rsiDir: 'rsi', treesDir: 'rsi/trees',
      incumbent: DEFAULT_EXPLORATION_POLICY,
      challengers: [{ ...DEFAULT_EXPLORATION_POLICY, id: 'patient', maxAttempts: 5 }],
    });
    expect(thin.policy.id).toBe('default');
    expect(thin.persisted).toBe(false);

    // Rich history where the best is always late: a larger budget wins replay.
    const fs2 = memFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD });
    for (const ep of ['a', 'b']) {
      let t = createDiscoveryTree(ep, 'default');
      [0.1, 0.1, 0.9].forEach((r, i) => {
        t = appendExperiment(t, {
          id: `${ep}-e${i}`, parentId: null, baselineId: 'b', candidateId: `${ep}-e${i}`,
          module: 'product', strategyId: 'default', externalPass: true,
          metrics: { m: r }, reward: r, costUsd: 0.1, costSteps: 5, budgetUsd: 0.5,
          attempts: i + 1, status: 'accepted', timestamp: i,
        }).tree;
      });
      saveTree(fs2, 'rsi/trees', t);
    }
    const rich = runDreamStep({
      fs: fs2, rsiDir: 'rsi', treesDir: 'rsi/trees',
      incumbent: { ...DEFAULT_EXPLORATION_POLICY, maxAttempts: 1 },
      challengers: [{ ...DEFAULT_EXPLORATION_POLICY, id: 'patient', maxAttempts: 3 }],
    });
    expect(rich.evidenceSufficient).toBe(true);
    expect(rich.policy.id).toBe('patient');
    expect(rich.persisted).toBe(true);
    void ws;
  });
});

describe('undeclared-creation detection (sync orchestrator)', () => {
  it('removes undeclared files on rollback and names them in diagnostics', () => {
    const ws = new Map([['/ws/a.ts', 'v0']]);
    const listDir = (dir: string): string[] | null => {
      if (dir !== '/ws') return null;
      return [...ws.keys()].filter((k) => k.startsWith('/ws/')).map((k) => k.slice(4)).sort();
    };
    const memFs2 = memFs();
    const r = runRsiEpisode(bootstrapSearch(goal, '/ws'), baseDeps(memFs2, ws, {
      candidate: cand({ id: 'undeclared' }),
      readWorkspaceFile: (p) => ws.get(p) ?? null,
      writeWorkspaceFile: (p, c) => { ws.set(p, c); },
      deleteWorkspaceFile: (p) => { ws.delete(p); },
      listDir,
      mutate: () => { ws.set('/ws/a.ts', 'broken'); ws.set('/ws/evil.ts', 'junk'); },
      verify: () => ({ ...goodResult(), externalPass: false }),
    }));
    expect(r.outcome.verdict.action).toBe('reject');
    expect(r.rolledBack?.deleted).toContain('/ws/evil.ts');
    expect(ws.has('/ws/evil.ts')).toBe(false);
    expect(ws.get('/ws/a.ts')).toBe('v0');
  });
});
