import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapRsiWorkspace, electronAsyncFs, electronExecRunner, rollbackWorkspace,
  snapshotWorkspace, verifyAndAdjudicate, type AsyncRsiFs, type AdjudicateDeps,
} from './rsiBridge';
import { createLoopState, type CandidateDeclaration, type GoalVector } from './rsiLoop';
import { hashContent } from './rsiPersistence';
import { defaultMetricBindings } from './rsiVerify';
import type { CommandResult } from './rsiVerify';

function memAsyncFs(seed: Record<string, string> = {}): AsyncRsiFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  const parent = (p: string) => {
    const q = p.replace(/\\/g, '/');
    const cut = q.lastIndexOf('/');
    return cut <= 0 ? '/' : q.slice(0, cut);
  };
  return {
    files,
    readFile: async (p) => files.get(p) ?? null,
    pathExists: async (p) => files.has(p),
    writeFile: async (p, c) => { files.set(p, c); },
    mkdir: async () => {},
    listFiles: async (dir) => {
      const prefix = dir.replace(/\/+$/, '') + '/';
      const out: string[] = [];
      for (const k of files.keys()) {
        if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) out.push(k);
      }
      void parent;
      return out.sort();
    },
    deleteFile: async (p) => { files.delete(p); },
  };
}

const goal: GoalVector = {
  charter: 'c', metrics: [{ id: 'test.failures', command: 'npm test', direction: 'lower', baseline: 1 }],
  frozenAt: '2026-10-16', nonGoals: [],
};
const GOAL_MD = 'Frozen 2026-10-16\n## Charter\nc\n';

function cand(over: Partial<CandidateDeclaration> = {}): CandidateDeclaration {
  return {
    id: 'rsi-001', module: 'product', hypothesis: 'fix flake',
    successCriteria: [{ metric: 'npm test', threshold: 'exit 0', external: true }],
    blastRadius: { touch: ['/ws/a.ts'], doNotTouch: [] },
    editBudget: { maxFiles: 2, maxLines: 50 }, costBudgetUsd: 0.5,
    ...over,
  };
}

const VITEST_PASS = ' RUN  v4\n Test Files  1 passed (1)\n      Tests  10 passed (10)\n';
const VITEST_FAIL = ' RUN  v4\n Test Files  1 failed (1)\n      Tests  1 failed | 9 passed (10)\n';

function adjudicateDeps(fs: AsyncRsiFs & { files: Map<string, string> }, snap: { files: Record<string, string>; scanned: Record<string, string[]> }, out: CommandResult, over: Partial<AdjudicateDeps> = {}): AdjudicateDeps {
  return {
    afs: fs, rsiDir: 'rsi', treesDir: 'rsi/trees', episodeId: 'ep1',
    goal, goalHash: hashContent(GOAL_MD), workspaceRoot: '/ws',
    candidate: cand(), parentId: null, baselineId: 'base-0', strategyId: 'default',
    snapshot: { id: 'rsi-001', files: { ...snap.files }, takenAt: 1, scanned: snap.scanned },
    runner: async () => ({ ...out }),
    stages: [{ id: 'full', command: 'npm test' }],
    bindings: defaultMetricBindings(),
    baseline: { 'test.failures': 1 },
    judges: { alignment: 0.9, simplicity: 0.8, discipline: 0.9 },
    filesTouched: 1, linesChanged: 20, costUsd: 0.1,
    stopConfig: { budgetCapUsd: 2, costLockOn: false, maxEpisodes: 20 },
    ...over,
  };
}

