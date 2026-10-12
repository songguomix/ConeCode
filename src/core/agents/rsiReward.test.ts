import { describe, expect, it } from 'vitest';
import {
  REWARD_FAIL, breachesHardFloor, computeReward, isConverged, scaledDelta, selectCandidate,
  selectForArchive, dominates, paretoFront, bestOnEachMetric, combineJudgePanels,
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

  it('normalizes deltas by scale: seconds and error counts stop sharing one tanh', () => {
    // 10 seconds on a scale-10 metric == 0.01 on a scale-0.01 metric.
    const seconds = computeReward(episode({ metrics: [{ id: 'time', delta: 10, scale: 10 }] }));
    const ratio = computeReward(episode({ metrics: [{ id: 'rate', delta: 0.01, scale: 0.01 }] }));
    expect(seconds).toBeCloseTo(ratio, 10);
    // Same raw delta, different units → different rewards.
    const raw = computeReward(episode({ metrics: [{ id: 'x', delta: 10 }] }));
    expect(seconds).not.toBeCloseTo(raw, 2);
  });

  it('hard-fails a no-regression breach no matter what else improved', () => {
    const bad = episode({
      metrics: [
        { id: 'errors', delta: -5, minDelta: 0 },
        { id: 'speed', delta: 100, scale: 10 },
      ],
    });
    expect(breachesHardFloor(bad)).toEqual(['errors']);
    expect(computeReward(bad)).toBe(REWARD_FAIL);
    expect(scaledDelta({ id: 'x', delta: 10, scale: 4 })).toBe(2.5);
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

  it('vetoes on discipline 0 even with perfect other scores', () => {
    const risky = episode({
      metrics: [{ id: 'm', delta: 5 }],
      judges: { alignment: 1, simplicity: 1, discipline: 0 },
    });
    // Positive composite reward — but the veto fires before any comparison.
    expect(computeReward(risky)).toBeGreaterThan(0);
    expect(selectCandidate(risky, null, baseline)).toEqual({ accept: false, reason: 'discipline-veto' });
    expect(selectCandidate(risky, { reward: -100 }, baseline)).toEqual({ accept: false, reason: 'discipline-veto' });
  });

  it('fails closed on NaN or missing discipline', () => {
    const nan = episode({ judges: { alignment: 1, simplicity: 1, discipline: NaN } });
    expect(selectCandidate(nan, null, baseline)).toEqual({ accept: false, reason: 'discipline-veto' });
  });

  it('rejects hard-floor breaches with their own reason', () => {
    const bad = episode({ metrics: [{ id: 'errors', delta: -1, minDelta: 0 }] });
    expect(selectCandidate(bad, null, baseline)).toEqual({ accept: false, reason: 'hard-floor-breach' });
  });

  it('a vetoed panel combination cannot sneak through selection', () => {
    const combined = combineJudgePanels([
      { alignment: 1, simplicity: 1, discipline: 1 },
      { alignment: 1, simplicity: 1, discipline: 0 },
    ]);
    const d = selectCandidate(episode({ metrics: [{ id: 'm', delta: 2 }], judges: combined }), null, baseline);
    expect(d).toEqual({ accept: false, reason: 'discipline-veto' });
  });
});

describe('selectForArchive (one decision, four fates)', () => {
  const baseline = { reward: 0 };

  it('replaces best when strictly better', () => {
    const v = selectForArchive(
      { ...episode({ metrics: [{ id: 'm', delta: 0.9 }] }), externalPass: true },
      'c1', null, baseline, [],
    );
    expect(v).toEqual({ action: 'replace-best', reason: 'first-passing' });
  });

  it('retains a pareto-nondominated candidate that trails overall', () => {
    // Archive leads on speed; candidate is slower overall but best on memory.
    const archive = [{ id: 'fast', metrics: { speed: 0.9, mem: 0.0 } }];
    const best = { reward: 5 };
    const candidate = episode({
      metrics: [
        { id: 'speed', delta: 0.1 },
        { id: 'mem', delta: 0.8 },
      ],
    });
    const v = selectForArchive(candidate, 'lean', best, baseline, archive);
    expect(v).toEqual({ action: 'retain-frontier', reason: 'pareto-nondominated' });
  });

  it('rejects vetoes without consulting the archive', () => {
    const vetoed = episode({ judges: { alignment: 1, simplicity: 1, discipline: 0 } });
    expect(selectForArchive(vetoed, 'bad', null, baseline, []).action).toBe('reject');
    const failed = episode({ externalPass: false });
    expect(selectForArchive(failed, 'red', null, baseline, [])).toEqual({
      action: 'reject', reason: 'external-fail',
    });
  });

  it('rejects dominated candidates everywhere', () => {
    const archive = [{ id: 'fast', metrics: { speed: 0.9, mem: 0.8 } }];
    const best = { reward: 5 };
    const weak = episode({
      metrics: [
        { id: 'speed', delta: 0.1 },
        { id: 'mem', delta: 0.1 },
      ],
    });
    const v = selectForArchive(weak, 'mid', best, baseline, archive);
    expect(v.action).toBe('reject');
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
