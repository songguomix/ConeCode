import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeService } from '../src/service/runtime-service.js';
import { TaskSchema, nowIso } from '../src/protocol/schemas.js';
import { newId } from '../src/protocol/ids.js';

describe('runtime metrics', () => {
  it('counts read-only recovery success as verified and identifies unsupported success claims', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cua-metrics-'));
    const service = new RuntimeService({ dataDir: dir, recoverOnStart: false, monitorIntervalMs: 0 });
    try {
      for (const verified of [true, false]) {
        const task = TaskSchema.parse({
          id: newId('task'), runId: newId('run'), goal: 'Persist Demo',
          acceptance: [{ kind: 'text_visible', text: 'Demo' }], status: 'succeeded',
          authorization: {}, budgets: {}, version: 0,
          environment: { kind: 'browser' }, createdAt: nowIso(), updatedAt: nowIso(),
        });
        service.store.createTask(task);
        if (verified) {
          service.store.appendEvent({ type: 'model.request', actor: 'planner', taskId: task.id, payload: { call: 1 } });
          service.store.appendEvent({ type: 'model.error', actor: 'planner', taskId: task.id, payload: { message: 'lost response' } });
          service.store.appendEvent({ type: 'task.recovered', actor: 'system', taskId: task.id, payload: {} });
          service.store.saveVerification({
            schemaVersion: 1, id: newId('ver'), taskId: task.id, scope: 'recovery',
            criteria: task.acceptance, verdict: 'pass', evidence: [], missing: [], details: [],
            verifier: 'programmatic-test', at: nowIso(),
          });
        }
      }
      const metrics = service.metrics();
      expect(metrics.sampleSize).toBe(2);
      expect(metrics.recoveryCount).toBe(1);
      expect(metrics.recoverySuccessCount).toBe(1);
      expect(metrics.falseCompletionRate).toBe(0.5);
      expect(metrics.modelCalls).toBe(1); // attempts include errors with no response
      expect(metrics.note).toContain('do not measure duplicate GUI side effects');
    } finally {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
