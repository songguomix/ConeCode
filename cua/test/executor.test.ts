import { describe, expect, it } from 'vitest';
import { Executor } from '../src/agent/executor.js';
import { Verifier } from '../src/agent/verifier.js';
import { SessionStore } from '../src/store/store.js';
import { newId } from '../src/protocol/ids.js';
import {
  DEFAULT_BUDGET,
  nowIso,
  type Action,
  type ActionProposal,
  type Capabilities,
  type Observation,
  type Session,
  type Task,
} from '../src/protocol/schemas.js';
import type { Driver, DriverOutcome } from '../src/drivers/types.js';
import { BudgetTracker, CancellationToken } from '../src/runtime/control.js';

class FakeDriver implements Driver {
  readonly kind = 'browser' as const;
  executed: Action[] = [];
  constructor(private readonly options: { outcome?: DriverOutcome; generation?: number; onExecute?: () => void } = {}) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  surfaceId(): string {
    return 'tab_test';
  }
  generation(): number {
    return this.options.generation ?? 1;
  }
  capabilities(): Capabilities {
    return { observe: true, screenshot: true, click: true, type: true, unicodeType: true, scroll: true, drag: true, key: true, tabs: true, code: true, actions: [], notes: [] };
  }
  async observe(): Promise<Observation> {
    return observation();
  }
  async execute(proposal: ActionProposal): Promise<DriverOutcome> {
    this.executed.push(proposal.action);
    this.options.onExecute?.();
    return this.options.outcome ?? { actual: { ok: true }, evidence: [] };
  }
  async probe() {
    return { verdict: 'pass' as const, detail: 'fake pass' };
  }
  async freshness() {
    return { surfaceId: 'tab_test', generation: this.options.generation ?? 1, url: 'http://127.0.0.1:1/' };
  }
}

function task(overrides: Partial<Task> = {}): Task {
  const id = newId('task');
  const runId = newId('run');
  return {
    schemaVersion: 1, id, runId, goal: 'test', constraints: [],
    acceptance: [{ kind: 'text_visible', text: 'done' }], acceptanceSource: 'user',
    authorization: { allowedOrigins: ['http://127.0.0.1:1'], allowedTools: [], allowDesktop: false, allowCode: false, allowedFileRoots: [], allowedRecipients: [] },
    budgets: DEFAULT_BUDGET, environment: { kind: 'browser', profile: 'default', headless: true },
    status: 'executing', createdAt: nowIso(), updatedAt: nowIso(), version: 0, sessionId: newId('ses'), metadata: {},
    ...overrides,
  };
}

function session(t: Task): Session {
  return {
    schemaVersion: 1, id: t.sessionId!, taskId: t.id, runId: t.runId, kind: 'browser', environment: {},
    lifecycle: 'active', ownerId: 'test', fencingToken: 1,
    capabilities: { observe: true, screenshot: true, click: true, type: true, unicodeType: true, scroll: true, drag: true, key: true, tabs: true, code: true, actions: [], notes: [] },
    createdAt: nowIso(), updatedAt: nowIso(),
  };
}

function observation(t: Task = task()): Observation {
  return {
    schemaVersion: 1, id: 'obs_00000000-0000-0000-0000-000000000001', taskId: t.id,
    runId: t.runId, sessionId: t.sessionId!,
    surfaceId: 'tab_test', generation: 1, at: nowIso(), interface: { kind: 'browser', url: 'http://127.0.0.1:1/' },
    visibleText: 'done', targets: [
      { targetId: '1:main:0', frameId: 'main', role: 'button', name: 'Save', tag: 'button', visible: true, actionable: true, attributes: {} },
      { targetId: '1:main:1', frameId: 'main', role: 'button', name: 'Disabled', tag: 'button', visible: true, actionable: false, attributes: {} },
    ],
    frames: [], coverage: { textTruncated: false, targetsTruncated: false, hiddenTargets: 0, offscreenTargets: 0, crossOriginFrames: 0, shadowRoots: 0, openDialogs: 0, coverageNotes: [], unreadableRegions: [] }, redactions: [],
  };
}

