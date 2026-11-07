import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { CodeRuntime, macSandboxProfile } from '../src/runtime/code-runtime.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../src/fixtures/web-app.js';
import { RuntimeService } from '../src/service/runtime-service.js';

const hasSandbox = (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) ||
  (process.platform === 'linux' && ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some(existsSync));
const runtimes: CodeRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes) await runtime.close();
});

async function runtime(): Promise<CodeRuntime> {
  const rt = new CodeRuntime();
  runtimes.push(rt);
  return rt;
}

const ui = async (method: string, args: Record<string, unknown>) => {
  if (method === 'observe') return { observationId: 'obs_test', visibleText: 'fake page', targets: [] };
  return { ok: true, method, args };
};

describe.runIf(hasSandbox)('persistent isolated code runtime (requires OS sandbox)', () => {
  it('persists explicit globalThis state and returns values/logs', async () => {
    const rt = await runtime();
    const first = await rt.run('globalThis.counter = (globalThis.counter || 0) + 1; console.log("first", globalThis.counter); return {counter: globalThis.counter};', { onUi: ui });
    expect(first.ok).toBe(true);
    expect(first.value).toEqual({ counter: 1 });
    const second = await rt.run('globalThis.counter += 1; return globalThis.counter;', { onUi: ui });
    expect(second.ok).toBe(true);
    expect(second.value).toBe(2);
    expect(second.logs).toEqual([]);
  });

  it('does not expose Node host globals and routes UI through RPC', async () => {
    const rt = await runtime();
    const result = await rt.run(
      'const obs = await ui.observe(); const clicked = await ui.click({targetId:"1:main:1"}); return {obs, clicked, processType: typeof process, requireType: typeof require, fetchType: typeof fetch};',
      { onUi: ui },
    );
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      obs: { observationId: 'obs_test' },
      clicked: { ok: true, method: 'click' },
      processType: 'undefined',
      requireType: 'undefined',
      fetchType: 'undefined',
    });
    const escaped = await rt.run('try { await import("node:fs"); return "escaped"; } catch (e) { return "blocked:" + e.name; }', { onUi: ui });
    expect(String(escaped.value)).toMatch(/blocked/);
  });

  it('terminates a timed-out run and reports that the process stopped', async () => {
    const rt = await runtime();
    const result = await rt.run('await new Promise(() => {});', { onUi: ui, timeoutMs: 300 });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.sessionLost).toBe(true);
    expect(result.error?.name).toBe('TimeoutError');
  });

  it('returns an error with partial action evidence when code throws after a UI call', async () => {
    const rt = await runtime();
    const executed: any[] = [];
    const result = await rt.run(
      'await ui.fill({targetId:"1:main:0", value:"Demo"}); throw new Error("stop here");',
      {
        onUi: async (method, args) => {
          executed.push({ method, args });
          return { ok: true };
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('stop here');
    expect(executed).toEqual([{ method: 'fill', args: { targetId: '1:main:0', value: 'Demo' } }]);
  });

  it('drains and serializes UI calls even if code omits await', async () => {
    const rt = await runtime();
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const result = await rt.run('ui.fill({value:"one"}); ui.click({}); return "body-returned";', {
      onUi: async (method) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        calls.push(method);
        active -= 1;
        return { ok: true };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['fill', 'click']);
    expect(maxActive).toBe(1);
  });

  it('does not allow a timer from a finished run to send UI actions later', async () => {
    const rt = await runtime();
    const calls: string[] = [];
    const onUi = async (method: string) => { calls.push(method); return { ok: true }; };
    await rt.run('setTimeout(() => ui.click({}), 80); return "scheduled";', { onUi });
    await rt.run('await new Promise(resolve => setTimeout(resolve, 200)); return "next-run";', { onUi });
    expect(calls).toEqual([]);
  });

  it('reports an in-flight host UI operation as not stopped after a code timeout', async () => {
    const rt = await runtime();
    let finish!: () => void;
    const hostOperation = new Promise<void>((resolve) => { finish = resolve; });
    const result = await rt.run('await ui.click({});', {
      onUi: async () => { await hostOperation; return { ok: true }; }, timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stopped).toBe(false);
    await expect(rt.run('return 1;', { onUi: ui })).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    finish();
  });

  it.runIf(process.platform === 'darwin')('enforces OS file and network denial without the Node permission model', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cua-os-outside-'));
    const scratch = await mkdtemp(join(tmpdir(), 'cua-os-scratch-'));
    const script = join(scratch, 'probe.mjs');
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'unreadable');
    await writeFile(script, `
import fs from 'node:fs';
import net from 'node:net';
const results = {};
try { fs.readFileSync(${JSON.stringify(secret)}); results.read = 'allowed'; } catch (e) { results.read = e.code; }
try { fs.writeFileSync(${JSON.stringify(join(outside, 'write.txt'))}, 'forbidden'); results.write = 'allowed'; } catch (e) { results.write = e.code; }
const socket = net.connect({ host: '127.0.0.1', port: 9 });
socket.on('connect', () => { results.network = 'allowed'; socket.destroy(); });
socket.on('error', error => { results.network = error.code; });
socket.on('close', () => { console.log(JSON.stringify(results)); });
`);
    try {
      const { stdout } = await promisify(execFile)('/usr/bin/sandbox-exec', [
        '-p', macSandboxProfile(process.execPath, script, scratch), process.execPath, script,
      ], { timeout: 5_000, env: { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch } });
      const result = JSON.parse(stdout);
      expect(result.read).toMatch(/EPERM|EACCES/);
      expect(result.write).toMatch(/EPERM|EACCES/);
      expect(result.network).toMatch(/EPERM|EACCES/);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'darwin')('keeps filesystem access restricted after a VM context escape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cua-code-secret-'));
    const path = join(dir, 'secret.txt');
    await writeFile(path, 'must-never-be-returned');
    try {
      const rt = await runtime();
      // Node vm is deliberately NOT the security boundary. Test a known host
      // constructor escape against the restrictions underneath it.
      const result = await rt.run(`
const childProcess = Object.constructor('return process')();
try {
  return childProcess.getBuiltinModule('fs').readFileSync(${JSON.stringify(path)}, 'utf8');
} catch (error) { return { blocked: true, code: error.code }; }
`, { onUi: ui });
      expect(result.value).not.toBe('must-never-be-returned');
      expect(result.value).toMatchObject({ blocked: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(hasSandbox)('code.run integration through the executor (requires OS sandbox)', () => {
  it('uses persistent UI RPCs, records every nested action, and verifies the task independently', async () => {
    const fixture = await startFixtureServer();
    await fixture.reset();
    const dir = await mkdtemp(join(tmpdir(), 'cua-code-agent-'));
    const svc = new RuntimeService({ dataDir: dir, recoverOnStart: false, monitorIntervalMs: 0 });
    await svc.start();
    try {
      const code = `
const obs = await ui.observe();
const field = obs.targets.find(t => t.role === 'textbox' && t.name === 'Project name');
if (!field) throw new Error('field not found');
await ui.fill({ targetId: field.targetId, value: 'CodeDemo' });
const save = obs.targets.find(t => t.role === 'button' && t.name === 'Save');
if (!save) throw new Error('save not found');
await ui.click({ targetId: save.targetId, expected: [
  { kind: 'text_visible', text: 'Saved successfully', withinMs: 5000 },
  { kind: 'record_field', url: '${fixture.url}/api/projects/1', path: ['name'], equals: 'CodeDemo', withinMs: 5000 }
] });
return { saved: true };
`;
      const task = await svc.createTask({
        goal: 'Rename with a short code group.',
        acceptance: [{ kind: 'record_field', url: `${fixture.url}/api/projects/1`, path: ['name'], equals: 'CodeDemo' }],
        environment: { kind: 'browser', startUrl: fixture.url, headless: true, profile: 'default' },
        authorization: { allowCode: true },
        model: { provider: 'scripted', model: 'scripted-deterministic' },
        metadata: { autoApproveCode: true },
        script: [
          { kind: 'tool', name: 'run_code', arguments: { code, timeoutMs: 20_000 } },
          { kind: 'tool', name: 'finish', arguments: { summary: 'done' } },
        ],
      } as any);
      const final = await svc.awaitTask(task.id, { timeoutMs: 60_000 });
      expect(final.status).toBe('succeeded');
      const details = svc.getTask(task.id);
      expect(details.actions.map((a) => a.proposal.action.tool)).toEqual(['code.run', 'browser.fill', 'browser.click']);
      expect(details.actions[0]!.result?.actual.uiActions).toHaveLength(2);
      expect((await fixture.readData()).projects[0]!.name).toBe('CodeDemo');
      expect(details.events.some((e) => e.type === 'code.started')).toBe(true);
    } finally {
      await svc.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// Missing isolation is an explicit rejected capability, not a simulated pass.
it.runIf(!hasSandbox)('fails closed when no supported OS code sandbox is available', async () => {
  const rt = await runtime();
  await expect(rt.start()).rejects.toMatchObject({ code: 'CODE_SANDBOX_UNAVAILABLE' });
});