describe('snapshot/rollback over the async bridge', () => {
  it('refuses to snapshot an existing file whose contents cannot be read', async () => {
    const fs = memAsyncFs({ '/ws/existing.ts': 'important content' });
    fs.readFile = async () => null;
    await expect(snapshotWorkspace(fs, ['/ws/existing.ts'])).rejects.toThrow(/unreadable or absence is unconfirmed/);
    expect(fs.files.get('/ws/existing.ts')).toBe('important content');
  });

  it('refuses unknown existence and propagates read failures before mutation', async () => {
    const fs = memAsyncFs();
    fs.pathExists = async () => null;
    await expect(snapshotWorkspace(fs, ['/ws/unknown.ts'])).rejects.toThrow(/absence is unconfirmed/);
    fs.readFile = async () => { throw new Error('permission denied'); };
    await expect(snapshotWorkspace(fs, ['/ws/unknown.ts'])).rejects.toThrow('permission denied');
  });

  it('does not delete an unreadable original from an old declaredPaths snapshot', async () => {
    const fs = memAsyncFs({ '/ws/existing.ts': 'important content' });
    const legacy = {
      id: 'legacy', files: {}, declaredPaths: ['/ws/existing.ts'],
      scanned: { '/ws': [] }, takenAt: 1,
    };
    const report = await rollbackWorkspace(fs, legacy, fs.readFile);
    expect(report.deleted).toEqual([]);
    expect(fs.files.get('/ws/existing.ts')).toBe('important content');
  });

  it('never deletes a previously listed original even if absence metadata disagrees', async () => {
    const fs = memAsyncFs({ '/ws/existing.ts': 'important content' });
    const report = await rollbackWorkspace(fs, {
      id: 'conflicting', files: {}, absentPaths: ['/ws/existing.ts'],
      scanned: { '/ws': ['/ws/existing.ts'] }, takenAt: 1,
    }, fs.readFile);
    expect(report.deleted).toEqual([]);
    expect(fs.files.get('/ws/existing.ts')).toBe('important content');
  });

  it('deletes declared new files even when directory scanning is unavailable', async () => {
    const fs = memAsyncFs();
    fs.listFiles = async () => null;
    const snapshot = await snapshotWorkspace(fs, ['/ws/new.ts']);
    await fs.writeFile('/ws/new.ts', 'new content');
    const report = await rollbackWorkspace(fs, snapshot, fs.readFile);
    expect(report.deleted).toEqual(['/ws/new.ts']);
    expect(await fs.readFile('/ws/new.ts')).toBeNull();
  });

  it('round-trips declared contents and deletes undeclared creations', async () => {
    const fs = memAsyncFs({ '/ws/a.ts': 'v0' });
    const snap = await snapshotWorkspace(fs, ['/ws/a.ts']);
    expect(snap.files).toEqual({ '/ws/a.ts': 'v0' });
    // Model edit via chat loop: modify declared + create undeclared junk.
    await fs.writeFile('/ws/a.ts', 'v1');
    await fs.writeFile('/ws/junk.ts', 'tmp');
    const rep = await rollbackWorkspace(fs, snap, (p) => fs.readFile(p));
    expect(rep.restored).toEqual(['/ws/a.ts']);
    expect(rep.undeclaredCreated).toEqual(['/ws/junk.ts']);
    expect(rep.deleted).toEqual(['/ws/junk.ts']);
    expect(rep.errors).toEqual([]);
    expect(await fs.readFile('/ws/a.ts')).toBe('v0');
    expect(await fs.readFile('/ws/junk.ts')).toBeNull();
  });
});

