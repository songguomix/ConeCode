import { describe, expect, it } from 'vitest';
import { REWARD_FAIL, isLocalPlateau, pruneParetoArchive, selectForArchive, type EpisodeResult } from './rsiReward';

function episode(over: Partial<EpisodeResult> = {}): EpisodeResult {
  return {
    externalPass: true,
    metrics: [{ id: 'test.passRate', delta: 0.2 }],
    judges: { alignment: 0.8, simplicity: 0.7, discipline: 0.9 },
    filesTouched: 3, linesChanged: 80,
    ...over,
  };
}

describe('rsiReward hardening', () => {
  it('does not double-register a repeated candidate id', () => {
    const archive = [{ id: 'c1', metrics: { m: 0.9 } }];
    const best = { reward: 5 }; // forces the non-best path
    const weak = episode({ metrics: [{ id: 'm', delta: -0.5 }] });
    const v = selectForArchive(weak, 'c1', best, { reward: 0 }, archive);
    expect(v.action).toBe('reject');
    // A dominated-but-new id still rejects; an already-seen id never retains.
    expect(archive).toHaveLength(1);
  });

  it('prunes dominated archive members and keeps ties', () => {
    const pruned = pruneParetoArchive(
      [{ id: 'a', metrics: { x: 0.9, y: 0.1 } }, { id: 'b', metrics: { x: 0.2, y: 0.8 } }],
      { id: 'c', metrics: { x: 0.95, y: 0.85 } },
    );
    expect(pruned.map((c) => c.id)).toEqual(['c']);
  });

  it('ignores hard-fail sentinels in plateau detection', () => {
    // Two hard fails followed by flat passes: not a reward plateau, and the
    // hard-fail streak is handled by the loop stop (not here).
    expect(isLocalPlateau([REWARD_FAIL, REWARD_FAIL, 0.5, 0.5], 3)).toBe(false);
    expect(isLocalPlateau([0.1, 0.5, 0.5, 0.5, 0.5], 3)).toBe(true);
    expect(isLocalPlateau([0.1, 0.2], 3)).toBe(false);
  });

  it('hard gate still cannot be bought by judges (regression pin)', () => {
    const bad = episode({
      externalPass: true,
      metrics: [{ id: 'errors', delta: -5, minDelta: 0 }],
      judges: { alignment: 1, simplicity: 1, discipline: 1 },
    });
    expect(selectForArchive(bad, 'x', null, { reward: 0 }, []).action).toBe('reject');
  });
});
