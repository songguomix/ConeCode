import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from '../src/fixtures/web-app.js';
import { RuntimeService } from '../src/service/runtime-service.js';
import { SessionStore } from '../src/store/store.js';
import { newId } from '../src/protocol/ids.js';
import { DEFAULT_BUDGET, nowIso, type ActionProposal, type Session, type Task } from '../src/protocol/schemas.js';

let fixture: FixtureServer;
const dirs: string[] = [];
beforeAll(async () => {
  fixture = await startFixtureServer();
});
afterAll(async () => {
  await fixture.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function seedCrashedTask(dir: string): Promise<{ taskId: string; sessionId: string; actionId: string }> {
  const store = new SessionStore(join(dir, 'runtime.db'));
  const taskId = newId('task');
  const runId = newId('run');
  const sessionId = newId('ses');
  const task: Task = {
    schemaVersion: 1,
    id: taskId,
    runId,
    goal: 'Recover a save that may already have happened.',
    constraints: [],
    acceptance: [{ kind: 'record_field', url: `${fixture.url}/api/projects/1`, method: 'GET', path: ['name'], equals: 'Demo' }],
    acceptanceSource: 'user',
    authorization: { allowedOrigins: [fixture.url], allowedTools: [], allowDesktop: false, allowCode: false, allowedFileRoots: [], allowedRecipients: [] },
    budgets: DEFAULT_BUDGET,
    environment: { kind: 'browser', startUrl: fixture.url, profile: 'default', headless: true },
    status: 'executing',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    version: 0,
    sessionId,
    metadata: {},
  };
  store.createTask(task);
  const session: Session = {
    schemaVersion: 1, id: sessionId, taskId, runId, kind: 'browser', environment: task.environment,
    lifecycle: 'active', ownerId: 'dead-worker', fencingToken: 3,
    capabilities: { observe: true, screenshot: true, click: true, type: true, unicodeType: true, scroll: true, drag: true, key: true, tabs: true, code: true, actions: [], notes: [] },
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  store.createSession(session);
  const action: ActionProposal = {
    schemaVersion: 1, id: newId('act'), taskId, runId, sessionId,
    observationId: newId('obs'), surfaceId: 'tab_dead', generation: 0,
    action: { tool: 'browser.click', targetId: '1:main:1', button: 'left', clickCount: 1 },
    expected: [], risk: 'reversible', requiresApproval: false, rationale: 'crash simulation',
    createdAt: nowIso(), attempts: 0,
  };
  store.recordActionIntent(action);
  store.close();
  return { taskId, sessionId, actionId: action.id };
}

describe('crash recovery and uncertain outcomes', () => {
  it.each([
    { persisted: true, expected: 'succeeded', name: 'commit happened but response was lost' },
    { persisted: false, expected: 'needs_attention', name: 'intent recorded then process died' },
  ])('$name', async ({ persisted, expected }) => {
    await fixture.reset();
    if (persisted) {
      await fetch(`${fixture.url}/api/projects/1`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Demo' }),
      });
    }
    const dataBefore = await fixture.readData();
    const dir = await mkdtemp(join(tmpdir(), 'cua-recovery-'));
    dirs.push(dir);
    const seeded = await seedCrashedTask(dir);
    const svc = new RuntimeService({ dataDir: dir, recoverOnStart: true, monitorIntervalMs: 0 });
    await svc.start();
    const final = svc.store.requireTask(seeded.taskId);
    expect(final.status).toBe(expected);
    const details = svc.getTask(seeded.taskId);
    expect(details.actions).toHaveLength(1);
    expect(details.actions[0]!.result?.status).toBe('unknown');
    expect(details.actions[0]!.result?.sideEffectUnknown).toBe(true);
    expect(details.events.some((e) => e.type === 'session.lost')).toBe(true);
    expect(details.session?.id).not.toBe(seeded.sessionId);
    expect(details.session?.lifecycle).toBe('closed');
    const dataAfter = await fixture.readData();
    expect(dataAfter).toEqual(dataBefore);
    await svc.close();
  });

  it('releases a stale lease only when expired and fences old owners', () => {
    const store = new SessionStore(':memory:');
    const sessionId = newId('ses');
    const first = store.acquireLease(sessionId, 'old', 50, Date.now());
    expect(() => store.acquireLease(sessionId, 'new', 50, Date.now())).toThrow(/owned by/);
    const second = store.acquireLease(sessionId, 'new', 50, Date.now() + 100);
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(() => store.renewLease(sessionId, 'old', first.fencingToken)).toThrow(/lease/i);
    store.close();
  });
});
