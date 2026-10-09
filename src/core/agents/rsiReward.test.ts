import { describe, expect, it } from 'vitest';
import {
  REWARD_FAIL, computeReward, isConverged, selectCandidate,
  dominates, paretoFront, bestOnEachMetric, combineJudgePanels,
  type EpisodeResult, type JudgeScores,
} from './rsiReward';

function episode(partial: Partial<EpisodeResult> = {}): EpisodeResult {
  return {
    externalPass: true,
    metrics: [{ id: 'test.passRate', delta: 0.2 }],
    judges: { alignment: 0.8, simplicity: 0.7, discipline: 0.9 },
    filesTouched: 3,
    linesChanged: 80,
    ...partial,
  };
}

describe('computeReward', () => {
  it('hard-fails when external criteria fail — judges cannot rescue', () => {
    const fail = episode({
      externalPass: false,
      judges: { alignment: 1, simplicity: 1, discipline: 1 },
      metrics: [{ id: 'x', delta: 5 }],
    });
    expect(computeReward(fail)).toBe(REWARD_FAIL);
  });

  it('ranks a metric improvement above a flat candidate', () => {
    const better = computeReward(episode({ metrics: [{ id: 'm', delta: 1 }] }));
    const flat = computeReward(episode({ metrics: [{ id: 'm', delta: 0 }] }));
    expect(better).toBeGreaterThan(flat);
  });

  it('ranks higher judge scores above lower ones when metrics tie', () => {
    const good = computeReward(episode({ judges: { alignment: 1, simplicity: 1, discipline: 1 } }));
    const poor = computeReward(episode({ judges: { alignment: 0.2, simplicity: 0.2, discipline: 0.2 } }));
    expect(good).toBeGreaterThan(poor);
  });

  it('penalizes blowing the cost budget', () => {
    const lean = computeReward(episode({ filesTouched: 2, linesChanged: 50 }));
    const fat = computeReward(episode({ filesTouched: 20, linesChanged: 2000 }));
    expect(lean).toBeGreaterThan(fat);
  });
});

describe('selectCandidate', () => {
  const baseline = { reward: 0 };

  it('rejects external failures outright', () => {
    const d = selectCandidate(episode({ externalPass: false }), null, baseline);
    expect(d).toEqual({ accept: false, reason: 'external-fail' });
  });

  it('accepts the first candidate that beats baseline', () => {
    const d = selectCandidate(episode({ metrics: [{ id: 'm', delta: 0.5 }] }), null, baseline);
    expect(d.accept).toBe(true);
  });

  it('rejects a candidate that does not beat the incumbent best', () => {
    const strong = episode({ metrics: [{ id: 'm', delta: 1 }], judges: { alignment: 1, simplicity: 1, discipline: 1 } });
    const best = { reward: computeReward(strong) };
    const d = selectCandidate(episode({ metrics: [{ id: 'm', delta: 0 }] }), best, baseline);
    expect(d.accept).toBe(false);
  });

  it('accepts strictly better than best (greedy improvement)', () => {
    const weak = episode({ metrics: [{ id: 'm', delta: 0.1 }] });
    const best = { reward: computeReward(weak) };
    const stronger = episode({
      metrics: [{ id: 'm', delta: 0.8 }],
      judges: { alignment: 1, simplicity: 1, discipline: 1 },
      filesTouched: 2,
      linesChanged: 40,
    });
    const d = selectCandidate(stronger, best, baseline);
    expect(d).toMatchObject({ accept: true, reason: 'improves-best' });
  });
});

describe('isConverged', () => {
  it('is not converged with a short history', () => {
    expect(isConverged([0.1, 0.2], 3)).toBe(false);
  });

  it('detects a plateau (local optimum)', () => {
    expect(isConverged([0.1, 0.5, 0.5, 0.5, 0.5], 3)).toBe(true);
  });

  it('is not converged while still improving', () => {
    expect(isConverged([0.1, 0.2, 0.3, 0.4, 0.5], 3)).toBe(false);
  });
});

describe('paretoFront (GEPA retention)', () => {
  const cands = [
    { id: 'fast', metrics: { speed: 0.9, mem: 0.1 } },
    { id: 'lean', metrics: { speed: 0.2, mem: 0.8 } },
    { id: 'mid', metrics: { speed: 0.5, mem: 0.5 } },
    { id: 'dominated', metrics: { speed: 0.1, mem: 0.05 } },
  ];

  it('keeps non-dominated candidates and drops dominated ones', () => {
    const ids = paretoFront(cands).map((c) => c.id);
    expect(ids).toContain('fast');
    expect(ids).toContain('lean');
    expect(ids).toContain('mid');
    expect(ids).not.toContain('dominated');
  });

  it('dominates is strict on at least one axis', () => {
    expect(dominates(cands[0], cands[3])).toBe(true);
    expect(dominates(cands[0], cands[1])).toBe(false);
    expect(dominates(cands[0], cands[0])).toBe(false);
  });

  it('names outright leaders per metric', () => {
    const best = bestOnEachMetric(cands);
    expect(best.speed).toEqual(['fast']);
    expect(best.mem).toEqual(['lean']);
  });
});

describe('combineJudgePanels (calibrated judging)', () => {
  const panel = (over: Partial<JudgeScores> = {}): JudgeScores => ({
    alignment: 0.8, simplicity: 0.7, discipline: 0.9, ...over,
  });

  it('is the identity for a single panel', () => {
    expect(combineJudgePanels([panel()])).toEqual(panel());
  });

  it('trims a loud outlier with 3+ panels', () => {
    const out = combineJudgePanels([panel(), panel(), panel({ alignment: 0.0 })]);
    // Trimmed mean of [0, 0.8, 0.8] drops min and max → 0.8.
    expect(out.alignment).toBeCloseTo(0.8, 5);
  });

  it('any discipline veto discards, even when outvoted', () => {
    const out = combineJudgePanels([panel(), panel(), panel({ discipline: 0 })]);
    expect(out.discipline).toBe(0);
  });
});
