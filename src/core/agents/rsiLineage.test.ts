import { describe, expect, it } from 'vitest';
import {
  isBranchable, parentWeight, rankParents, pickParent, rootOf,
  steppingStones, mergePair, type ArchiveNode,
} from './rsiLineage';
import { REWARD_FAIL } from './rsiReward';

const node = (over: Partial<ArchiveNode> & { id: string }): ArchiveNode => ({
  parentId: null,
  module: 'loop',
  accepted: false,
  reward: 0.5,
  externalPass: true,
  children: 0,
  metrics: {},
  ...over,
});

describe('isBranchable (DGM viability)', () => {
  it('excludes hard external failures but keeps rejected near-misses', () => {
    expect(isBranchable(node({ id: 'f', reward: REWARD_FAIL, externalPass: false }))).toBe(false);
    expect(isBranchable(node({ id: 'r', accepted: false, reward: 0.3 }))).toBe(true);
  });
});

describe('rankParents (DGM parent selection)', () => {
  it('prefers strong but underexplored lineages', () => {
    const star = node({ id: 'star', reward: 1.0, children: 6 });
    const fresh = node({ id: 'fresh', reward: 0.8, children: 0 });
    // 0.05+1/7 ≈ 0.19 vs 0.05+0.8/1 = 0.85: the underexplored wins.
    expect(rankParents([star, fresh])[0].id).toBe('fresh');
  });

  it('gives every branchable node a non-zero weight (no lineage abandoned)', () => {
    const weak = node({ id: 'weak', reward: 0.01, children: 20 });
    expect(parentWeight(weak)).toBeGreaterThan(0);
    expect(rankParents([weak]).map((n) => n.id)).toEqual(['weak']);
  });

  it('drops hard failures from the ranking', () => {
    const bad = node({ id: 'bad', reward: REWARD_FAIL, externalPass: false });
    expect(rankParents([bad])).toEqual([]);
  });
});

describe('pickParent (stochastic honoring weights)', () => {
  it('is deterministic under a seeded rand', () => {
    const ranked = rankParents([
      node({ id: 'a', reward: 1.0 }),
      node({ id: 'b', reward: 0.1 }),
    ]);
    expect(pickParent(ranked, () => 0)?.id).toBe('a');
    expect(pickParent(ranked, () => 0.999)?.id).toBe('b');
    expect(pickParent([])).toBeNull();
  });
});

describe('steppingStones', () => {
  it('surfaces rejected-but-passing nodes, best first', () => {
    const stones = steppingStones([
      node({ id: 'acc', accepted: true, reward: 0.9 }),
      node({ id: 'near', accepted: false, reward: 0.7 }),
      node({ id: 'far', accepted: false, reward: 0.2 }),
      node({ id: 'fail', accepted: false, reward: REWARD_FAIL, externalPass: false }),
    ]);
    expect(stones.map((n) => n.id)).toEqual(['near', 'far']);
  });
});

describe('mergePair (GEPA system-aware merge)', () => {
  const a = node({ id: 'a', accepted: true, reward: 0.8, metrics: { speed: 0.5, mem: 0.1 } });
  const b = node({ id: 'b', accepted: true, reward: 0.7, metrics: { speed: 0.1, mem: 0.6 } });

  it('pairs complementary accepted nodes from different lineages', () => {
    const pair = mergePair([a, b]);
    expect(pair).not.toBeNull();
    expect(new Set([pair!.a.id, pair!.b.id])).toEqual(new Set(['a', 'b']));
  });

  it('refuses same-lineage and single-lineage merges', () => {
    const child = node({ id: 'c', parentId: 'a', accepted: true, reward: 0.9, metrics: { speed: 0.9, mem: 0.0 } });
    expect(mergePair([a, child])).toBeNull();
    expect(mergePair([a])).toBeNull();
  });

  it('refuses strictly-dominated pairings', () => {
    const dom = node({ id: 'dom', accepted: true, reward: 0.9, metrics: { speed: 0.9, mem: 0.9 } });
    expect(mergePair([dom, a])).toBeNull();
  });

  it('resolves roots through chains', () => {
    const nodes = [a, node({ id: 'mid', parentId: 'a' }), node({ id: 'leaf', parentId: 'mid' })];
    expect(rootOf(nodes, 'leaf')).toBe('a');
    expect(rootOf(nodes, 'b')).toBe('b');
  });
});
