import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/store/store.js';
import { WorkflowMemory } from '../src/agent/workflow-memory.js';
import { compactMessages, estimateChars } from '../src/agent/context.js';
import { newId } from '../src/protocol/ids.js';
import { DEFAULT_BUDGET, nowIso, type ActionProposal, type Observation, type Task } from '../src/protocol/schemas.js';
import type { ModelMessage } from '../src/model/types.js';
import { RuntimeService } from '../src/service/runtime-service.js';

function task(): Task {
  const id = newId('task');
  return {
    schemaVersion: 1, id, runId: newId('run'), goal: 'Rename project', constraints: [],
    acceptance: [{ kind: 'text_visible', text: 'Saved' }], acceptanceSource: 'user',
    authorization: { allowedOrigins: [], allowedTools: [], allowDesktop: false, allowCode: false, allowedFileRoots: [], allowedRecipients: [] },
    budgets: DEFAULT_BUDGET, environment: { kind: 'browser', profile: 'default', headless: true },
    status: 'succeeded', createdAt: nowIso(), updatedAt: nowIso(), version: 0, sessionId: newId('ses'), metadata: { workflowKey: 'rename-demo' },
  };
}

function observation(taskId: string, sessionId: string, runId: string): Observation {
  return {
    schemaVersion: 1, id: newId('obs'), taskId, runId, sessionId, surfaceId: 'tab', generation: 1, at: nowIso(),
    interface: { kind: 'browser', url: 'http://localhost/' }, visibleText: 'x', targets: [
      { targetId: '1:main:0', frameId: 'main', role: 'textbox', name: 'Project name', tag: 'input', visible: true, actionable: true, attributes: {} },
      { targetId: '1:main:1', frameId: 'main', role: 'button', name: 'Save', tag: 'button', visible: true, actionable: true, attributes: {} },
    ], frames: [],
    coverage: { textTruncated: false, targetsTruncated: false, hiddenTargets: 0, offscreenTargets: 0, crossOriginFrames: 0, shadowRoots: 0, openDialogs: 0, coverageNotes: [], unreadableRegions: [] },
    redactions: [],
  };
}

function proposal(task: Task, obs: Observation, action: any): ActionProposal {
  return {
    schemaVersion: 1, id: newId('act'), taskId: task.id, runId: task.runId, sessionId: task.sessionId!,
    observationId: obs.id, surfaceId: obs.surfaceId, generation: obs.generation, action,
    expected: [], risk: 'reversible', requiresApproval: false, rationale: '', createdAt: nowIso(), attempts: 0,
  };
}

