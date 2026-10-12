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
    const tripped = buildCostSnapshot(turns, pricingOf, 0.01, true);
    expect(tripped).toContain('LOCK TRIPPED');
    expect(tripped).not.toContain('remaining under lock');
  });
});