describe('verifyAndAdjudicate (program-owned post-mutation gate)', () => {
  it('appends earned wins to the existing evolution log without losing history', async () => {
    const fs = memAsyncFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD, 'rsi/EVOLUTION_LOG.md': '# Earlier wins\n\nExisting evidence.\n' });
    const snap = await snapshotWorkspace(fs, ['/ws/a.ts']);
    const previous = { ...createLoopState(goal, '/ws'), acceptedCount: 1 };
    const result = await verifyAndAdjudicate(previous, adjudicateDeps(fs, snap, { stdout: VITEST_PASS, stderr: '', exitCode: 0 }));
    expect(result.evolutionAppended).toBe(true);
    expect(await fs.readFile('rsi/EVOLUTION_LOG.md')).toContain('Existing evidence.');
    expect(await fs.readFile('rsi/EVOLUTION_LOG.md')).toContain('rsi-001');
    expect(await fs.readFile('rsi/LOOP_STATE.json')).toContain('rsi-001');
  });

  it('rejects a passing command when a frozen metric cannot be measured', async () => {
    const fs = memAsyncFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD, '/ws/a.ts': 'original' });
    const snap = await snapshotWorkspace(fs, ['/ws/a.ts']);
    await fs.writeFile('/ws/a.ts', 'changed');
    const result = await verifyAndAdjudicate(createLoopState(goal, '/ws'), adjudicateDeps(fs, snap, { stdout: 'No tests found', stderr: '', exitCode: 0 }));
    expect(result.outcome.verdict).toEqual({ action: 'reject', reason: 'external-fail' });
    expect(result.missingMetrics.join(';')).toMatch(/test.failures/);
    expect(await fs.readFile('/ws/a.ts')).toBe('original');
  });

  it('rejects a missing frozen goal and restores the pre-mutation snapshot', async () => {
    const fs = memAsyncFs({ '/ws/a.ts': 'original' });
    const snap = await snapshotWorkspace(fs, ['/ws/a.ts']);
    await fs.writeFile('/ws/a.ts', 'changed');
    const result = await verifyAndAdjudicate(createLoopState(goal, '/ws'), adjudicateDeps(fs, snap, { stdout: VITEST_PASS, stderr: '', exitCode: 0 }));
    expect(result.preempted).toBe('goal-vector-missing');
    expect(result.cascadeStages).toBe(0);
    expect(await fs.readFile('/ws/a.ts')).toBe('original');
  });

  it('accepts a truly improving candidate without touching files', async () => {
    const fs = memAsyncFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD, '/ws/a.ts': 'v0' });
    const snap = await snapshotWorkspace(fs, ['/ws/a.ts']);
    await fs.writeFile('/ws/a.ts', 'v1-fixed'); // chat-loop mutation already applied
    const r = await verifyAndAdjudicate(
      createLoopState(goal, '/ws'),
      adjudicateDeps(fs, snap, { stdout: VITEST_PASS, stderr: '', exitCode: 0 }),
    );
    expect(r.preempted).toBeNull();
    expect(r.outcome.verdict.action).toBe('replace-best');
    expect(r.rollback).toBeNull();
    expect(await fs.readFile('/ws/a.ts')).toBe('v1-fixed'); // kept
    expect(r.iterationPath).toContain('rsi-001');
    expect(r.missingMetrics.join(';')).toMatch(/typecheck.errors/);
    const treeRaw = await fs.readFile('rsi/trees/ep1.json');
    expect(treeRaw).toContain('rsi-001');
    expect(await fs.readFile('rsi/LOOP_STATE.json')).toContain('rsi-001');
  });

  it('rejects on cascade failure and restores workspace + removes junk', async () => {
    const fs = memAsyncFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD, '/ws/a.ts': 'v0' });
    const snap = await snapshotWorkspace(fs, ['/ws/a.ts']);
    await fs.writeFile('/ws/a.ts', 'broken');
    await fs.writeFile('/ws/junk.ts', 'tmp');
    const r = await verifyAndAdjudicate(
      createLoopState(goal, '/ws'),
      adjudicateDeps(fs, snap, { stdout: VITEST_FAIL, stderr: '', exitCode: 1 }),
    );
    expect(r.outcome.verdict.action).toBe('reject');
    expect(r.rollback?.restored).toEqual(['/ws/a.ts']);
    expect(r.rollback?.undeclaredCreated).toEqual(['/ws/junk.ts']);
    expect(await fs.readFile('/ws/a.ts')).toBe('v0');
    expect(await fs.readFile('/ws/junk.ts')).toBeNull();
  });

  it('aborts without verification when the goal moved mid-search', async () => {
    const fs = memAsyncFs({ 'rsi/GOAL_VECTOR.md': 'WEAKENED — tests optional' });
    const snap = await snapshotWorkspace(fs, ['/ws/a.ts']);
    let ran = 0;
    const r = await verifyAndAdjudicate(
      createLoopState(goal, '/ws'),
      adjudicateDeps(fs, snap, { stdout: VITEST_PASS, stderr: '', exitCode: 0 }, {
        runner: async () => { ran++; return { stdout: '', stderr: '', exitCode: 0 }; },
      }),
    );
    expect(r.preempted).toBe('goal-vector-mutated');
    expect(ran).toBe(0); // verification budget unspent
    expect(r.state.stopped).toBe(true);
  });

  it('is idempotent on duplicate candidate ids', async () => {
    const fs = memAsyncFs({ 'rsi/GOAL_VECTOR.md': GOAL_MD, '/ws/a.ts': 'v1' });
    const snap = await snapshotWorkspace(fs, ['/ws/a.ts']);
    const deps = adjudicateDeps(fs, snap, { stdout: VITEST_PASS, stderr: '', exitCode: 0 });
    const first = await verifyAndAdjudicate(createLoopState(goal, '/ws'), deps);
    const dup = await verifyAndAdjudicate(first.state, deps);
    expect(dup.preempted).toBe('duplicate-candidate-id');
    expect(dup.rollback).toBeNull();
  });
});

