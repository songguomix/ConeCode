import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeHost, type RuntimePluginSpec } from './runtime-host';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-runtime-'));
  dirs.push(dir);
  return dir;
}

const example = path.join(process.cwd(), 'examples', 'native-plugins', 'hello-conecode');

function nativeSpec(): RuntimePluginSpec {
  return {
    id: 'hello-conecode',
    name: 'hello-conecode',
    title: 'Hello ConeCode',
    format: 'native',
    packageDir: example,
    nativeEntryPath: path.join(example, 'index.mjs'),
    rows: [],
    enabled: true,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Cordis runtime host', () => {
  it('loads the bundled native plugin, invokes its tool/command/skill and unwinds everything on unload', async () => {
    const host = new RuntimeHost();
    await host.start();
    const state = await host.load(nativeSpec());
    expect(state.status).toBe('loaded');
    expect(state.contributions?.tools.map((tool) => tool.name)).toEqual(['hello_conecode']);
    expect(state.contributions?.commands.map((command) => command.name)).toEqual(['hello']);
    expect(state.contributions?.skills.map((skill) => skill.name)).toEqual(['hello-conecode']);

    const tool = await host.invokeTool('hello-conecode', 'native', 'hello_conecode', { name: 'Ada' });
    expect(tool.ok).toBe(true);
    expect(tool.value).toMatchObject({ message: 'Hello, Ada!', plugin: 'hello-conecode' });

    const command = await host.invokeCommand('hello-conecode', 'native', 'hello', 'ConeCode');
    expect(command.ok).toBe(true);
    expect(command.rendered).toContain('Hello');
    expect(JSON.stringify(command.value)).toContain('ConeCode');

    const skills = await host.listSkills();
    expect(skills.some((skill) => skill.name === 'hello-conecode')).toBe(true);
    const content = await host.getSkill('hello-conecode', 'hello-conecode');
    expect(content?.content).toContain('Hello ConeCode');

    await host.unload('hello-conecode');
    expect(host.contributions()).toEqual({ tools: [], commands: [], skills: [] });
    await host.dispose();
  });

  it('fails a plugin that injects a service the host does not provide', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'inject.mjs'), `
      export const name = 'needs-unknown'
      export const inject = ['unknownHostService']
      export function apply() {}
    `);
    const host = new RuntimeHost();
    await host.start();
    const state = await host.load({
      id: 'needs-unknown',
      name: 'needs-unknown',
      title: 'Needs unknown',
      format: 'dsh',
      packageDir: dir,
      rows: [{ id: 'row', name: 'needs-unknown', entryPath: path.join(dir, 'inject.mjs'), config: {}, disabled: false }],
      enabled: true,
    });
    expect(state.status).toBe('missing-capability');
    expect(state.missing).toEqual(['unknownHostService']);
    await host.dispose();
  });

  it('provides full DSH host services (systemPrompt, sessions, shellEnv, webServer, fs, userApproval, scope, memory, connection, agents) and cleans up on unload', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'full-dsh.mjs'), `
      export const name = 'full-dsh-compat'
      export const inject = [
        'tools', 'systemPrompt', 'sessions', 'shellEnv',
        'webServer', 'fs', 'userApproval', 'scope', 'memory', 'connection', 'agents',
      ]
      export function apply(ctx) {
        ctx.systemPrompt.register({ id: 'mem-sec', content: 'Remember DSH rules', priority: 10 })
        ctx.shellEnv.register({ DSH_COMPAT_ACTIVE: '1' })
        ctx.webServer.get('/health', () => ({ ok: true }))
        ctx.memory.registerProvider({ name: 'local-mem', search: (q) => [{ q, hit: true }] })
        ctx.agents.register({ name: 'reviewer', description: 'Code reviewer' })
        const session = ctx.sessions.create({ id: 's1', title: 'demo' })
        ctx.sessions.appendEvent(session.id, { type: 'start' })
        ctx.tools.register({
          name: 'verify_dsh_services',
          description: 'Verify all extended DSH host services',
          execute: async () => ({
            sessionEvents: ctx.sessions.get('s1')?.events.length,
            memHits: await ctx.memory.search('test'),
            agentFound: ctx.agents.get('reviewer')?.name,
            approval: await ctx.userApproval.request({ action: 'read', danger: false }),
            connected: ctx.connection.isConnected(),
            profileId: ctx.scope.getProfileId(),
            hasFs: typeof ctx.fs.readFile === 'function',
          }),
        })
      }
    `);
    const host = new RuntimeHost();
    await host.start({ profileId: 'compat-test' });
    const state = await host.load({
      id: 'full-dsh-compat',
      name: 'full-dsh-compat',
      title: 'Full DSH Compat',
      format: 'dsh',
      packageDir: dir,
      rows: [{ id: 'main', name: 'full-dsh-compat', entryPath: path.join(dir, 'full-dsh.mjs'), config: {}, disabled: false }],
      enabled: true,
    });
    expect(state.status).toBe('loaded');
    expect(await host.listSystemPrompts()).toMatchObject([{ pluginId: 'full-dsh-compat', id: 'mem-sec', content: 'Remember DSH rules' }]);
    expect(await host.getShellEnv()).toEqual({ DSH_COMPAT_ACTIVE: '1' });
    expect(host.webServerInfo().routes).toEqual([{ pluginId: 'full-dsh-compat', method: 'GET', path: '/health' }]);

    const res = await host.invokeTool('full-dsh-compat', 'main', 'verify_dsh_services', {});
    expect(res.ok).toBe(true);
    expect(res.value).toMatchObject({
      sessionEvents: 1,
      memHits: [{ q: 'test', hit: true }],
      agentFound: 'reviewer',
      approval: { approved: true, decision: 'allow' },
      connected: true,
      profileId: 'compat-test',
      hasFs: true,
    });

    await host.unload('full-dsh-compat');
    expect(await host.listSystemPrompts()).toEqual([]);
    expect(await host.getShellEnv()).toEqual({});
    expect(host.webServerInfo().routes).toEqual([]);
    await host.dispose();
  });

  it('runs a bundle with a private service, including while probing an update', async () => {
    const dir = tempDir();
    const provider = path.join(dir, 'provider.mjs');
    const consumer = path.join(dir, 'consumer.mjs');
    fs.writeFileSync(provider, `
      export default function setup(ctx) {
        ctx.provide('bundleState', { value: 'from bundle' })
      }
    `);
    fs.writeFileSync(consumer, `
      export const inject = { bundleState: null, tools: null }
      export function apply(ctx) {
        ctx.tools.register({
          name: 'read_bundle', description: 'Read private service',
          execute: async () => ctx.bundleState.value,
        })
      }
    `);
    const rows = [consumer, provider].map((entryPath, index) => ({
      id: String(index), name: path.basename(entryPath), entryPath, config: {}, disabled: false,
    }));
    const spec: RuntimePluginSpec = {
      id: 'bundle', name: 'bundle', title: 'Bundle', format: 'dsh', packageDir: dir, rows, enabled: true,
    };
    const host = new RuntimeHost();
    try {
      expect((await host.load(spec)).status).toBe('loaded');
      expect((await host.probe(spec)).ok).toBe(true);
      expect(await host.invokeTool('bundle', null, 'read_bundle', {})).toMatchObject({
        ok: true, value: 'from bundle',
      });
      const unrelated = await host.load({ ...spec, id: 'unrelated', rows: [rows[0]] });
      expect(unrelated).toMatchObject({ status: 'missing-capability', missing: ['bundleState'] });
      await host.unload('bundle');
      expect(host.contributions().tools).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('dispatches by row, discovers skill providers on direct read and honors row-declared injects', async () => {
    const dir = tempDir();
    const entryPath = path.join(dir, 'skills.mjs');
    fs.writeFileSync(entryPath, `
      export function apply(ctx, { label }) {
        let creations = 0
        ctx.skills.registerProvider(({ signal }) => {
          const n = ++creations
          return {
            name: 'library',
            list: (options) => ({ candidates: [{ name: 'page', rank: 42, description: label }], complete: true }),
            get: (candidate, options) => ({ ...candidate, content: label + n + ':' + signal.aborted }),
          }
        })
        ctx.commands.register({ name: label, handler: async () => (await ctx.skills.get('page')).content })
      }
    `);
    const spec: RuntimePluginSpec = {
      ...nativeSpec(), format: 'dsh', id: 'library', packageDir: dir,
      rows: ['first', 'second'].map((label) => ({
        id: label, name: 'library', entryPath, disabled: false, config: { label }, inject: ['skills', 'commands'],
      })),
    };
    const host = new RuntimeHost();
    try {
      expect((await host.load(spec)).status).toBe('loaded');
      expect(await host.getSkill('library', 'page', 'second')).toMatchObject({ content: 'second1:false' });
      expect((await host.listSkills()).map(({ rowId, name }) => [rowId, name])).toEqual([['first', 'page'], ['second', 'page']]);
      expect(await host.invokeCommand('library', null, 'second', '')).toMatchObject({ ok: true, value: 'second1:false' });
      expect((await host.invokeCommand('library', 'first', 'second', '')).ok).toBe(false);
      expect(await host.getSkill('library', 'page', 'absent')).toBe(null);
      expect((await host.load({ ...spec, rows: [{ ...spec.rows[0], inject: ['missingService'] }] })).missing).toContain('missingService');
    } finally {
      await host.dispose();
    }
  });

  it('passes the saved native row config into activate and accepts inactive bundle rows', async () => {
    const spec = nativeSpec();
    const nativeRow = { id: 'native', name: spec.name, entryPath: spec.nativeEntryPath!, config: { greeting: 'Bonjour' }, disabled: false };
    const host = new RuntimeHost();
    try {
      expect((await host.load({ ...spec, rows: [nativeRow] })).status).toBe('loaded');
      expect((await host.invokeTool(spec.id, null, 'hello_conecode', { name: 'Ada' })).value).toMatchObject({ message: 'Bonjour, Ada!' });
      const disabled = await host.probe({ ...spec, format: 'dsh', rows: [{ ...nativeRow, disabled: true }] });
      expect(disabled).toMatchObject({ ok: true, state: { status: 'disabled' } });
      expect((await host.load({ ...spec, format: 'dsh', rows: [] })).status).toBe('loaded');
    } finally {
      await host.dispose();
    }
  });

  it.each([
    ['named activate', 'export { start as activate };'],
    ['default object', 'export default { activate: start };'],
    ['default function', 'export default start;'],
  ])('loads the native v1 facade through a %s export', async (_label, moduleExport) => {
    const dir = tempDir();
    const entry = path.join(dir, 'index.mjs');
    fs.writeFileSync(entry, `
      function start(api, config) {
        api.tools.register({
          name: 'inspect_native_api',
          execute() {
            return {
              plugin: api.plugin,
              config,
              commands: typeof api.commands.register,
              skills: typeof api.skills.registerProvider,
              logger: typeof api.logger.info,
            };
          },
        });
      }
      ${moduleExport}
    `);
    const host = new RuntimeHost();
    try {
      const spec = { ...nativeSpec(), packageDir: dir, nativeEntryPath: entry };
      expect((await host.load(spec)).status).toBe('loaded');
      expect(await host.invokeTool(spec.id, 'native', 'inspect_native_api', {})).toMatchObject({
        ok: true,
        value: {
          plugin: { id: spec.id, name: spec.name }, config: {},
          commands: 'function', skills: 'function', logger: 'function',
        },
      });
    } finally {
      await host.dispose();
    }
  });

  it('aborts native skill providers even if the plugin disposer throws', async () => {
    const dir = tempDir();
    const entry = path.join(dir, 'index.mjs');
    fs.writeFileSync(entry, `
      import { writeFileSync } from 'node:fs';
      export function activate(api) {
        api.skills.registerProvider(({ signal }) => {
          signal.addEventListener('abort', () => writeFileSync(new URL('./provider-aborted', import.meta.url), ''), { once: true });
          return {
            name: 'native-provider',
            list: () => [{ name: 'dynamic-skill' }],
            get: (candidate) => ({ ...candidate, content: 'Dynamic skill' }),
          };
        });
        return () => { throw new Error('native disposer failed'); };
      }
    `);
    const host = new RuntimeHost();
    try {
      const spec = { ...nativeSpec(), packageDir: dir, nativeEntryPath: entry };
      expect((await host.load(spec)).status).toBe('loaded');
      expect(await host.getSkill(spec.id, 'dynamic-skill')).toMatchObject({ content: 'Dynamic skill' });
      await host.unload(spec.id);
      expect(fs.existsSync(path.join(dir, 'provider-aborted'))).toBe(true);
      expect(await host.listSkills()).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('reports an activation throw as load-failed and leaves no contribution behind', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'broken.mjs'), `
      export const inject = ['tools']
      export function apply(ctx) {
        ctx.tools.register({ name: 'half', description: 'half registered', execute: async () => 'x' })
        throw new Error('boom during activation')
      }
    `);
    const host = new RuntimeHost();
    await host.start();
    const state = await host.load({
      id: 'broken',
      name: 'broken',
      title: 'Broken',
      format: 'dsh',
      packageDir: dir,
      rows: [{ id: 'row', name: 'broken', entryPath: path.join(dir, 'broken.mjs'), config: {}, disabled: false }],
      enabled: true,
    });
    expect(state.status).toBe('load-failed');
    expect(state.error).toContain('boom during activation');
    expect(host.contributions().tools).toEqual([]);
    await host.dispose();
  });

  it('probes a package without publishing its contributions', async () => {
    const host = new RuntimeHost();
    await host.start();
    const probe = await host.probe(nativeSpec());
    expect(probe.ok).toBe(true);
    expect(probe.state?.contributions?.tools).toHaveLength(1);
    expect(host.contributions().tools).toEqual([]);
    await host.dispose();
  });
});
