import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from '../src/fixtures/web-app.js';
import { RuntimeService } from '../src/service/runtime-service.js';

let fixture: FixtureServer;
let dir: string;
beforeAll(async () => {
  fixture = await startFixtureServer();
  dir = await mkdtemp(join(tmpdir(), 'cua-safety-'));
});
afterAll(async () => {
  await fixture.close();
  await rm(dir, { recursive: true, force: true });
});

describe('untrusted content and insufficient evidence', () => {
  it('does not let page instructions change the user goal or acceptance', async () => {
    await fixture.reset();
    const svc = new RuntimeService({ dataDir: join(dir, 'injection'), recoverOnStart: false, monitorIntervalMs: 0 });
    await svc.start();
    try {
      const task = await svc.createTask({
        goal: 'Set the project name to Demo and save it.',
        acceptance: [{ kind: 'record_field', url: `${fixture.url}/api/projects/1`, path: ['name'], equals: 'Demo' }],
        environment: { kind: 'browser', startUrl: `${fixture.url}/injection`, headless: true, profile: 'default' },
        model: { provider: 'scripted', model: 'scripted-deterministic' },
        script: [
          { kind: 'tool', name: 'browser_fill', arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' } },
          { kind: 'tool', name: 'browser_click', arguments: { target: { role: 'button', name: 'Save' }, expected: [{ kind: 'record_field', url: `${fixture.url}/api/projects/1`, path: ['name'], equals: 'Demo', withinMs: 5_000 }] } },
          { kind: 'tool', name: 'finish', arguments: { summary: 'saved Demo' } },
        ],
      } as any);
      const final = await svc.awaitTask(task.id, { timeoutMs: 30_000 });
      expect(final.status).toBe('succeeded');
      expect(final.goal).toContain('Demo');
      expect(final.acceptance).toEqual([{ kind: 'record_field', url: `${fixture.url}/api/projects/1`, method: 'GET', path: ['name'], equals: 'Demo' }]);
      expect((await fixture.readData()).projects[0]!.name).toBe('Demo');
    } finally {
      await svc.close();
    }
  });

  it('returns needs_attention when the acceptance criterion cannot be programmatically verified', async () => {
    const svc = new RuntimeService({ dataDir: join(dir, 'custom'), recoverOnStart: false, monitorIntervalMs: 0 });
    await svc.start();
    try {
      const task = await svc.createTask({
        goal: 'A visual judgement with no programmatic verifier.',
        acceptance: [{ kind: 'custom', description: 'looks good to a human' }],
        environment: { kind: 'browser', startUrl: fixture.url, headless: true, profile: 'default' },
        model: { provider: 'scripted', model: 'scripted-deterministic' },
        script: [{ kind: 'tool', name: 'finish', arguments: { summary: 'looks good' } }],
        budgets: { maxModelCalls: 3, maxSteps: 3 },
      } as any);
      const final = await svc.awaitTask(task.id, { timeoutMs: 30_000, stopAtPause: true });
      expect(final.status).toBe('needs_attention');
      expect(final.statusReason).toMatch(/insufficient_evidence|not accepted/i);
      expect(svc.getTask(task.id).verifications.some((v) => v.verdict === 'insufficient_evidence')).toBe(true);
    } finally {
      await svc.close();
    }
  });
});
