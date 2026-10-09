import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CASCADE, recordStage, nextStage, cascadePassed,
  cascadeSpent, cascadeTotal, pickBestSample, type CascadeState,
} from './rsiCascade';
import { REWARD_FAIL } from './rsiReward';

const fresh = (): CascadeState => ({ done: [], stoppedAt: null });

describe('evaluation cascade (AlphaEvolve)', () => {
  it('walks stages cheapest-first and finishes only when all pass', () => {
    let s = fresh();
    expect(nextStage(DEFAULT_CASCADE, s)?.id).toBe('compile');
    s = recordStage(s, { stageId: 'compile', passed: true });
    expect(nextStage(DEFAULT_CASCADE, s)?.id).toBe('targeted');
    expect(cascadePassed(DEFAULT_CASCADE, s)).toBe(false);
    s = recordStage(s, { stageId: 'targeted', passed: true });
    s = recordStage(s, { stageId: 'full', passed: true });
    s = recordStage(s, { stageId: 'judges', passed: true });
    expect(cascadePassed(DEFAULT_CASCADE, s)).toBe(true);
    expect(nextStage(DEFAULT_CASCADE, s)).toBeNull();
  });

  it('stops at the first failure — expensive stages never run', () => {
    let s = recordStage(fresh(), { stageId: 'compile', passed: true });
    s = recordStage(s, { stageId: 'targeted', passed: false });
    expect(s.stoppedAt).toBe('targeted');
    expect(nextStage(DEFAULT_CASCADE, s)).toBeNull();
    expect(cascadePassed(DEFAULT_CASCADE, s)).toBe(false);
    // Further records are ignored once stopped.
    expect(recordStage(s, { stageId: 'full', passed: true }).done).toHaveLength(2);
    // Early exit spent 1+2 of 16 units.
    expect(cascadeSpent(DEFAULT_CASCADE, s)).toBe(3);
    expect(cascadeTotal(DEFAULT_CASCADE)).toBe(16);
  });
});

describe('pickBestSample (SEAL trial-and-error)', () => {
  it('keeps the best passing sample and skips hard fails', () => {
    const best = pickBestSample([
      { id: 'a', reward: 0.4, externalPass: true },
      { id: 'b', reward: REWARD_FAIL, externalPass: false },
      { id: 'c', reward: 0.9, externalPass: true },
    ]);
    expect(best?.id).toBe('c');
  });

  it('returns null when nothing passes', () => {
    expect(pickBestSample([
      { id: 'a', reward: 0.9, externalPass: false },
      { id: 'b', reward: REWARD_FAIL, externalPass: false },
    ])).toBeNull();
    expect(pickBestSample([])).toBeNull();
  });
});
