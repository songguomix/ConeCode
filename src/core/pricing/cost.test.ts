import { describe, expect, it } from 'vitest';
import { buildCostSnapshot, formatCount, formatUSD, messageCost } from './cost';

describe('cost math', () => {
  it('prices a turn per 1M tokens', () => {
    // $3 in / $15 out: 1000 in + 1000 out = $0.018
    expect(messageCost(1000, 1000, { input: 3, output: 15 })).toBeCloseTo(0.018, 6);
    expect(messageCost(0, 0, { input: 3, output: 15 })).toBe(0);
  });

  it('returns null instead of guessing', () => {
    expect(messageCost(undefined, 10, { input: 3, output: 15 })).toBeNull();
    expect(messageCost(10, 10, undefined)).toBeNull();
    expect(messageCost(10, 10, { input: NaN, output: 1 })).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity, -1])('rejects invalid usage or prices (%s)', (invalid) => {
    expect(messageCost(invalid, 10, { input: 3, output: 15 })).toBeNull();
    expect(messageCost(10, invalid, { input: 3, output: 15 })).toBeNull();
    expect(messageCost(10, 10, { input: invalid, output: 15 })).toBeNull();
    expect(messageCost(10, 10, { input: 3, output: invalid })).toBeNull();
  });

  it('does not return an infinite cost when finite inputs overflow', () => {
    expect(messageCost(Number.MAX_VALUE, 10, { input: Number.MAX_VALUE, output: 15 })).toBeNull();
  });

  it('formats dollars and counts compactly', () => {
    expect(formatUSD(0.0042)).toBe('$0.0042');
    expect(formatUSD(0.5)).toBe('$0.500');
    expect(formatUSD(12.4)).toBe('$12.40');
    expect(formatCount(800)).toBe('800');
    expect(formatCount(1200)).toBe('1.2k');
    expect(formatCount(2500000)).toBe('2.50M');
  });

  it('snapshots spend, budget, and lock trips without guessing', () => {
    const turns = [
      { role: 'user', promptTokens: 0, completionTokens: 0 },
      { role: 'assistant', promptTokens: 1000, completionTokens: 1000, providerId: 'p', modelId: 'm' },
      { role: 'assistant', promptTokens: 500, completionTokens: 500, providerId: 'p', modelId: 'gone' },
    ];
    const pricingOf = (pid?: string, mid?: string) =>
      mid === 'm' ? { input: 3, output: 15 } : undefined;
    const open = buildCostSnapshot(turns, pricingOf, 0.5, false);
    expect(open).toContain('$0.018');
    expect(open).toContain('1 priced turns');
    expect(open).toContain('unknown pricing');
    expect(open).not.toContain('LOCK TRIPPED');
    const tripped = buildCostSnapshot(turns, pricingOf, 0.005, true);
    expect(tripped).toContain('LOCK TRIPPED');
    expect(tripped).not.toContain('remaining under lock');
  });

  it('trips strictly above twice the budget, not at the budget or exactly twice it', () => {
    const pricingOf = () => ({ input: 1, output: 0 });
    const snapshot = (promptTokens: number) => buildCostSnapshot(
      [{ role: 'assistant', promptTokens, completionTokens: 0 }], pricingOf, 0.01, true,
    );
    expect(snapshot(10_000)).not.toContain('LOCK TRIPPED');
    expect(snapshot(20_000)).not.toContain('LOCK TRIPPED');
    expect(snapshot(20_000)).toContain('remaining under lock (2× budget): $0');
    expect(snapshot(20_001)).toContain('LOCK TRIPPED');
  });

  it('excludes earlier conversation spending from this execution lock', () => {
    const turns = [{ role: 'assistant', promptTokens: 2_010_000, completionTokens: 0 }];
    const pricingOf = () => ({ input: 1, output: 0 });
    const snapshot = buildCostSnapshot(turns, pricingOf, 0.01, true, { startSpendUsd: 2 });
    expect(snapshot).toContain('spend so far: $2.01');
    expect(snapshot).toContain('execution spend since baseline: $0.0100');
    expect(snapshot).not.toContain('LOCK TRIPPED');
    expect(buildCostSnapshot(turns, pricingOf, 0.004, true, { startSpendUsd: 2 })).toContain('LOCK TRIPPED');
  });

  it('does not trip at exactly twice the budget after floating-point baseline subtraction', () => {
    const snapshot = buildCostSnapshot(
      [{ role: 'assistant', promptTokens: 2_020_000, completionTokens: 0 }],
      () => ({ input: 1, output: 0 }), 0.01, true, { startSpendUsd: 2 },
    );
    expect(snapshot).not.toContain('LOCK TRIPPED');
    expect(snapshot).toContain('remaining under lock (2× budget, this execution): $0');
  });

  it.each([NaN, Infinity, -1, 5])('does not turn an unusable baseline (%s) into a free execution', (baseline) => {
    const snapshot = buildCostSnapshot(
      [{ role: 'assistant', promptTokens: 10, completionTokens: 0 }],
      () => ({ input: 1, output: 0 }), 0.01, true, { startSpendUsd: baseline },
    );
    expect(snapshot).toContain('execution spend: unknown');
    expect(snapshot).toContain('lock assessment unavailable');
    expect(snapshot).not.toContain('remaining under lock');
  });

  it.each([NaN, Infinity, -1])('does not claim the lock is healthy with an invalid budget (%s)', (budget) => {
    const snapshot = buildCostSnapshot([], () => undefined, budget, true);
    expect(snapshot).toContain('lock assessment unavailable');
    expect(snapshot).not.toContain('remaining under lock');
  });
});
