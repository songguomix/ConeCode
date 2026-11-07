import { describe, expect, it } from 'vitest';
import { Planner } from '../src/agent/planner.js';
import { ScriptedAdapter } from '../src/model/scripted.js';
import { DEFAULT_BUDGET, nowIso, type Observation, type Task } from '../src/protocol/schemas.js';
import { newId } from '../src/protocol/ids.js';
import { toolsForCapabilities } from '../src/model/tools.js';

function task(): Task {
  const id = newId('task');
  return {
    schemaVersion: 1,
    id,
    runId: newId('run'),
    goal: 'rename',
    constraints: [],
    acceptance: [{ kind: 'text_visible', text: 'Saved' }],
    acceptanceSource: 'user',
    authorization: { allowedOrigins: ['http://127.0.0.1:1'], allowedTools: [], allowDesktop: false, allowCode: false, allowedFileRoots: [], allowedRecipients: [] },
    budgets: DEFAULT_BUDGET,
    environment: { kind: 'browser', profile: 'default', headless: true },
    status: 'observing',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    version: 0,
    metadata: {},
  };
}

function observation(): Observation {
  return {
    schemaVersion: 1,
    id: newId('obs'),
    taskId: 'task_00000000-0000-0000-0000-000000000001',
    runId: 'run_00000000-0000-0000-0000-000000000001',
    sessionId: 'ses_00000000-0000-0000-0000-000000000001',
    surfaceId: 'tab_1',
    generation: 1,
    at: nowIso(),
    interface: { kind: 'browser', url: 'http://127.0.0.1:1/' },
    visibleText: 'Project name Save',
    targets: [
      { targetId: '1:main:0', frameId: 'main', role: 'textbox', name: 'Project name', tag: 'input', type: 'text', value: 'Alpha', visible: true, actionable: true, attributes: {} },
      { targetId: '1:main:1', frameId: 'main', role: 'button', name: 'Save', tag: 'button', visible: true, actionable: true, attributes: {} },
      { targetId: '1:main:2', frameId: 'main', role: 'button', name: 'Open', tag: 'button', visible: true, actionable: true, attributes: {} },
      { targetId: '1:main:3', frameId: 'main', role: 'button', name: 'Open', tag: 'button', visible: true, actionable: true, attributes: {} },
    ],
    frames: [],
    coverage: { textTruncated: false, targetsTruncated: false, hiddenTargets: 0, offscreenTargets: 0, crossOriginFrames: 0, shadowRoots: 0, openDialogs: 0, coverageNotes: [], unreadableRegions: [] },
    redactions: [],
  };
}

function input(adapter: ScriptedAdapter) {
  return {
    task: task(),
    observation: observation(),
    messages: [],
    driverKind: 'browser' as const,
    driverCapabilities: { browser: true, desktop: false, code: false, images: false },
    step: 1,
    budget: { maxSteps: 10, maxModelCalls: 10, maxCostUsd: 1 },
    finishAttempts: 0,
  };
}

describe('Planner', () => {
  it('resolves a semantic target from the current observation and adds value_equals', async () => {
    const adapter = new ScriptedAdapter([
      { kind: 'tool', name: 'browser_fill', arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' } },
    ]);
    const decision = await new Planner(adapter).decide(input(adapter));
    expect(decision.kind).toBe('action');
    if (decision.kind !== 'action') return;
    expect(decision.action).toMatchObject({ tool: 'browser.fill', targetId: '1:main:0', value: 'Demo' });
    expect(decision.expected).toEqual([{ kind: 'value_equals', targetId: '1:main:0', value: 'Demo', withinMs: 3_000 }]);
  });

  it('refuses to guess between duplicate targets', async () => {
    const adapter = new ScriptedAdapter([
      { kind: 'tool', name: 'browser_click', arguments: { target: { role: 'button', name: 'Open' } } },
    ]);
    const decision = await new Planner(adapter).decide(input(adapter));
    expect(decision.kind).toBe('error');
    if (decision.kind === 'error') expect(decision.message).toMatch(/matched 2/);
  });

  it('uses an explicit ordinal for a duplicate target', async () => {
    const adapter = new ScriptedAdapter([
      { kind: 'tool', name: 'browser_click', arguments: { target: { role: 'button', name: 'Open', ordinal: 1 } } },
    ]);
    const decision = await new Planner(adapter).decide(input(adapter));
    expect(decision.kind).toBe('action');
    if (decision.kind === 'action') expect(decision.action).toMatchObject({ targetId: '1:main:3' });
  });

  it('rejects a target id that is not in the current observation', async () => {
    const adapter = new ScriptedAdapter([
      { kind: 'tool', name: 'browser_click', arguments: { targetId: '999:main:0' } },
    ]);
    const decision = await new Planner(adapter).decide(input(adapter));
    expect(decision.kind).toBe('error');
    if (decision.kind === 'error') expect(decision.message).toMatch(/not in the current observation/);
  });

  it('rejects invalid JSON and invalid action arguments before execution', async () => {
    const adapter = new ScriptedAdapter([{ kind: 'tool', name: 'browser_fill', arguments: { target: { role: 'textbox' }, value: 4 as any } }]);
    const decision = await new Planner(adapter).decide(input(adapter));
    expect(decision.kind).toBe('error');
  });

  it('turns finish into a proposal with parsed supplemental checks', async () => {
    const adapter = new ScriptedAdapter([
      {
        kind: 'tool',
        name: 'finish',
        arguments: { summary: 'done', suggestedChecks: [{ kind: 'text_visible', text: 'Saved' }, { kind: 'bogus' }] },
      },
    ]);
    const decision = await new Planner(adapter).decide(input(adapter));
    expect(decision.kind).toBe('finish');
    if (decision.kind === 'finish') {
      expect(decision.summary).toBe('done');
      expect(decision.suggestedChecks).toHaveLength(1);
    }
  });

  it('filters desktop/code tools when the session does not expose them', () => {
    const tools = toolsForCapabilities({ browser: true, desktop: false, code: false, images: false });
    expect(tools.some((t) => t.name === 'browser_click')).toBe(true);
    expect(tools.some((t) => t.name === 'desktop_click')).toBe(false);
    expect(tools.some((t) => t.name === 'run_code')).toBe(false);
    expect(tools.some((t) => t.name === 'finish')).toBe(true);
  });
});
