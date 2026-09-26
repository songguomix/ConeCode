import { describe, expect, it } from 'vitest';
import {
  directionScore, isAcceptableDirection, pickBreakthrough, rankDirections,
  type BreakthroughDirection,
} from './rsiDirection';

function dir(partial: Partial<BreakthroughDirection> & { id: string }): BreakthroughDirection {
  return {
    title: partial.id,
    usefulCapability: 'user can resume a paused goal',
    metricId: 'test.passRate',
    expectedDelta: 0.3,
    evidenceStrength: 0.8,
    evidence: [{ ref: 'src/a.ts:1', note: 'failing suite points here' }],
    feasibility: 0.7,
    risk: 0.1,
    userValue: 0.8,
    module: 'product',
    ...partial,
  };
}

describe('directionScore / rankDirections', () => {
  it('prefers stronger evidence and lower risk on similar impact', () => {
    const solid = dir({ id: 'solid', evidenceStrength: 0.9, risk: 0.05 });
    const shaky = dir({ id: 'shaky', evidenceStrength: 0.3, risk: 0.4 });
    expect(directionScore(solid)).toBeGreaterThan(directionScore(shaky));
    expect(rankDirections([shaky, solid])[0].id).toBe('solid');
  });

  it('penalizes high-risk "flashy" directions', () => {
    const safe = dir({ id: 'safe', expectedDelta: 0.4, risk: 0.1 });
    const flashy = dir({ id: 'flashy', expectedDelta: 1.2, risk: 0.85, evidenceStrength: 0.9 });
    expect(directionScore(safe)).toBeGreaterThan(directionScore(flashy));
  });

  it('diminishes absurd expected deltas (tanh)', () => {
    const mild = directionScore(dir({ id: 'm', expectedDelta: 0.5 }));
    const wild = directionScore(dir({ id: 'w', expectedDelta: 50 }));
    expect(wild - mild).toBeLessThan(1);
  });
});

describe('isAcceptableDirection / pickBreakthrough', () => {
  it('rejects empty evidence or non-positive impact', () => {
    expect(isAcceptableDirection(dir({ id: 'x', evidence: [] }))).toBe(false);
    expect(isAcceptableDirection(dir({ id: 'y', expectedDelta: 0 }))).toBe(false);
  });

  it('rejects very high risk or very weak evidence', () => {
    expect(isAcceptableDirection(dir({ id: 'r', risk: 0.9 }))).toBe(false);
    expect(isAcceptableDirection(dir({ id: 'e', evidenceStrength: 0.1 }))).toBe(false);
  });

  it('picks the best acceptable breakthrough, or null when none qualify', () => {
    const good = dir({ id: 'good', expectedDelta: 0.6, evidenceStrength: 0.9 });
    const bad = dir({ id: 'bad', evidence: [], expectedDelta: 9 });
    expect(pickBreakthrough([bad, good])?.id).toBe('good');
    expect(pickBreakthrough([bad])).toBeNull();
    expect(pickBreakthrough([])).toBeNull();
  });

  it('requires a target metric id', () => {
    expect(isAcceptableDirection(dir({ id: 'm', metricId: '  ' }))).toBe(false);
  });

  it('rejects non-useful directions even if the metric looks good', () => {
    const vanity = dir({
      id: 'vanity',
      usefulCapability: 'rename',
      userValue: 0.1,
      expectedDelta: 2,
      evidenceStrength: 1,
    });
    expect(isAcceptableDirection(vanity)).toBe(false);
    const emptyCap = dir({ id: 'none', usefulCapability: '  ' });
    expect(isAcceptableDirection(emptyCap)).toBe(false);
  });

  it('useful capability outranks metric theater at equal evidence', () => {
    const useful = dir({ id: 'useful', userValue: 0.9, expectedDelta: 0.4, risk: 0.1 });
    const theater = dir({ id: 'theater', userValue: 0.55, expectedDelta: 0.9, risk: 0.1 });
    expect(directionScore(useful)).toBeGreaterThan(0);
    // Both may pass the bar, but rankDirections prefers higher userValue×impact.
    const ranked = rankDirections([theater, useful]);
    expect(ranked.length).toBe(2);
    expect(directionScore(useful)).toBeGreaterThan(directionScore(dir({ id: 'x', userValue: 0.55, expectedDelta: 0.4 })));
  });
});
