import { describe, expect, it } from 'vitest';
import { TaskController } from '../src/agent/task-controller.js';
import { Planner } from '../src/agent/planner.js';
import { Executor } from '../src/agent/executor.js';
import { Verifier } from '../src/agent/verifier.js';
import { ScriptedAdapter, type ScriptStep } from '../src/model/scripted.js';
import { SessionStore } from '../src/store/store.js';
import { BudgetTracker, CancellationToken } from '../src/runtime/control.js';
import { newId } from '../src/protocol/ids.js';
import { TaskSchema, SessionSchema, nowIso, type ActionProposal, type Condition, type Observation } from '../src/protocol/schemas.js';
import { CuaError } from '../src/protocol/errors.js';
import { semanticActionSignature } from '../src/protocol/observation-utils.js';
import type { Driver } from '../src/drivers/types.js';

async function run(maxRetriesPerAction: number, script: ScriptStep[], mode: 'click-fails' | 'bad-fill-fails') {
  const store = new SessionStore(':memory:');
  const task = TaskSchema.parse({ schemaVersion: 1, id: newId('task'), runId: newId('run'), sessionId: newId('ses'),
    goal: 'Controller retry test', acceptance: [{ kind: 'text_visible', text: 'done' }], authorization: { allowedOrigins: ['http://fixture.local'] },
    budgets: { maxRetriesPerAction, maxSteps: 20, maxModelCalls: 20 }, environment: { kind: 'browser' },
    status: 'created', createdAt: nowIso(), updatedAt: nowIso(), version: 0,
  });
  const capabilities = { observe: true, screenshot: false, click: true, type: true, unicodeType: true, scroll: true, drag: false, key: true, tabs: false, code: false, actions: [], notes: [] };
  const session = SessionSchema.parse({ schemaVersion: 1, id: task.sessionId, taskId: task.id, runId: task.runId, kind: 'browser', lifecycle: 'starting', ownerId: 'test', fencingToken: 0, environment: {}, capabilities, createdAt: nowIso(), updatedAt: nowIso() });
  store.createTask(task); store.createSession(session);
  let observations = 0; let writes = 0; let done = false; let value = '';
  const seen: Observation[] = [];
  const driver: Driver = {
    kind: 'browser', start: async () => {}, close: async () => {}, surfaceId: () => 'tab_fixture', generation: () => 1, capabilities: () => capabilities,
    freshness: async () => ({ surfaceId: 'tab_fixture', generation: 1, url: 'http://fixture.local/project/1' }),
    observe: async () => {
      observations++;
      const obs: Observation = { schemaVersion: 1, id: newId('obs'), taskId: task.id, runId: task.runId, sessionId: session.id,
        surfaceId: 'tab_fixture', generation: 1, at: nowIso(), interface: { kind: 'browser', url: 'http://fixture.local/project/1' }, visibleText: done ? 'done' : 'pending',
        targets: [
          { targetId: `reference-${observations}-button`, frameId: 'main', role: 'button', name: 'Save', tag: 'button', visible: true, actionable: true, attributes: { id: 'save' } },
          { targetId: `reference-${observations}-field`, frameId: 'main', role: 'textbox', name: 'Project name', tag: 'input', value, visible: true, actionable: true, attributes: { id: 'name' } },
        ], frames: [], coverage: { textTruncated: false, targetsTruncated: false, hiddenTargets: 0, offscreenTargets: 0, crossOriginFrames: 0, shadowRoots: 0, openDialogs: 0, coverageNotes: [], unreadableRegions: [] }, redactions: [],
      }; seen.push(obs); return obs;
    },
    execute: async (proposal: ActionProposal) => {
      writes++;
      if (mode === 'click-fails' || (proposal.action.tool === 'browser.fill' && proposal.action.value === 'Bad')) {
        throw new CuaError('TARGET_NOT_FOUND', 'Deterministic driver failure before effect.');
      }
      if (proposal.action.tool === 'browser.fill') value = proposal.action.value;
      if (proposal.action.tool === 'browser.click') done = value === 'Demo';
      return { actual: {}, evidence: [] };
    },
    probe: async (condition: Condition) => ({ verdict: (condition.kind === 'value_equals' ? value === condition.value : done) ? 'pass' : 'fail', detail: 'deterministic fixture state' }),
  };
  const budget = new BudgetTracker(task.budgets);
  const controller = new TaskController({ task, session, store, driver, planner: new Planner(new ScriptedAdapter(script)), executor: new Executor(store, new Verifier()), verifier: new Verifier(), budget, cancellation: new CancellationToken() });
  await controller.start();
  const result = { task: store.requireTask(task.id), writes, observations: seen, budget: budget.snapshot(), events: store.listEvents(task.id) };
  store.close(); return result;
}
const click = (): ScriptStep => ({ kind: 'tool', name: 'browser_click', arguments: { target: { role: 'button', name: 'Save' } } });

describe('deterministic controller retry budgets', () => {
  it.each([0, 1, 2])('enforces maxRetriesPerAction=%i across fresh target references and repeated failures', async (limit) => {
    const result = await run(limit, Array.from({ length: 15 }, click), 'click-fails');
    expect(result.task.status).toBe('failed');
    expect(result.task.statusReason).toMatch(/retry budget/i);
    expect(result.writes).toBe(limit + 1);
    expect(result.budget.retries).toBe(limit);
    expect(result.observations.length).toBeGreaterThan(result.writes);
    expect(result.observations[0]!.targets[0]!.targetId).not.toBe(result.observations[1]!.targets[0]!.targetId);
  });

  it('allows correcting the input after a failure even with zero retries', async () => {
    const result = await run(0, [
      { kind: 'tool', name: 'browser_fill', arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Bad' } },
      { kind: 'tool', name: 'browser_fill', arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' } },
      click(), { kind: 'tool', name: 'finish', arguments: { summary: 'done' } },
    ], 'bad-fill-fails');
    expect(result.task.status).toBe('succeeded'); expect(result.writes).toBe(3);
  });

  it('scopes retry identities to the page, surface and business object', async () => {
    const result = await run(0, [click(), click()], 'click-fails');
    const a = result.observations[0]!; const b = result.observations[1]!;
    const action = (obs: Observation) => ({ tool: 'browser.click' as const, targetId: obs.targets[0]!.targetId, button: 'left' as const, clickCount: 1 });
    const key = semanticActionSignature(action(a), a, 'project-1');
    expect(semanticActionSignature(action(b), b, 'project-1')).toBe(key);
    expect(semanticActionSignature(action(b), { ...b, interface: { ...b.interface, url: 'http://fixture.local/project/2' } }, 'project-1')).not.toBe(key);
    expect(semanticActionSignature(action(b), { ...b, surfaceId: 'other-tab' }, 'project-1')).not.toBe(key);
    expect(semanticActionSignature(action(b), b, 'project-2')).not.toBe(key);
  });
});
