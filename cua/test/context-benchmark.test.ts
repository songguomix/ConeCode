import { describe, expect, it } from 'vitest';
import { compareContext } from '../src/agent/context-benchmark.js';

describe('live observation context comparison', () => {
  it('pairs the same real form/list/iframe observation and reports honest coverage and unavailable outcomes', async () => {
    const report = await compareContext({ repeats: 1 });
    expect(report.sampleSize).toBe(3);
    expect(report.samples.map((sample) => sample.scenario)).toEqual(['form', 'list', 'iframe']);
    expect(report.projectedChars).toBeLessThan(report.fullChars);
    expect(report.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const sample of report.samples) {
      expect(sample.observationId).toMatch(/^obs_/);
      expect(sample.screenshotBytes).toBeGreaterThan(0);
      expect(sample.observedTargets).toBeGreaterThan(1);
      expect(sample.projectedCoverage).toHaveProperty('targetsOmittedFromModel');
      expect(sample.forcedTrimCoverage).toMatchObject({ targetsOmittedFromModel: expect.any(Number), textOmittedFromModel: expect.any(Number) });
      expect((sample.forcedTrimCoverage as any).targetsOmittedFromModel).toBeGreaterThan(0);
    }
    expect(report.modelCalls).toBeNull();
    expect(report.costUsd).toBeNull();
    expect(report.taskSuccessRate).toBeNull();
    expect(report.fullControllerComparison).toBe('not_run');
  });
});
