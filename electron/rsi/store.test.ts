import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeRsiFs, workspaceRsiDir } from './store';
import { loadAllTrees, saveTree, createDiscoveryTree, appendExperiment } from '../../src/core/agents/rsiTree';
import { saveLoopState, loadLoopState, writeIterationFile } from '../../src/core/agents/rsiPersistence';
import { createLoopState } from '../../src/core/agents/rsiLoop';

function tmpRsiDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-disk-'));
  return path.join(dir, '.conecode', 'rsi');
}

describe('electron RSI node fs adapter (real disk)', () => {
  it('round-trips trees, loop state, and iteration files on real disk', () => {
    const rsiDir = tmpRsiDir();
    const treesDir = path.join(rsiDir, 'trees');
    const adapter = nodeRsiFs();

    let tree = createDiscoveryTree('ep-disk', 'default');
    tree = appendExperiment(tree, {
      id: 'e1', parentId: null, baselineId: 'b', candidateId: 'e1', module: 'product',
      strategyId: 'default', externalPass: true, metrics: { m: 0.4 }, reward: 0.4,
      costUsd: 0.1, costSteps: 5, budgetUsd: 0.5, attempts: 1, status: 'accepted', timestamp: 1,
    }).tree;
    saveTree(adapter, treesDir, tree);
    // Restart: fresh adapter, same bytes.
    const { trees, corrupt } = loadAllTrees(nodeRsiFs(), treesDir);
    expect(corrupt).toHaveLength(0);
    expect(trees.map((t) => t.episodeId)).toEqual(['ep-disk']);

    const goal = {
      charter: 'c', metrics: [{ id: 'm', command: 'npm test', direction: 'lower' as const, baseline: 1 }],
      frozenAt: '2026-10-16', nonGoals: [],
    };
    saveLoopState(adapter, rsiDir, { ...createLoopState(goal, '/ws'), best: { reward: 0.4, id: 'e1' } });
    expect(loadLoopState(nodeRsiFs(), rsiDir)?.best.id).toBe('e1');

    const { path: ipath, skipped } = writeIterationFile(adapter, rsiDir, {
      candidate: {
        id: 'e1', module: 'product', hypothesis: 'h',
        successCriteria: [{ metric: 'npm test', threshold: 'exit 0', external: true }],
        blastRadius: { touch: ['/ws/a.ts'], doNotTouch: [] },
        editBudget: { maxFiles: 1, maxLines: 10 }, costBudgetUsd: 0.5,
      },
      result: { externalPass: true, metrics: [], judges: { alignment: 1, simplicity: 1, discipline: 1 }, filesTouched: 1, linesChanged: 5 },
      reward: 0.4, verdict: 'replace-best', reason: 'first-passing', status: 'accepted',
      costUsd: 0.1, parentId: null, baselineId: 'b', strategyId: 'default', timestamp: 1,
    });
    expect(skipped).toBe(false);
    expect(fs.existsSync(ipath)).toBe(true);
  });

  it('builds the workspace RSI dir under .conecode/rsi', () => {
    expect(workspaceRsiDir('/ws/proj')).toBe('/ws/proj/.conecode/rsi');
  });
});