describe('bridge environment guards', () => {
  it('does not infer absence from swallowed IPC errors or hidden-file listings', async () => {
    const readFile = vi.fn(async () => null);
    const readDir = vi.fn(async () => [] as Array<{ name: string; path: string; isDirectory: boolean }>);
    vi.stubGlobal('window', { electronAPI: { fs: { readFile, readDir, stat: async () => null } } });
    try {
      const fs = electronAsyncFs()!;
      await expect(snapshotWorkspace(fs, ['/ws/existing.ts'])).rejects.toThrow(/absence is unconfirmed/);
      expect(await fs.listFiles('/ws')).toBeNull();
      readDir.mockResolvedValue([{ name: 'sibling.ts', path: '/ws/sibling.ts', isDirectory: false }]);
      await expect(snapshotWorkspace(fs, ['/ws/.hidden'])).rejects.toThrow(/absence is unconfirmed/);
      expect((await snapshotWorkspace(fs, ['/ws/new.ts'])).absentPaths).toEqual(['/ws/new.ts']);
      readFile.mockRejectedValueOnce(new Error('IPC read failed'));
      await expect(fs.readFile('/ws/existing.ts')).rejects.toThrow('IPC read failed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns null adapters outside Electron (no fabricated bridge)', () => {
    expect(electronAsyncFs()).toBeNull();
    expect(electronExecRunner()).toBeNull();
  });
});

describe('bootstrapRsiWorkspace', () => {
  it('seeds strategy + state from a frozen goal, never overwrites', async () => {
    const goalMd = [
      '# RSI goal vector', '', 'Frozen 2026-10-16.', '',
      '## Charter', 'Improve things.', '',
      '## Frozen metrics',
      '| id | Exact measurement | Direction | Initial baseline |',
      '| --- | --- | --- | --- |',
      '| test.failures | `npm test` | lower | 1 |',
      '', '## Non-goals', 'None.', '',
    ].join('\n');
    const fs = memAsyncFs({ '/ws/.conecode/rsi/GOAL_VECTOR.md': goalMd });
    const first = await bootstrapRsiWorkspace(fs, '/ws');
    expect(first.bootstrapped).toBe(true);
    expect(first.created.join(',')).toMatch(/STRATEGY.md/);
    expect(first.created.join(',')).toMatch(/LOOP_STATE.json/);
    const second = await bootstrapRsiWorkspace(fs, '/ws');
    expect(second.created).toEqual([]); // resume, don't reset
    expect(second.skipped).toMatch(/all present/);
  });

  it('skips state seeding without a frozen goal, fails soft on bridge errors', async () => {
    const fs = memAsyncFs({});
    const r = await bootstrapRsiWorkspace(fs, '/ws');
    expect(r.bootstrapped).toBe(true);
    expect(r.created.join(',')).toMatch(/STRATEGY.md/);
    expect(r.created.join(',')).not.toMatch(/LOOP_STATE/);
    const broken: AsyncRsiFs = {
      readFile: async () => { throw new Error('ipc gone'); },
      writeFile: async () => { throw new Error('ipc gone'); },
      mkdir: async () => {},
      listFiles: async () => null,
      deleteFile: async () => {},
    };
    const r2 = await bootstrapRsiWorkspace(broken, '/ws');
    expect(r2.bootstrapped).toBe(false);
  });
});
