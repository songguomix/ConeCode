import { describe, expect, it } from 'vitest';
import { REWARD_FAIL } from './rsiReward';
import { createDiscoveryTree, appendExperiment } from './rsiTree';
import {
  DEFAULT_EXPLORATION_POLICY, evaluatePolicies, isReplayProductVerification,
  replayScore, selectExplorationPolicy,
} from './rsiReplay';

function treeWithRewards(episodeId: string, rewards: number[]) {
  let t = createDiscoveryTree(episodeId, 'default');
  rewards.forEach((r, i) => {
    t = appendExperiment(t, {
      id: `${episodeId}-e${i}`, parentId: i === 0 ? null : `${episodeId}-e${i - 1}`,
      baselineId: 'base', candidateId: `${episodeId}-e${i}`, module: 'product',
      strategyId: 'default', externalPass: r !== REWARD_FAIL,
      metrics: { m: r === REWARD_FAIL ? -1 : r }, reward: r,
      costUsd: 0.1, costSteps: 5, budgetUsd: 0.5, attempts: i + 1,
      status: r === REWARD_FAIL ? 'failed' : 'accepted', timestamp: i,
    }).tree;
  });
  return t;
}

describe('rsiReplay (DREAM offline)', () => {
  it('does not grant parallel bonuses to a serial parent-child search', () => {
    const tree = treeWithRewards('serial', [0.1, 0.2, 0.8]);
    const serial = replayScore(tree, { ...DEFAULT_EXPLORATION_POLICY, parallelism: 1 });
    const parallel = replayScore(tree, { ...DEFAULT_EXPLORATION_POLICY, parallelism: 8 });
    expect(parallel.rounds).toBe(3);
    expect(parallel.score).toBe(serial.score);
  });

  it('batches independent attempts without crossing a dependency', () => {
    const tree = treeWithRewards('branches', [0.1, 0.2, 0.8, 0.6]);
    tree.nodes[1].parentId = null;
    tree.nodes[2].parentId = tree.nodes[0].id;
    tree.nodes[3].parentId = tree.nodes[1].id;
    const result = replayScore(tree, { ...DEFAULT_EXPLORATION_POLICY, maxAttempts: 4, parallelism: 4 });
    expect(result.rounds).toBe(2);
  });

  it('cannot turn a failed or vetoed recorded attempt into a replay win', () => {
    const tree = treeWithRewards('invalid', [0.2, 99, 100]);
    tree.nodes[1].externalPass = false;
    tree.nodes[2].failureReason = 'discipline-veto';
    tree.nodes[2].status = 'rolled-back';
    expect(replayScore(tree, DEFAULT_EXPLORATION_POLICY).maxReward).toBe(0.2);
  });

  it('scores V = max(reward) - b1*N + b2*N/rounds from recorded facts only', () => {
    const t = treeWithRewards('ep1', [0.2, 0.8, 0.5]);
    const s = replayScore(t, { ...DEFAULT_EXPLORATION_POLICY, id: 'p', maxAttempts: 3 }, { beta1: 0.05, beta2: 0.02 });
    expect(s.maxReward).toBeCloseTo(0.8, 10);
    expect(s.attempts).toBe(3);
    expect(s.score).toBeCloseTo(0.8 - 0.05 * 3 + 0.02 * (3 / 3), 10);
  });

  it('truncates to policy.maxAttempts: a starved policy misses the late best', () => {
    const t = treeWithRewards('ep1', [0.1, 0.2, 0.9]);
    const starved = replayScore(t, { ...DEFAULT_EXPLORATION_POLICY, id: 's', maxAttempts: 1 });
    const patient = replayScore(t, { ...DEFAULT_EXPLORATION_POLICY, id: 'p', maxAttempts: 3 });
    expect(starved.maxReward).toBeCloseTo(0.1, 10);
    expect(patient.maxReward).toBeCloseTo(0.9, 10);
    expect(patient.score).toBeGreaterThan(starved.score);
  });

  it('keeps the incumbent on insufficient history (no fake learning)', () => {
    const thin: ReturnType<typeof treeWithRewards>[] = [];
    const out = selectExplorationPolicy(
      [{ ...DEFAULT_EXPLORATION_POLICY, id: 'challenger', maxAttempts: 5 }],
      DEFAULT_EXPLORATION_POLICY, thin,
    );
    expect(out.policy.id).toBe('default');
    expect(out.evidenceSufficient).toBe(false);
  });

  it('improves the exploration policy only with sufficient replay evidence', () => {
    // History where the best is always late: a larger budget wins on replay.
    const trees = [
      treeWithRewards('a', [0.1, 0.1, 0.9]),
      treeWithRewards('b', [0.1, 0.2, 0.85]),
    ];
    const out = selectExplorationPolicy(
      [{ ...DEFAULT_EXPLORATION_POLICY, id: 'patient', maxAttempts: 3, moduleSpread: 2 }],
      { ...DEFAULT_EXPLORATION_POLICY, maxAttempts: 1 },
      trees,
    );
    expect(out.evidenceSufficient).toBe(true);
    expect(out.policy.id).toBe('patient');
    // Monotone: a worse challenger never displaces the incumbent.
    const keep = selectExplorationPolicy(
      [{ ...DEFAULT_EXPLORATION_POLICY, id: 'starved', maxAttempts: 1, moduleSpread: 1 }],
      { ...DEFAULT_EXPLORATION_POLICY, id: 'inc', maxAttempts: 3 },
      trees,
    );
    expect(keep.policy.id).toBe('inc');
  });

  it('never mistakes replay for product verification', () => {
    const t = treeWithRewards('ep1', [0.9]);
    const s = replayScore(t, DEFAULT_EXPLORATION_POLICY);
    expect(isReplayProductVerification(s)).toBe(false);
    // Replay carries no externalPass / acceptance of its own.
    expect('externalPass' in s).toBe(false);
    expect('accept' in s).toBe(false);
  });

  it('compares policies on the same recorded samples (evaluatePolicies)', () => {
    const trees = [treeWithRewards('a', [0.3, 0.6]), treeWithRewards('b', [0.4, 0.5])];
    const { perPolicy } = evaluatePolicies(
      [DEFAULT_EXPLORATION_POLICY, { ...DEFAULT_EXPLORATION_POLICY, id: 'alt', maxAttempts: 1 }],
      trees,
    );
    expect(perPolicy).toHaveLength(2);
    expect(perPolicy.every((p) => p.samples === 2)).toBe(true);
  });
});
