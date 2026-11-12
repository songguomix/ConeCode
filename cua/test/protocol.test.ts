import { describe, expect, it } from 'vitest';
import {
  ActionSchema,
  ConditionSchema,
  DEFAULT_BUDGET,
  EnvironmentSchema,
  TaskSchema,
  nowIso,
} from '../src/protocol/schemas.js';
import { canTransition, nextStatuses, assertTransition } from '../src/protocol/transitions.js';
import { redact, redactString } from '../src/protocol/redact.js';
import { assertObservationFresh, observationForModel } from '../src/protocol/observation-utils.js';
import { screenshotToViewport, viewportToScreenshot, pngDimensions } from '../src/drivers/browser/coordinates.js';
import { parseMacKeyCombo } from '../src/drivers/desktop/macos-keys.js';
import { CuaError } from '../src/protocol/errors.js';
import { actionToolFor, toolsForCapabilities } from '../src/model/tools.js';

describe('protocol schemas', () => {
  it('validates conditions and rejects malformed ones', () => {
    expect(ConditionSchema.parse({ kind: 'text_visible', text: 'Saved' }).scope).toBe('page');
    expect(ConditionSchema.safeParse({ kind: 'record_field', url: 'not a url', path: ['name'], equals: 'x' }).success).toBe(false);
    expect(ConditionSchema.safeParse({ kind: 'custom', description: 'visual judgement' }).success).toBe(true);
  });

  it('validates actions and applies safe defaults', () => {
    const click = ActionSchema.parse({ tool: 'browser.click', targetId: '1:main:0' });
    expect(click).toMatchObject({ button: 'left', clickCount: 1 });
    expect(ActionSchema.safeParse({ tool: 'browser.fill', value: 'x' }).success).toBe(false);
    expect(ActionSchema.safeParse({ tool: 'browser.navigate', url: 'file:///etc/passwd' }).success).toBe(false);
    expect(ActionSchema.safeParse({ tool: 'code.run', code: 'return 1;' }).success).toBe(true);
  });

  it('scopes desktop observation to one app window by default', () => {
    expect(EnvironmentSchema.parse({ kind: 'desktop' })).toMatchObject({ scope: 'app' });
    expect(EnvironmentSchema.parse({ kind: 'desktop', scope: 'display' }).scope).toBe('display');
    expect(EnvironmentSchema.safeParse({ kind: 'desktop', scope: 'screen' }).success).toBe(false);
    expect(EnvironmentSchema.parse({ kind: 'desktop', appName: 'TextEdit', windowTitle: 'notes' })).toMatchObject({
      scope: 'app',
      appName: 'TextEdit',
      windowTitle: 'notes',
    });
  });

  it('accepts accessibility desktop actions and rejects address-less presses', () => {
    expect(ActionSchema.parse({ tool: 'desktop.press', targetId: 'ax:0/1' })).toMatchObject({
      tool: 'desktop.press',
      targetId: 'ax:0/1',
    });
    expect(ActionSchema.safeParse({ tool: 'desktop.press', x: 10, y: 20 }).success).toBe(true);
    expect(ActionSchema.safeParse({ tool: 'desktop.press' }).success).toBe(false);
    expect(ActionSchema.safeParse({ tool: 'desktop.press', x: 10 }).success).toBe(false);
    expect(ActionSchema.safeParse({ tool: 'desktop.set_value', targetId: 'ax:0/1', value: 'text' }).success).toBe(true);
    expect(ActionSchema.safeParse({ tool: 'desktop.set_value', targetId: 'ax:0/1' }).success).toBe(false);
  });

  it('exposes the accessibility desktop tools to the model', () => {
    const tools = toolsForCapabilities({ browser: false, desktop: true, code: false, images: false });
    expect(tools.map((tool) => tool.name)).toContain('desktop_press');
    expect(tools.map((tool) => tool.name)).toContain('desktop_set_value');
    expect(actionToolFor('desktop_press')).toBe('desktop.press');
    expect(actionToolFor('desktop_set_value')).toBe('desktop.set_value');
  });

  it('requires non-empty user acceptance criteria', () => {
    const base = {
      schemaVersion: 1,
      id: 'task_00000000-0000-0000-0000-000000000001',
      runId: 'run_00000000-0000-0000-0000-000000000001',
      goal: 'x',
      constraints: [],
      acceptance: [],
      acceptanceSource: 'user',
      authorization: {},
      budgets: DEFAULT_BUDGET,
      environment: { kind: 'browser' },
      status: 'created',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      version: 0,
      metadata: {},
    };
    expect(TaskSchema.safeParse(base).success).toBe(false);
    expect(TaskSchema.safeParse({ ...base, acceptance: [{ kind: 'custom', description: 'done' }] }).success).toBe(true);
  });
});

