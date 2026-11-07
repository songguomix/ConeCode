import { describe, expect, it } from 'vitest';
import { compareController } from '../src/agent/controller-benchmark.js';
import { RuntimeService } from '../src/service/runtime-service.js';
import { Planner } from '../src/agent/planner.js';
import { ScriptedAdapter } from '../src/model/scripted.js';
import { TaskSchema, ObservationSchema, nowIso } from '../src/protocol/schemas.js';
import { newId } from '../src/protocol/ids.js';

describe('full/projected controller comparison', () => {
  it('uses the same original acceptance and durable saves in both modes for ordinary and delayed pages', async () => {
    const report = await compareController();
    expect(report.sampleSize).toBe(4);
    expect(report.passed).toBe(4);
    expect(report.results.map((result) => result.observationMode)).toEqual(['full', 'projected', 'projected', 'full']);
    for (const scenario of ['ordinary_save', 'delayed_save']) {
      const pair = report.results.filter((result) => result.scenario === scenario);
      expect(pair).toHaveLength(2);
      expect(pair[0].acceptance).toEqual(pair[1].acceptance);
      expect(pair[0].budgets).toEqual(pair[1].budgets);
      for (const result of pair) {
        expect(result.status).toBe('succeeded');
        expect(result.acceptancePassed).toBe(true);
        expect(result.durableRecord).toEqual({ id: 1, name: 'Demo' });
        expect(result.modelRequestCount).toBe(3);
        expect(result.actionCount).toBe(2);
        expect(result.costUsd).toBeNull();
      }
    }
    expect(report.realModelCalls).toBe(0);
    expect(report.costUsd).toBeNull();
  });

  it('defaults the runtime to projected mode', async () => {
    const service = new RuntimeService({ dbPath: ':memory:' });
    try { expect(service.config.observationMode).toBe('projected'); }
    finally { await service.close(); }
  });

  it('actually sends full observation fields only in explicit baseline mode', async () => {
    const task = TaskSchema.parse({
      id: newId('task'), runId: newId('run'), goal: 'Read the fixture',
      acceptance: [{ kind: 'text_visible', text: 'Fixture' }], authorization: {}, budgets: {},
      environment: { kind: 'browser' }, status: 'planning', createdAt: nowIso(), updatedAt: nowIso(), version: 0,
    });
    const observation = ObservationSchema.parse({
      id: newId('obs'), taskId: task.id, runId: task.runId, sessionId: newId('ses'), surfaceId: 'fixture',
      generation: 1, at: nowIso(), interface: { kind: 'browser' }, visibleText: 'Fixture',
      targets: [{ targetId: 'target', frameId: 'main', role: 'button', name: 'Save', tag: 'button', visible: true, actionable: true, attributes: { fixtureBaselineField: 'full-observation-marker' } }],
      coverage: { textTruncated: false, targetsTruncated: false },
    });
    const captured: Record<string, string> = {};
    for (const observationMode of ['full', 'projected'] as const) {
      const adapter = new ScriptedAdapter([{ kind: 'tool', name: 'finish', arguments: { summary: 'Read only' } }]);
      await new Planner(adapter, { observationMode }).decide({
        task, observation, messages: [], driverKind: 'browser',
        driverCapabilities: { browser: true, desktop: false, code: false, images: false },
        step: 1, budget: { maxSteps: 5, maxModelCalls: 5, maxCostUsd: 0.1 }, finishAttempts: 0,
      });
      captured[observationMode] = JSON.stringify(adapter.requests[0].messages);
    }
    expect(captured.full).toContain('full-observation-marker');
    expect(captured.projected).not.toContain('full-observation-marker');
    expect(captured.projected).toContain('targetsOmittedFromModel');
    expect(task.acceptance).toEqual([{ kind: 'text_visible', text: 'Fixture', scope: 'page' }]);
  });
});