function proposal(t: Task, action: Action): ActionProposal {
  return {
    schemaVersion: 1, id: newId('act'), taskId: t.id, runId: t.runId, sessionId: t.sessionId!,
    observationId: 'obs_00000000-0000-0000-0000-000000000001', surfaceId: 'tab_test', generation: 1,
    action, expected: [], risk: 'reversible', requiresApproval: false, rationale: '', createdAt: nowIso(), attempts: 0,
  };
}

describe('Executor preflight and result semantics', () => {
  it('records intent before the driver executes and records the result afterwards', async () => {
    const store = new SessionStore(':memory:');
    const t = task();
    store.createTask(t);
    store.createSession(session(t));
    let intentVisible = false;
    const driver = new FakeDriver({ onExecute: () => { intentVisible = store.listPendingActions(t.id).length === 1; } });
    const executor = new Executor(store, new Verifier());
    const result = await executor.execute({
      task: t, observation: observation(t), proposal: proposal(t, { tool: 'browser.click', targetId: '1:main:0', button: 'left', clickCount: 1 }),
      driver, budget: new BudgetTracker(t.budgets), cancellation: new CancellationToken(),
    });
    expect(intentVisible).toBe(true);
    expect(result.result.status).toBe('succeeded');
    expect(store.listActions(t.id)[0]!.result?.status).toBe('succeeded');
    store.close();
  });

  it('returns UNKNOWN and does not retry when the driver cannot determine the effect', async () => {
    const store = new SessionStore(':memory:');
    const t = task();
    store.createTask(t);
    store.createSession(session(t));
    const driver = new FakeDriver({ outcome: { actual: {}, evidence: [], sideEffectUnknown: true } });
    const executor = new Executor(store, new Verifier());
    const result = await executor.execute({
      task: t, observation: observation(t), proposal: proposal(t, { tool: 'browser.click', targetId: '1:main:0', button: 'left', clickCount: 1 }),
      driver, budget: new BudgetTracker(t.budgets), cancellation: new CancellationToken(),
    });
    expect(result.result.status).toBe('unknown');
    expect(result.result.sideEffectUnknown).toBe(true);
    expect(driver.executed).toHaveLength(1);
    store.close();
  });

  it('rejects an unauthorized origin before recording intent or calling the driver', async () => {
    const store = new SessionStore(':memory:');
    const t = task();
    store.createTask(t);
    store.createSession(session(t));
    const driver = new FakeDriver();
    const executor = new Executor(store, new Verifier());
    await expect(
      executor.execute({
        task: t, observation: observation(t), proposal: proposal(t, { tool: 'browser.navigate', url: 'https://evil.example/' }),
        driver, budget: new BudgetTracker(t.budgets), cancellation: new CancellationToken(),
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(driver.executed).toHaveLength(0);
    expect(store.listActions(t.id)).toHaveLength(0);
    store.close();
  });

  it('rejects expired authorization and stale observations before writing intent', async () => {
    const store = new SessionStore(':memory:');
    const t = task({ authorization: { ...task().authorization, expiresAt: new Date(Date.now() - 1_000).toISOString() } });
    store.createTask(t);
    store.createSession(session(t));
    const executor = new Executor(store, new Verifier());
    await expect(
      executor.execute({
        task: t, observation: observation(t), proposal: proposal(t, { tool: 'browser.click', targetId: '1:main:0', button: 'left', clickCount: 1 }),
        driver: new FakeDriver(), budget: new BudgetTracker(t.budgets), cancellation: new CancellationToken(),
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(store.listActions(t.id)).toHaveLength(0);
    store.close();
  });

  it('rejects a target that is disabled or absent in the observation', async () => {
    const store = new SessionStore(':memory:');
    const t = task();
    store.createTask(t);
    store.createSession(session(t));
    const executor = new Executor(store, new Verifier());
    await expect(
      executor.execute({
        task: t, observation: observation(t), proposal: proposal(t, { tool: 'browser.click', targetId: '1:main:1', button: 'left', clickCount: 1 }),
        driver: new FakeDriver(), budget: new BudgetTracker(t.budgets), cancellation: new CancellationToken(),
      }),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_ACTIONABLE' });
    await expect(
      executor.execute({
        task: t, observation: observation(t), proposal: proposal(t, { tool: 'browser.click', targetId: '9:main:9', button: 'left', clickCount: 1 }),
        driver: new FakeDriver(), budget: new BudgetTracker(t.budgets), cancellation: new CancellationToken(),
      }),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    expect(store.listActions(t.id)).toHaveLength(0);
    store.close();
  });

  it('rejects a mismatched observation, cancelled stored task, and user-owned session before driver execution', async () => {
    const store = new SessionStore(':memory:');
    const t = task(); store.createTask(t); store.createSession(session(t));
    const executor = new Executor(store, new Verifier());
    const driver = new FakeDriver();
    const input = { task: t, observation: observation(t), proposal: proposal(t, { tool: 'browser.click', targetId: '1:main:0', button: 'left', clickCount: 1 }), driver, budget: new BudgetTracker(t.budgets), cancellation: new CancellationToken() };
    await expect(executor.execute({ ...input, observation: { ...input.observation, sessionId: newId('ses') } })).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
    store.updateSession({ ...session(t), lifecycle: 'taken_over', ownerId: 'user' });
    await expect(executor.execute(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    store.updateSession(session(t));
    store.updateTask({ ...t, status: 'cancelled' });
    await expect(executor.execute(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(driver.executed).toHaveLength(0);
    expect(store.listActions(t.id)).toHaveLength(0);
    store.close();
  });

  it('does not record an intent when the step budget is already exhausted', async () => {
    const store = new SessionStore(':memory:'); const t = task(); store.createTask(t); store.createSession(session(t));
    const budget = new BudgetTracker({ ...t.budgets, maxSteps: 1 }); budget.addStep();
    const driver = new FakeDriver();
    await expect(new Executor(store, new Verifier()).execute({ task: t, observation: observation(t), proposal: proposal(t, { tool: 'browser.click', targetId: '1:main:0', button: 'left', clickCount: 1 }), driver, budget, cancellation: new CancellationToken() })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(store.listActions(t.id)).toHaveLength(0); expect(driver.executed).toHaveLength(0); store.close();
  });

  it('keeps nested UNKNOWN effects even if model code catches the error and returns successfully', async () => {
    const store = new SessionStore(':memory:');
    const t = task(); t.authorization.allowCode = true; store.createTask(t); store.createSession(session(t));
    let blocked = false;
    const codeRuntime: any = {
      run: async (_code: string, context: any) => {
        await context.onUi('click', { targetId: '1:main:0' }).catch(() => undefined);
        await context.onUi('click', { targetId: '1:main:0' }).catch(() => { blocked = true; });
        return { ok: true, value: 'caught', logs: [], durationMs: 1, timedOut: false, stopped: true, sessionLost: false, executedActions: [] };
      }, close: async () => {},
    };
    const driver = new FakeDriver({ outcome: { actual: {}, evidence: [], sideEffectUnknown: true } });
    const result = await new Executor(store, new Verifier(), { codeRuntime }).execute({ task: t, observation: observation(t), proposal: proposal(t, { tool: 'code.run', code: 'test', timeoutMs: 1000 }), driver, budget: new BudgetTracker(t.budgets), cancellation: new CancellationToken(), approved: true });
    expect(result.result.status).toBe('unknown'); expect(result.result.sideEffectUnknown).toBe(true);
    expect(blocked).toBe(true); expect(driver.executed).toHaveLength(1); expect(store.listActions(t.id)).toHaveLength(2);
    store.close();
  });

  it('tracks a timed-out driver action until its actual promise settles', async () => {
    const store = new SessionStore(':memory:'); const t = task(); store.createTask(t); store.createSession(session(t));
    const driver = new FakeDriver();
    let finish!: () => void;
    driver.execute = async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { actual: {}, evidence: [] }; };
    const executor = new Executor(store, new Verifier(), { writeTimeoutMs: 5 });
    const result = await executor.execute({ task: t, observation: observation(t), proposal: proposal(t, { tool: 'browser.click', targetId: '1:main:0', button: 'left', clickCount: 1 }), driver, budget: new BudgetTracker(t.budgets), cancellation: new CancellationToken() });
    expect(result.result.status).toBe('unknown'); expect(executor.hasInFlightActions()).toBe(true);
    finish(); await new Promise((resolve) => setTimeout(resolve, 0)); expect(executor.hasInFlightActions()).toBe(false); store.close();
  });

  it('allows an approved named TextEdit save across foreground drift but keeps coordinates fresh', async () => {
    const store = new SessionStore(':memory:');
    const t = task({ environment: { kind: 'desktop' }, authorization: { ...task().authorization, allowDesktop: true, allowedFileRoots: ['/tmp/cua-fixed-document'] } });
    store.createTask(t); store.createSession({ ...session(t), kind: 'desktop' });
    const obs = { ...observation(t), interface: { kind: 'desktop' as const, appName: 'TextEdit', windowTitle: 'Observed window' } };
    store.saveObservation(obs);
    const driver = new FakeDriver({ generation: 2 });
    Object.defineProperty(driver, 'kind', { value: 'desktop' });
    const executor = new Executor(store, new Verifier());
    const input = { task: t, observation: obs, proposal: proposal(t, { tool: 'desktop.edit_document', appName: 'TextEdit', content: 'Unicode 文本', savePath: '/tmp/cua-fixed-document/note.txt' }), driver, budget: new BudgetTracker(t.budgets), cancellation: new CancellationToken() };
    await expect(executor.execute(input)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const saved = await executor.execute({ ...input, approved: true });
    expect(saved.result.status).toBe('succeeded'); expect(driver.executed).toHaveLength(1);
    await expect(executor.execute({ ...input, proposal: proposal(t, { tool: 'desktop.click', x: 10, y: 10, button: 'left', clickCount: 1 }), approved: true })).rejects.toMatchObject({ code: 'OBSERVATION_STALE' });
    await expect(executor.execute({ ...input, proposal: proposal(t, { tool: 'desktop.type', text: 'wrong foreground' }), approved: true })).rejects.toMatchObject({ code: 'OBSERVATION_STALE' });
    await expect(executor.execute({ ...input, proposal: proposal(t, { tool: 'desktop.key', key: 'Enter' }), approved: true })).rejects.toMatchObject({ code: 'OBSERVATION_STALE' });
    const unregistered = { ...obs, id: newId('obs') };
    await expect(executor.execute({ ...input, observation: unregistered, proposal: { ...input.proposal, id: newId('act'), observationId: unregistered.id }, approved: true })).rejects.toMatchObject({ code: 'OBSERVATION_STALE' });
    expect(driver.executed).toHaveLength(1); store.close();
  });

  it('checks desktop file roots for app-scripting writes', async () => {
    const store = new SessionStore(':memory:');
    const t = task({
      environment: { kind: 'desktop' },
      authorization: { allowedOrigins: [], allowedTools: [], allowDesktop: true, allowCode: false, allowedFileRoots: ['/tmp/cua-allowed'], allowedRecipients: [] },
    });
    store.createTask(t);
    store.createSession(session(t));
    const executor = new Executor(store, new Verifier());
    await expect(
      executor.execute({
        task: t, observation: observation(t), proposal: proposal(t, { tool: 'desktop.edit_document', appName: 'TextEdit', content: 'x', savePath: '/tmp/not-allowed/x.txt' }),
        driver: new FakeDriver(), budget: new BudgetTracker(t.budgets), cancellation: new CancellationToken(),
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    store.close();
  });
});
