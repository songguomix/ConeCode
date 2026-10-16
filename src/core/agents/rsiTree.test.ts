import { describe, expect, it } from 'vitest';
import {
  appendExperiment, createDiscoveryTree, childrenOf, findNode, lineageOf,
  listTreeIds, loadAllTrees, loadTree, modulesAttempted, parseTree,
  saveTree, serializeTree, type ExperimentRecord, type RsiFs,
} from './rsiTree';

function memFs(): RsiFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => { files.set(p, c); },
    mkdir: () => {},
    listDir: (dir) => {
      const prefix = dir.replace(/\/+$/, '') + '/';
      const out: string[] = [];
      for (const k of files.keys()) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
      return out.sort();
    },
  };
}

function rec(over: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    id: 'exp-1', parentId: null, baselineId: 'base-0', candidateId: 'exp-1',
    module: 'product', strategyId: 'default', externalPass: true,
    metrics: { 'test.passRate': 0.2 }, reward: 0.5, costUsd: 0.1, costSteps: 5,
    budgetUsd: 0.5, attempts: 1, status: 'accepted', timestamp: 1,
    ...over,
  };
}

describe('rsiTree', () => {
  it('records required fields and round-trips through JSON', () => {
    const t0 = createDiscoveryTree('ep-1', 'default');
    const { tree } = appendExperiment(t0, rec());
    const back = parseTree(serializeTree(tree));
    expect(back.episodeId).toBe('ep-1');
    expect(back.nodes).toHaveLength(1);
    expect(back.nodes[0].id).toBe('exp-1');
    expect(back.nodes[0].failureReason).toBeUndefined();
  });

  it('is idempotent on repeated delivery of the same id', () => {
    const t0 = createDiscoveryTree('ep-1', 'default');
    const a = appendExperiment(t0, rec());
    expect(a.added).toBe(true);
    const b = appendExperiment(a.tree, rec({ reward: 999 }));
    expect(b.added).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.tree.nodes).toHaveLength(1);
    expect(b.tree.nodes[0].reward).toBe(0.5); // first fact wins
  });

  it('rejects unknown parents and invalid records', () => {
    const t0 = createDiscoveryTree('ep-1', 'default');
    expect(() => appendExperiment(t0, rec({ parentId: 'ghost' }))).toThrow(/unknown parentId/);
    expect(() => appendExperiment(t0, rec({ id: '' }))).toThrow();
    expect(() => appendExperiment(t0, rec({ metrics: { m: NaN } }))).toThrow();
  });

  it('tracks lineage and children', () => {
    let t = createDiscoveryTree('ep-1', 'default');
    t = appendExperiment(t, rec({ id: 'a' })).tree;
    t = appendExperiment(t, rec({ id: 'b', parentId: 'a' })).tree;
    t = appendExperiment(t, rec({ id: 'c', parentId: 'a' })).tree;
    expect(childrenOf(t, 'a').map((n) => n.id).sort()).toEqual(['b', 'c']);
    expect(lineageOf(t, 'b').map((n) => n.id)).toEqual(['a', 'b']);
    expect(findNode(t, 'missing')).toBeNull();
    expect(modulesAttempted(t)).toEqual({ product: 3 });
  });

  it('persists to disk and recovers after restart', () => {
    const fs = memFs();
    let t = createDiscoveryTree('ep-1', 'default');
    t = appendExperiment(t, rec({ id: 'e1', status: 'rejected', failureReason: 'external-fail' })).tree;
    t = appendExperiment(t, rec({ id: 'e2', parentId: 'e1', status: 'accepted' })).tree;
    saveTree(fs, '.conecode/rsi/trees', t);
    // Simulate restart: fresh parse from stored bytes.
    const loaded = loadTree(fs, '.conecode/rsi/trees', 'ep-1');
    expect(loaded?.nodes.map((n) => n.id)).toEqual(['e1', 'e2']);
    expect(listTreeIds(fs, '.conecode/rsi/trees')).toEqual(['ep-1']);
    const all = loadAllTrees(fs, '.conecode/rsi/trees');
    expect(all.trees).toHaveLength(1);
    expect(all.corrupt).toHaveLength(0);
  });

  it('reports corrupt files instead of fabricating history', () => {
    const fs = memFs();
    fs.writeFile('.conecode/rsi/trees/bad.json', '{not json');
    const all = loadAllTrees(fs, '.conecode/rsi/trees');
    expect(all.trees).toHaveLength(0);
    expect(all.corrupt).toHaveLength(1);
    expect(() => parseTree('{"episodeId":"x"}')).toThrow();
  });
});