describe('task state machine', () => {
  it('allows the normal loop and blocks impossible jumps', () => {
    expect(canTransition('created', 'observing')).toBe(true);
    expect(canTransition('observing', 'planning')).toBe(true);
    expect(canTransition('planning', 'executing')).toBe(true);
    expect(canTransition('executing', 'verifying_action')).toBe(true);
    expect(canTransition('verifying_action', 'observing')).toBe(true);
    expect(canTransition('observing', 'succeeded')).toBe(false);
    expect(canTransition('succeeded', 'observing')).toBe(false);
    expect(() => assertTransition('succeeded', 'observing')).toThrow(/cannot move/);
    expect(nextStatuses('succeeded')).toEqual([]);
  });

  it('supports conservative recovery paths', () => {
    expect(canTransition('executing', 'recovering')).toBe(true);
    expect(canTransition('recovering', 'needs_attention')).toBe(true);
    expect(canTransition('verifying_unknown', 'succeeded')).toBe(true);
  });
});

describe('redaction', () => {
  it('removes common credentials without corrupting ordinary fields', () => {
    const value = redact({
      authorization: 'Bearer abcdefghijklmnop',
      apiKey: 'sk-1234567890abcdefghijkl',
      maxInputTokens: 1234,
      nested: { password: 'hunter2', note: 'ghp_abcdefghijklmnopqrstuvwxyz' },
    }) as any;
    expect(value.authorization).toBe('[redacted]');
    expect(value.apiKey).toBe('[redacted]');
    expect(value.maxInputTokens).toBe(1234);
    expect(value.nested.password).toBe('[redacted]');
    expect(redactString('token=ghp_abcdefghijklmnopqrstuvwxyz')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
  });
});

describe('observation freshness', () => {
  const observation: any = {
    id: 'obs_00000000-0000-0000-0000-000000000001',
    surfaceId: 'tab_1',
    generation: 2,
    interface: { kind: 'browser', url: 'http://localhost/a' },
    screenshot: { scrollX: 0, scrollY: 0 },
    targets: [],
  };

  it('rejects generation, surface and scroll drift', () => {
    expect(() => assertObservationFresh(observation, { surfaceId: 'tab_1', generation: 2, url: 'http://localhost/a' })).not.toThrow();
    expect(() => assertObservationFresh(observation, { surfaceId: 'tab_2', generation: 2 })).toThrow(CuaError);
    expect(() => assertObservationFresh(observation, { surfaceId: 'tab_1', generation: 3 })).toThrow(/re-observe/);
    expect(() => assertObservationFresh(observation, { surfaceId: 'tab_1', generation: 2, scrollX: 0, scrollY: 100 })).toThrow(/scrolled/);
  });
});

describe('coordinate conversion', () => {
  const meta: any = {
    width: 2000,
    height: 1000,
    viewportWidth: 1000,
    viewportHeight: 500,
    scaleX: 2,
    scaleY: 2,
    offsetX: 100,
    offsetY: 50,
    scrollX: 0,
    scrollY: 0,
  };

  it('maps screenshot pixels through scale and crop offsets', () => {
    expect(screenshotToViewport([300, 250], meta)).toEqual({ x: 100, y: 100 });
    expect(viewportToScreenshot({ x: 100, y: 100 }, meta)).toEqual([300, 250]);
  });

  it('clamps outside points to the viewport', () => {
    expect(screenshotToViewport([-100, -100], meta)).toEqual({ x: 0, y: 0 });
    expect(screenshotToViewport([99999, 99999], meta)).toEqual({ x: 999, y: 499 });
  });

  it('reads PNG dimensions from the header', () => {
    const buffer = Buffer.alloc(24);
    buffer.write('PNG', 1, 'ascii');
    buffer.writeUInt32BE(640, 16);
    buffer.writeUInt32BE(480, 20);
    expect(pngDimensions(buffer)).toEqual({ width: 640, height: 480 });
  });

  it('rejects a non-PNG buffer', () => {
    expect(() => pngDimensions(Buffer.from('not a png'))).toThrow(/not a PNG/);
  });
});

describe('model observation projection', () => {
  it('marks omitted targets and text instead of pretending coverage is complete', () => {
    const observation: any = {
      id: 'obs_1',
      generation: 1,
      surfaceId: 'tab',
      interface: { kind: 'browser', url: 'http://x' },
      visibleText: 'x'.repeat(100),
      targets: Array.from({ length: 30 }, (_, i) => ({ targetId: `t${i}`, visible: true, role: 'button', name: `b${i}`, tag: 'button', attributes: {} })),
      coverage: { textTruncated: false, targetsTruncated: false },
    };
    const view: any = observationForModel(observation, 10, 20);
    expect(view.targets).toHaveLength(10);
    expect(view.coverage.targetsOmittedFromModel).toBe(20);
    expect(view.coverage.textOmittedFromModel).toBe(80);
  });
});

describe('macOS key parsing', () => {
  it('maps common combos and rejects unsafe junk', () => {
    expect(parseMacKeyCombo('Meta+S')).toMatchObject({ keyCode: 1, flags: 0x00100000 });
    expect(parseMacKeyCombo('cmd+shift+4')).toMatchObject({ keyCode: 21, flags: 0x00120000 });
    expect(parseMacKeyCombo('Return').keyCode).toBe(36);
    expect(() => parseMacKeyCombo('cmd+nonsense')).toThrow();
    expect(() => parseMacKeyCombo('a+b')).toThrow();
  });
});
