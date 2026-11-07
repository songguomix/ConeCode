import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from '../src/fixtures/web-app.js';
import { RuntimeService } from '../src/service/runtime-service.js';

let fixture: FixtureServer;
const dirs: string[] = [];

beforeAll(async () => {
  fixture = await startFixtureServer();
});
afterAll(async () => {
  await fixture.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function service(): Promise<RuntimeService> {
  const dir = await mkdtemp(join(tmpdir(), 'cua-controller-'));
  dirs.push(dir);
  const svc = new RuntimeService({ dataDir: dir, recoverOnStart: false, monitorIntervalMs: 0, headless: true });
  await svc.start();
  await fixture.reset();
  return svc;
}

function baseTask(goal: string, script: any[], extra: Record<string, unknown> = {}) {
  return {
    goal,
    acceptance: [{ kind: 'record_field' as const, url: `${fixture.url}/api/projects/1`, method: 'GET' as const, path: ['name'], equals: 'Demo' }],
    environment: { kind: 'browser' as const, startUrl: fixture.url, headless: true, profile: 'default' },
    model: { provider: 'scripted', model: 'scripted-deterministic' },
    script,
    ...extra,
  };
}

const fillSaveFinish = () => [
  { kind: 'tool', name: 'browser_fill', arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' } },
  { kind: 'tool', name: 'browser_click', arguments: { target: { role: 'button', name: 'Save' }, expected: [{ kind: 'record_field', url: `${fixture.url}/api/projects/1`, path: ['name'], equals: 'Demo', withinMs: 5_000 }] } },
  { kind: 'tool', name: 'finish', arguments: { summary: 'done' } },
];

async function waitFor(svc: RuntimeService, taskId: string, predicate: (task: any) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const details = svc.getTask(taskId);
    if (predicate(details.task.status)) return details;
    await new Promise((r) => setTimeout(r, 50));
  }
  return svc.getTask(taskId);
}

describe('TaskController through the real service', () => {
  it('asks the user, pauses execution, then resumes with the answer', async () => {
    const svc = await service();
    try {
      const task = await svc.createTask(
        baseTask('Ask which name to use, then save it.', [
          { kind: 'tool', name: 'ask_user', arguments: { question: 'Which project name should I use?' } },
          ...fillSaveFinish(),
        ]),
      );
      const waiting = await svc.awaitTask(task.id, { timeoutMs: 10_000, stopAtPause: true });
      expect(waiting.status).toBe('awaiting_user');
      expect(svc.getTask(task.id).controller?.awaitingUser?.question).toContain('Which project name');
      await svc.submitInput(task.id, { kind: 'answer', text: 'Use Demo, please.' });
      const final = await svc.awaitTask(task.id, { timeoutMs: 30_000 });
      expect(final.status).toBe('succeeded');
      expect((await fixture.readData()).projects[0]!.name).toBe('Demo');
    } finally {
      await svc.close();
    }
  });

  it('pauses between actions and resumes without losing the session', async () => {
    const svc = await service();
    try {
      const task = await svc.createTask(
        baseTask('Pause and resume.', [{ kind: 'delay', ms: 1_200 }, { kind: 'tool', name: 'browser_screenshot', arguments: {} }, ...fillSaveFinish()]),
      );
      await waitFor(svc, task.id, (s) => s === 'planning' || s === 'executing');
      await svc.pause(task.id);
      const paused = await waitFor(svc, task.id, (s) => s === 'paused', 5_000);
      expect(paused.task.status).toBe('paused');
      // Let the old model call fully return. The paused browser must remain alive.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(svc.getTask(task.id).session?.lifecycle).toBe('active');
      expect(svc.getTask(task.id).controller).toBeDefined();
      await Promise.all([svc.resume(task.id), svc.resume(task.id)]);
      const final = await svc.awaitTask(task.id, { timeoutMs: 30_000 });
      expect(final.status).toBe('succeeded');
      expect((await fixture.readData()).projects[0]!.name).toBe('Demo');
    } finally {
      await svc.close();
    }
  });

  it('cancels a fully paused task without writes or leaking the browser session', async () => {
    const svc = await service();
    try {
      const task = await svc.createTask(baseTask('Cancel while paused.', [{ kind: 'delay', ms: 300 }, ...fillSaveFinish()]));
      await waitFor(svc, task.id, (status) => status === 'planning');
      await svc.pause(task.id);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await svc.cancel(task.id);
      const final = await svc.awaitTask(task.id, { timeoutMs: 5_000 });
      expect(final.status).toBe('cancelled');
      expect(svc.getTask(task.id).actions).toHaveLength(0);
    } finally { await svc.close(); }
  });

  it('cancels a task during a model call without performing a write', async () => {
    const svc = await service();
    try {
      const task = await svc.createTask(
        baseTask('Cancel before writing.', [{ kind: 'delay', ms: 2_000 }, ...fillSaveFinish()]),
      );
      await waitFor(svc, task.id, (s) => s !== 'created', 5_000);
      await svc.cancel(task.id, 'test cancel');
      const final = await svc.awaitTask(task.id, { timeoutMs: 10_000 });
      expect(final.status).toBe('cancelled');
      expect(svc.getTask(task.id).actions).toHaveLength(0);
      expect((await fixture.readData()).projects[0]!.name).toBe('Alpha');
    } finally {
      await svc.close();
    }
  });

  it('supports takeover and release with ownership state and no silent writes', async () => {
    const svc = await service();
    try {
      const task = await svc.createTask(
        baseTask('Takeover and release.', [{ kind: 'delay', ms: 1_200 }, { kind: 'tool', name: 'browser_screenshot', arguments: {} }, ...fillSaveFinish()]),
      );
      await waitFor(svc, task.id, (s) => s === 'planning' || s === 'executing');
      await svc.takeover(task.id);
      const paused = await waitFor(svc, task.id, (s) => s === 'paused', 5_000);
      expect(paused.task.status).toBe('paused');
      const details = svc.getTask(task.id);
      expect(details.session?.lifecycle).toBe('taken_over');
      expect((await fixture.readData()).projects[0]!.name).toBe('Alpha');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(svc.getTask(task.id).session?.lifecycle).toBe('taken_over');
      await expect(svc.resume(task.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(svc.recoverTask(task.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      await svc.release(task.id);
      const final = await svc.awaitTask(task.id, { timeoutMs: 30_000 });
      expect(final.status).toBe('succeeded');
    } finally {
      await svc.close();
    }
  });


  it('recovers from an input validation error before saving', async () => {
    const svc = await service();
    try {
      const task = await svc.createTask(
        baseTask('Handle validation, then save Demo.', [
          { kind: 'tool', name: 'browser_fill', arguments: { target: { role: 'textbox', name: 'Project name' }, value: '' } },
          { kind: 'tool', name: 'browser_click', arguments: { target: { role: 'button', name: 'Save' }, expected: [{ kind: 'text_visible', text: 'Project name is required', withinMs: 3_000 }] } },
          ...fillSaveFinish(),
        ]),
      );
      const final = await svc.awaitTask(task.id, { timeoutMs: 30_000 });
      expect(final.status).toBe('succeeded');
      expect((await fixture.readData()).projects[0]!.name).toBe('Demo');
    } finally {
      await svc.close();
    }
  });

  it('does not report success when the model proposes completion but acceptance fails', async () => {
    const svc = await service();
    try {
      await fetch(`${fixture.url}/api/projects/1`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Alpha' }),
      });
      const task = await svc.createTask(
        baseTask(
          'The model is wrong about completion.',
          [{ kind: 'tool', name: 'finish', arguments: { summary: 'I claim it is done.' } }],
          {
            acceptance: [{ kind: 'record_field', url: `${fixture.url}/api/projects/1`, path: ['name'], equals: 'Demo' }],
            budgets: { maxModelCalls: 4, maxSteps: 4 },
          },
        ),
      );
      const final = await svc.awaitTask(task.id, { timeoutMs: 30_000 });
      expect(final.status).not.toBe('succeeded');
      expect((await fixture.readData()).projects[0]!.name).toBe('Alpha');
    } finally {
      await svc.close();
    }
  });
});
