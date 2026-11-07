import { describe, expect, it } from 'vitest';
import { runEvaluation } from '../src/eval.js';

describe('deterministic evaluation suite', () => {
  it('passes the baseline, failure-recovery and anti-false-success scenarios', async () => {
    const report = await runEvaluation({ scripted: true });
    expect(report.mode).toBe('scripted');
    expect(report.total).toBeGreaterThanOrEqual(4);
    expect(report.passed).toBe(report.total);
    expect(report.falseCompletionRate).toBe(0);
    expect(report.results.map((r) => r.name)).toEqual(
      expect.arrayContaining(['baseline_form_save', 'save_failure_then_recover', 'fake_success_rejected', 'budget_exhaustion_is_terminal']),
    );
    expect(report.note).toContain('not a real-model benchmark');
  }, 180_000);

  it('reports a missing real-model evaluation as not run instead of passing it', async () => {
    const report = await runEvaluation({ scripted: false, apiKeyEnv: 'CUA_MISSING_EVALUATION_CREDENTIAL' });
    expect(report.mode).toBe('real-model');
    expect(report.passed).toBe(0);
    expect(report.note).toMatch(/NOT marked as passed/);
    expect(report.status).toBe('not_run');
    expect(report.successRate).toBeNull();
  });

  const enabled = process.env.CUA_RUN_REAL_MODEL === '1' && Boolean(process.env.OPENAI_API_KEY && process.env.CUA_REAL_MODEL);
  it.skipIf(!enabled)('runs an explicitly selected real model through the browser and durable acceptance', async () => {
    const report = await runEvaluation({ scripted: false, maxModelCalls: 8, maxCostUsd: 0.5 });
    expect(report.mode).toBe('real-model');
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.results[0]?.modelCalls).toBeGreaterThan(0);
    expect(report.results[0]?.falseCompletion).toBe(false);
  }, 180_000);
});
