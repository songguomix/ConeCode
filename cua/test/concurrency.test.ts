import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from '../src/fixtures/web-app.js';
import { RuntimeService } from '../src/service/runtime-service.js';
import { Monitor } from '../src/agent/monitor.js';
import { SessionStore } from '../src/store/store.js';
import { newId } from '../src/protocol/ids.js';
import { DEFAULT_BUDGET, nowIso, type Task } from '../src/protocol/schemas.js';

let fixture: FixtureServer;
let dir: string;
beforeAll(async () => {
  fixture = await startFixtureServer();
  dir = await mkdtemp(join(tmpdir(), 'cua-concurrency-'));
});
afterAll(async () => {
  await fixture.close();
  await rm(dir, { recursive: true, force: true });
});

function script(name: string) {
  return [
    { kind: 'delay', ms: 700 },
    { kind: 'tool', name: 'browser_fill', arguments: { target: { role: 'textbox', name: 'Project name' }, value: name } },
    { kind: 'tool', name: 'browser_click', arguments: { target: { role: 'button', name: 'Save' } } },
    { kind: 'tool', name: 'finish', arguments: { summary: 'done' } },
  ];
}

async function createTask(svc: RuntimeService, name: string, resourceKey: string) {
  return svc.createTask({
    goal: `Set ${name}`,
    acceptance: [{ kind: 'record_field', url: `${fixture.url}/api/projects/1`, path: ['name'], equals: name }],
    environment: { kind: 'browser', startUrl: fixture.url, headless: true, profile: 'default' },
    model: { provider: 'scripted', model: 'scripted-deterministic' },
    metadata: { resourceKeys: [resourceKey] },
    script: script(name),
  } as any);
}

function eventTime(svc: RuntimeService, taskId: string, type: string): number {
  const event = svc.getEvents(taskId).find((e) => e.type === type);
  return event ? Date.parse(event.at) : Number.NaN;
}

describe('coordination and monitoring', () => {
  it('serializes tasks that share a business resource while allowing other tasks to run in parallel', async () => {
    await fixture.reset();
    const svc = new RuntimeService({ dataDir: join(dir, 'shared'), recoverOnStart: false, monitorIntervalMs: 0, maxConcurrency: 2 });
    await svc.start();
    try {
      const a = await createTask(svc, 'One', 'project-1');
      const b = await createTask(svc, 'Two', 'project-1');
      const [fa, fb] = await Promise.all([svc.awaitTask(a.id, { timeoutMs: 60_000 }), svc.awaitTask(b.id, { timeoutMs: 60_000 })]);
      expect(fa.status).toBe('succeeded');
      expect(fb.status).toBe('succeeded');
      const first = eventTime(svc, a.id, 'task.started') < eventTime(svc, b.id, 'task.started') ? a : b;
      const second = first.id === a.id ? b : a;
      expect(eventTime(svc, second.id, 'task.started')).toBeGreaterThanOrEqual(eventTime(svc, first.id, 'task.finished'));
    } finally {
      await svc.close();
    }

    const svc2 = new RuntimeService({ dataDir: join(dir, 'parallel'), recoverOnStart: false, monitorIntervalMs: 0, maxConcurrency: 2 });
    await svc2.start();
    try {
      const c = await createTask(svc2, 'Demo', 'project-a');
      const d = await createTask(svc2, 'Demo', 'project-b');
      const [fc, fd] = await Promise.all([svc2.awaitTask(c.id, { timeoutMs: 60_000 }), svc2.awaitTask(d.id, { timeoutMs: 60_000 })]);
      expect(fc.status).toBe('succeeded');
      expect(fd.status).toBe('succeeded');
      const cs = eventTime(svc2, c.id, 'task.started');
      const ds = eventTime(svc2, d.id, 'task.started');
      const cf = eventTime(svc2, c.id, 'task.finished');
      const df = eventTime(svc2, d.id, 'task.finished');
      expect(cs).toBeLessThan(df);
      expect(ds).toBeLessThan(cf);
    } finally {
      await svc2.close();
    }
  });

  it('monitor consumes events read-only and detects repeated actions without touching the session', () => {
    const store = new SessionStore(':memory:');
    const taskId = newId('task');
    const runId = newId('run');
    const task: Task = {
      schemaVersion: 1, id: taskId, runId, goal: 'monitor', constraints: [],
      acceptance: [{ kind: 'custom', description: 'x' }], acceptanceSource: 'user',
      authorization: { allowedOrigins: [], allowedTools: [], allowDesktop: false, allowCode: false, allowedFileRoots: [], allowedRecipients: [] },
      budgets: DEFAULT_BUDGET, environment: { kind: 'browser', profile: 'default', headless: true }, status: 'observing',
      createdAt: nowIso(), updatedAt: nowIso(), version: 0, metadata: {},
    };
    store.createTask(task);
    for (let i = 0; i < 3; i++) {
      store.appendEvent({
        type: 'action.intent', actor: 'executor', taskId,
        payload: { tool: 'browser.click', action: { tool: 'browser.click', targetId: '1:main:1' } },
      });
    }
    const monitor = new Monitor(store, { repeatThreshold: 3 });
    const alerts = monitor.check();
    expect(alerts.some((a) => a.kind === 'repeat-action')).toBe(true);
    const monitorEvents = store.listEvents(taskId).filter((e) => e.type === 'monitor.alert');
    expect(monitorEvents.length).toBeGreaterThan(0);
    expect(store.listEvents(taskId).some((e) => e.type === 'observation.captured')).toBe(false);
    store.close();
  });
});
