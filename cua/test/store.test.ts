import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/store/store.js';
import { newId } from '../src/protocol/ids.js';
import { nowIso, type ActionProposal, type Session, type Task } from '../src/protocol/schemas.js';
import { DEFAULT_BUDGET } from '../src/protocol/schemas.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  const id = newId('task');
  const runId = newId('run');
  const sessionId = newId('ses');
  return {
    schemaVersion: 1,
    id,
    runId,
    goal: 'test',
    constraints: [],
    acceptance: [{ kind: 'custom', description: 'done' }],
    acceptanceSource: 'user',
    authorization: { allowedOrigins: [], allowedTools: [], allowDesktop: false, allowCode: false, allowedFileRoots: [], allowedRecipients: [] },
    budgets: DEFAULT_BUDGET,
    environment: { kind: 'browser', profile: 'default', headless: true },
    status: 'created',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    version: 0,
    sessionId,
    metadata: {},
    ...overrides,
  };
}

function makeSession(task: Task): Session {
  return {
    schemaVersion: 1,
    id: task.sessionId!,
    taskId: task.id,
    runId: task.runId,
    kind: 'browser',
    environment: {},
    lifecycle: 'starting',
    ownerId: 'test',
    fencingToken: 1,
    capabilities: {
      observe: true, screenshot: true, click: true, type: true, unicodeType: true,
      scroll: true, drag: true, key: true, tabs: true, code: true, actions: [], notes: [],
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

describe('SessionStore', () => {
  it('stores tasks, enforces optimistic concurrency, and rejects invalid transitions', () => {
    const store = new SessionStore(':memory:');
    const task = makeTask();
    store.createTask(task, { type: 'task.created', actor: 'system' });
    expect(store.getTask(task.id)?.status).toBe('created');
    const observing = store.updateTask({ ...task, status: 'observing' }, { expectedVersion: 0 });
    expect(observing.version).toBe(1);
    expect(() => store.updateTask({ ...observing, status: 'succeeded' })).toThrow(/cannot move/);
    expect(() => store.updateTask({ ...observing, status: 'planning' }, { expectedVersion: 0 })).toThrow(/updated by another writer/);
    store.close();
  });

  it('writes intent before an action and can mark a crashed action UNKNOWN', () => {
    const store = new SessionStore(':memory:');
    const task = makeTask();
    store.createTask(task);
    const session = makeSession(task);
    store.createSession(session);
    const proposal: ActionProposal = {
      schemaVersion: 1,
      id: newId('act'),
      taskId: task.id,
      runId: task.runId,
      sessionId: session.id,
      observationId: newId('obs'),
      surfaceId: 'tab_1',
      generation: 0,
      action: { tool: 'browser.click', targetId: '1:main:0', button: 'left', clickCount: 1 },
      expected: [],
      risk: 'reversible',
      requiresApproval: false,
      rationale: 'test',
      createdAt: nowIso(),
      attempts: 0,
    };
    store.recordActionIntent(proposal);
    expect(store.listPendingActions(task.id)).toHaveLength(1);
    const recovered = store.markActionUnknown(proposal.id, 'simulated crash');
    expect(recovered.status).toBe('unknown');
    expect(recovered.result?.sideEffectUnknown).toBe(true);
    expect(store.listEvents(task.id).map((e) => e.type)).toContain('action.unknown');
    store.close();
  });

  it('redacts event payloads but preserves structural task state', () => {
    const store = new SessionStore(':memory:');
    const task = makeTask();
    store.createTask(task);
    store.appendEvent({
      type: 'model.error',
      actor: 'planner',
      taskId: task.id,
      payload: { apiKey: 'sk-1234567890abcdefghijkl', authorization: 'Bearer abcdefghijklmnop' },
    });
    const event = store.listEvents(task.id)[0]!;
    expect(event.payload.apiKey).toBe('[redacted]');
    expect(store.getTask(task.id)?.authorization).toEqual(task.authorization);
    store.close();
  });

  it('leases a session and prevents a second live owner', () => {
    const store = new SessionStore(':memory:');
    const lease = store.acquireLease('ses_00000000-0000-0000-0000-000000000001', 'owner-a', 60_000);
    expect(() => store.acquireLease(lease.sessionId, 'owner-b', 60_000)).toThrow(/owned by/);
    expect(() => store.renewLease(lease.sessionId, 'owner-b', lease.fencingToken)).toThrow(/lease/i);
    store.renewLease(lease.sessionId, 'owner-a', lease.fencingToken);
    store.releaseLease(lease.sessionId, 'owner-a', lease.fencingToken);
    expect(store.getLease(lease.sessionId)).toBeUndefined();
    store.close();
  });

  it('persists checkpoints and workflows', () => {
    const store = new SessionStore(':memory:');
    const task = makeTask();
    store.createTask(task);
    store.saveCheckpoint(task.id, task.runId, 'step', { step: 3, messages: [] });
    expect(store.latestCheckpoint(task.id)?.data.step).toBe(3);
    const workflow = store.upsertWorkflow('rename-project', { steps: ['fill', 'click'] });
    expect(workflow.version).toBe(1);
    expect(store.upsertWorkflow('rename-project', { steps: ['fill'] }).version).toBe(2);
    store.invalidateWorkflow('rename-project');
    expect(store.getWorkflow('rename-project')?.invalidatedAt).toBeTruthy();
    store.close();
  });
});
