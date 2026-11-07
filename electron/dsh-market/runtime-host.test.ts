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
      export const name = 'needs-agents'
      export const inject = ['agents']
      export function apply() {}
    `);
    const host = new RuntimeHost();
    await host.start();
    const state = await host.load({
      id: 'needs-agents',
      name: 'needs-agents',
      title: 'Needs agents',
      format: 'dsh',
      packageDir: dir,
      rows: [{ id: 'row', name: 'needs-agents', entryPath: path.join(dir, 'inject.mjs'), config: {}, disabled: false }],
      enabled: true,
    });
    expect(state.status).toBe('missing-capability');
    expect(state.missing).toEqual(['agents']);
    await host.dispose();
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
