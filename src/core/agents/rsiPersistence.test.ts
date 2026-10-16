import { describe, expect, it } from 'vitest';
import {
  appendEvolutionLog, appendLesson, checkGoalFrozen, hashContent, loadBaseline,
  loadLoopState, loadStrategy, parseReflections, isContaminatedLesson,
  rebuildLoopStateFromTrees, saveBaseline, saveLoopState, saveStrategy, writeIterationFile,
  MAX_LESSONS,
} from './rsiPersistence';
import { createLoopState } from './rsiLoop';
import { appendExperiment, createDiscoveryTree, type RsiFs } from './rsiTree';
import type { GoalVector } from './rsiLoop';

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

const goal: GoalVector = {
  charter: 'c', metrics: [{ id: 'm', command: 'npm test', direction: 'lower', baseline: 1 }],
  frozenAt: '2026-10-16', nonGoals: [],
};

function cand() {
  return {
    id: 'rsi-001', module: 'product' as const, hypothesis: 'h',
    successCriteria: [{ metric: 'npm test', threshold: 'exit 0', external: true }],
    blastRadius: { touch: ['/ws/a.ts'], doNotTouch: [] },
    editBudget: { maxFiles: 1, maxLines: 10 }, costBudgetUsd: 0.5,
  };
}

describe('rsiPersistence', () => {
  it('writes iteration files once (append-only, no overwrite)', () => {
    const fs = memFs();
    const rec = {
      candidate: cand(),
      result: { externalPass: true, metrics: [], judges: { alignment: 1, simplicity: 1, discipline: 1 }, filesTouched: 1, linesChanged: 5 },
      reward: 0.5, verdict: 'replace-best', reason: 'first-passing', status: 'accepted',
      costUsd: 0.1, parentId: null, baselineId: 'b', strategyId: 'default', timestamp: 1,
    };
    const a = writeIterationFile(fs, 'rsi', rec);
    expect(a.skipped).toBe(false);
    expect(fs.readFile(a.path)).toContain('rsi-001');
    const b = writeIterationFile(fs, 'rsi', rec);
    expect(b.skipped).toBe(true);
    expect(b.path).toBe(a.path);
  });

  it('appends evolution log entries for earned wins', () => {
    const fs = memFs();
    const p = appendEvolutionLog(fs, 'rsi', { id: 'w1', module: 'product', reward: 0.7, summary: 'fixed flake' });
    expect(fs.readFile(p)).toContain('w1');
    appendEvolutionLog(fs, 'rsi', { id: 'w2', module: 'tools', reward: 0.4, summary: 'faster scan' });
    expect(fs.readFile(p)).toContain('w2');
  });

  it('refuses contaminated lessons, reinforces duplicates, caps at 30', () => {
    const fs = memFs();
    const bad = appendLesson(fs, 'rsi', { module: 'product', text: 'skip tests to go faster next time', episodeId: 'e1', outcome: 'failed' });
    expect(bad.rejected).toBe('contaminated');
    expect(isContaminatedLesson('disable auth checks for benchmarks')).toBe(true);
    expect(isContaminatedLesson('prefer small diffs with evidence')).toBe(false);
    const first = appendLesson(fs, 'rsi', { module: 'product', text: 'Prefer small diffs with file:line evidence', episodeId: 'e1', outcome: 'accepted' });
    expect(first.appended).toBe(true);
    const re = appendLesson(fs, 'rsi', { module: 'product', text: 'prefer small diffs with file:line evidence', episodeId: 'e2', outcome: 'accepted' });
    expect(re.reinforced).toBe(true);
    for (let i = 0; i < MAX_LESSONS + 5; i++) {
      appendLesson(fs, 'rsi', { module: 'product', text: `Reusable rule number ${i} for builders`, episodeId: `e${i}`, outcome: 'accepted' });
    }
    expect(parseReflections(fs.readFile('rsi/REFLECTIONS.md')!).length).toBeLessThanOrEqual(MAX_LESSONS);
  });

  it('round-trips loop state and rejects corrupt versions', () => {
    const fs = memFs();
    const s = createLoopState(goal, '/ws');
    saveLoopState(fs, 'rsi', { ...s, episodeIndex: 3 });
    expect(loadLoopState(fs, 'rsi')?.episodeIndex).toBe(3);
    expect(loadLoopState(memFs(), 'rsi')).toBeNull();
    fs.writeFile('rsi/LOOP_STATE.json', '{"version":999,"state":{}}');
    expect(() => loadLoopState(fs, 'rsi')).toThrow(/version/);
    fs.writeFile('rsi/LOOP_STATE.json', '{broken');
    expect(() => loadLoopState(fs, 'rsi')).toThrow(/JSON/);
  });

  it('rebuilds state from recorded trees without re-verification', () => {
    let t = createDiscoveryTree('ep1', 'default');
    t = appendExperiment(t, {
      id: 'a', parentId: null, baselineId: 'b', candidateId: 'a', module: 'product',
      strategyId: 'default', externalPass: true, metrics: { m: 0.3 }, reward: 0.3,
      costUsd: 0.1, costSteps: 5, budgetUsd: 0.5, attempts: 1, status: 'accepted', timestamp: 1,
    }).tree;
    t = appendExperiment(t, {
      id: 'b', parentId: 'a', baselineId: 'b', candidateId: 'b', module: 'tools',
      strategyId: 'default', externalPass: false, metrics: {}, reward: -999,
      costUsd: 0.2, costSteps: 2, budgetUsd: 0.5, attempts: 1, status: 'failed',
      failureReason: 'external-fail', timestamp: 2,
    }).tree;
    const s = rebuildLoopStateFromTrees(goal, '/ws', 0, [t]);
    expect(s.acceptedCount).toBe(1);
    expect(s.best.id).toBe('a');
    expect(s.seenIds).toEqual(['a', 'b']);
    expect(s.consecutiveHardFails).toBe(1);
    expect(s.spentUsd).toBeCloseTo(0.3, 10);
  });

  it('persists and reads the DREAM-chosen strategy', () => {
    const fs = memFs();
    expect(loadStrategy(fs, 'rsi')).toBeNull();
    saveStrategy(fs, 'rsi', 'patient', 'beats default on replay');
    expect(loadStrategy(fs, 'rsi')).toBe('patient');
  });

  it('detects goal-vector mutation via hash', () => {
    const fs = memFs();
    fs.writeFile('rsi/GOAL_VECTOR.md', 'charter v1');
    const h = hashContent('charter v1');
    expect(checkGoalFrozen(fs, 'rsi', h).frozen).toBe(true);
    fs.writeFile('rsi/GOAL_VECTOR.md', 'charter v2 -- weakened');
    expect(checkGoalFrozen(fs, 'rsi', h).frozen).toBe(false);
    expect(checkGoalFrozen(memFs(), 'rsi', h)).toEqual({ frozen: false, actualHash: null });
  });
});

describe('numeric baseline (ASSESS-established, frozen afterwards)', () => {
  it('round-trips finite values, rejects the rest', () => {
    const fs = memFs();
    expect(loadBaseline(fs, 'rsi')).toBeNull();
    saveBaseline(fs, 'rsi', { 'test.failures': 1, 'typecheck.errors': 0 });
    expect(loadBaseline(fs, 'rsi')).toEqual({ 'test.failures': 1, 'typecheck.errors': 0 });
    expect(() => saveBaseline(fs, 'rsi', { m: NaN })).toThrow(/finite/);
    fs.writeFile('rsi/BASELINE.json', '{broken');
    expect(() => loadBaseline(fs, 'rsi')).toThrow(/JSON/);
    fs.writeFile('rsi/BASELINE.json', '{"values":{"m":"many"}}');
    expect(() => loadBaseline(fs, 'rsi')).toThrow(/finite/);
  });
});