describe('verified workflow memory', () => {
  it('learns semantic steps without target ids or coordinates, then can invalidate them', () => {
    const store = new SessionStore(':memory:');
    const t = task();
    store.createTask(t);
    const obs = observation(t.id, t.sessionId!, t.runId);
    store.saveObservation(obs);
    for (const action of [
      { tool: 'browser.fill', targetId: '1:main:0', value: 'Demo' },
      { tool: 'browser.click', targetId: '1:main:1', button: 'left', clickCount: 1 },
    ]) {
      const p = proposal(t, obs, action);
      store.recordActionIntent(p);
      store.recordActionResult({
        schemaVersion: 1, actionId: p.id, taskId: t.id, sessionId: t.sessionId!, status: 'succeeded',
        startedAt: nowIso(), endedAt: nowIso(), returned: true, sideEffectUnknown: false, actual: {}, evidence: [],
      });
    }
    const memory = new WorkflowMemory(store);
    const learned = memory.learn(t);
    expect(learned?.version).toBe(1);
    const hint = memory.lookup(t);
    expect(hint?.steps).toEqual([
      { tool: 'browser.fill', target: { role: 'textbox', name: 'Project name' }, value: 'Demo' },
      { tool: 'browser.click', target: { role: 'button', name: 'Save' } },
    ]);
    expect(JSON.stringify(hint)).not.toContain('1:main:0');
    memory.invalidate(t);
    expect(memory.lookup(t)).toBeUndefined();
    store.close();
  });

  it('expires hints using the configured age without deleting their records', () => {
    const store = new SessionStore(':memory:');
    try {
      const t = task();
      store.upsertWorkflow('rename-demo', { steps: [{ tool: 'browser.click', target: { name: 'Save', role: 'button' } }] }, new Date(Date.now() - 60_000).toISOString());
      const memory = new WorkflowMemory(store, { maxAgeMs: 30_000 });
      expect(memory.lookup(t)).toBeUndefined();
      expect(store.getWorkflow('rename-demo')?.invalidatedAt).toBeTruthy();
    } finally { store.close(); }
  });

  it('sanitizes legacy workflow fields and URL secrets before reuse without re-verifying them', () => {
    const store = new SessionStore(':memory:');
    try {
      const secret = 'sk-' + 'a'.repeat(32);
      const oldVerified = new Date(Date.now() - 1_000).toISOString();
      store.upsertWorkflow('rename-demo', {
        goal: `Save ${secret} at https://user:pass@example.test/path?token=custom-secret#secret-fragment`,
        acceptance: [{ kind: 'record_field', url: 'https://user:pass@example.test/api?access=custom-secret#secret-fragment', equals: secret }],
        steps: [{ tool: 'browser.navigate', url: 'https://user:pass@example.test/path?token=custom-secret#secret-fragment', target: { role: 'button', name: secret } }],
        password: 'plain-password',
      }, oldVerified);
      const memory = new WorkflowMemory(store);
      const listed = memory.list()[0]!;
      const json = JSON.stringify(listed);
      for (const value of [secret, 'user:pass', 'custom-secret', 'secret-fragment', 'plain-password']) expect(json).not.toContain(value);
      expect((listed.data.steps as any[])[0].url).toBe('https://example.test/path');
      expect(listed.lastVerifiedAt).toBe(oldVerified);
      expect(listed.version).toBe(1);
      expect(JSON.stringify(store.getWorkflow('rename-demo'))).toBe(json);
    } finally { store.close(); }
  });

  it('hashes sensitive legacy names and deletes only the explicitly selected workflow', () => {
    const store = new SessionStore(':memory:');
    try {
      const secret = 'sk-' + 'b'.repeat(32);
      store.upsertWorkflow(secret, { steps: [] });
      store.upsertWorkflow('keep-me', { steps: [] });
      const t = task();
      store.createTask(t);
      const memory = new WorkflowMemory(store);
      const migrated = memory.list().find((workflow) => workflow.name !== 'keep-me')!;
      expect(migrated.name).toMatch(/^wf_/);
      expect(store.getWorkflow(secret)).toBeUndefined();
      expect(memory.delete(migrated.name)).toBe(true);
      expect(memory.delete(migrated.name)).toBe(false);
      expect(memory.list().map((workflow) => workflow.name)).toEqual(['keep-me']);
      expect(store.requireTask(t.id).id).toBe(t.id);
      expect(store.listEvents().some((event) => event.type === 'workflow.deleted')).toBe(true);
    } finally { store.close(); }
  });

  it('accepts a service workflow age and rejects invalid values', async () => {
    expect(() => new RuntimeService({ dbPath: ':memory:', workflowMaxAgeMs: -1 })).toThrow(/workflowMaxAgeMs/);
    const service = new RuntimeService({ dbPath: ':memory:', workflowMaxAgeMs: 12_345 });
    try { expect(service.config.workflowMaxAgeMs).toBe(12_345); }
    finally { await service.close(); }
  });
});

describe('context compaction', () => {
  it('keeps the system prompt and recent tool pair without pretending omitted page state is current', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'start' },
      ...Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 === 0 ? 'assistant' : 'tool') as any, content: 'x'.repeat(5_000) })),
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'browser_fill', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: '{"status":"succeeded"}' },
    ];
    const result = compactMessages(messages, 20_000);
    expect(result.compacted).toBe(true);
    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[1]!.content).toContain('Context compacted');
    expect(result.messages.at(-2)?.role).toBe('assistant');
    expect(result.messages.at(-1)?.role).toBe('tool');
    expect(estimateChars(result.messages)).toBeLessThan(result.beforeChars);
    expect(JSON.stringify(result.messages)).toMatch(/re-observe/i);
  });
});
