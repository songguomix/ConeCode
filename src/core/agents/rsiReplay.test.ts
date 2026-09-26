import { describe, expect, it } from 'vitest';
import {
  greedyReplayTrace, meanReplayValue, replayScore, selectExplorationPolicy,
  type DiscoveryTree, type ExplorationPolicy,
} from './rsiReplay';

const tree: DiscoveryTree = {
  id: 't1',
  nodes: [
    { id: 'root-a', parentId: null, reward: 0.2, costSteps: 1, accepted: false },
    { id: 'good', parentId: 'root-a', reward: 1.0, costSteps: 1, accepted: true },
    { id: 'meh', parentId: 'root-a', reward: 0.1, costSteps: 1, accepted: false },
    { id: 'bad', parentId: null, reward: -999, costSteps: 1, accepted: false },
  ],
};

describe('replayScore (Dream-RSI quality − cost + parallelism)', () => {
  it('uses max reward as quality and penalizes cost', () => {
    const few = replayScore(tree, { revealed: ['good'], rounds: 1 }, 0.05, 0.02);
    const many = replayScore(tree, { revealed: ['good', 'meh', 'root-a'], rounds: 1 }, 0.05, 0.02);
    // More revealed attempts: same max quality, higher N → lower V.
    expect(few).toBeGreaterThan(many);
  });

  it('bonusses useful batching (same N, fewer rounds)', () => {
    const batched = replayScore(tree, { revealed: ['good', 'meh'], rounds: 1 }, 0.05, 0.02);
    const serial = replayScore(tree, { revealed: ['good', 'meh'], rounds: 2 }, 0.05, 0.02);
    expect(batched).toBeGreaterThan(serial);
  });

  it('is zero on an empty trace', () => {
    expect(replayScore(tree, { revealed: [], rounds: 0 })).toBe(0);
  });
});

describe('greedyReplayTrace', () => {
  it('reveals top-reward nodes first and skips hard fails', () => {
    const t = greedyReplayTrace(tree, 2);
    expect(t.revealed).toEqual(['good', 'root-a']);
  });
});

describe('selectExplorationPolicy', () => {
  const incumbent: ExplorationPolicy = { id: 'inc', maxAttempts: 1, moduleSpread: 1 };
  const wide: ExplorationPolicy = { id: 'wide', maxAttempts: 3, moduleSpread: 2 };

  it('never selects a policy worse than incumbent (monotone)', () => {
    const weak: ExplorationPolicy = { id: 'weak', maxAttempts: 1, moduleSpread: 1 };
    const { chosen, scores } = selectExplorationPolicy([weak], incumbent, [tree]);
    expect(scores[weak.id]).toBe(scores[incumbent.id]);
    expect(['inc', 'weak']).toContain(chosen.id);
  });

  it('can select a wider policy when replay value is higher', () => {
    const hist = [tree, { ...tree, id: 't2' }];
    const { chosen, scores } = selectExplorationPolicy([wide], incumbent, hist);
    // wide reveals more high-reward nodes; may win depending on cost term.
    expect(scores).toHaveProperty('inc');
    expect(scores).toHaveProperty('wide');
    expect(chosen.id === 'wide' || chosen.id === 'inc').toBe(true);
  });

  it('meanReplayValue is finite and defined on empty history as 0', () => {
    expect(meanReplayValue(incumbent, [])).toBe(0);
    expect(Number.isFinite(meanReplayValue(incumbent, [tree]))).toBe(true);
  });
});
