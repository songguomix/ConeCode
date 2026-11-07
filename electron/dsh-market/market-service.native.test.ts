import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DshMarketService } from './market-service';

const workerBuilt = fs.existsSync(path.join(process.cwd(), 'dist-electron', 'dsh-worker.js'));
const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-market-native-'));
  roots.push(root);
  return root;
}

describe.skipIf(!workerBuilt)('DshMarketService native flow', () => {
  const root = tempRoot();
  let service = new DshMarketService({
    rootDir: root,
    appPath: process.cwd(),
    versions: { app: 'test', electron: process.versions.electron || 'unknown', chrome: process.versions.chrome },
  });

  afterAll(async () => {
    try { await service.runtime.shutdown(); } catch {}
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('installs, executes, disables, re-enables, restores and uninstalls the bundled native sample', async () => {
    await service.initialize();
    const detail = await service.detail('hello-conecode');
    expect(detail.plugin.demo).toBe(true);
    expect(detail.version.version).toBe('1.0.0');

    const installed = await service.install('default', 'hello-conecode', '1.0.0');
    expect(installed.status).toBe('loaded');
    expect(installed.format).toBe('native');
    expect(installed.contributions.tools.map((tool) => tool.name)).toEqual(['hello_conecode']);

    const tool = await service.invokeTool('default', 'hello-conecode', 'hello_conecode', { name: 'Ada' });
    expect(tool.ok).toBe(true);
    expect((tool.value as any).message).toContain('Ada');
    const command = await service.invokeCommand('default', 'hello-conecode', 'hello', 'ConeCode');
    expect(command.ok).toBe(true);

    const chatTools = await service.listChatTools();
    expect(chatTools.some((tool) => tool.name === 'hello_conecode')).toBe(true);
    expect(chatTools.some((tool) => tool.name === 'hello')).toBe(true);

    await service.setEnabled('default', 'hello-conecode', false);
    let state = await service.snapshot();
    expect(state.installed.find((plugin) => plugin.name === 'hello-conecode')?.contributions.tools).toEqual([]);
    await expect(service.invokeTool('default', 'hello-conecode', 'hello_conecode', { name: 'x' })).rejects.toThrow(/disabled/);

    await service.setEnabled('default', 'hello-conecode', true);
    expect((await service.invokeTool('default', 'hello-conecode', 'hello_conecode', { name: 'Grace' })).ok).toBe(true);

    await service.runtime.shutdown();
    service = new DshMarketService({
      rootDir: root,
      appPath: process.cwd(),
      versions: { app: 'test', electron: process.versions.electron || 'unknown', chrome: process.versions.chrome },
    });
    await service.initialize();
    state = await service.snapshot();
    expect(state.installed.some((plugin) => plugin.name === 'hello-conecode' && plugin.enabled)).toBe(true);
    expect((await service.invokeTool('default', 'hello-conecode', 'hello_conecode', { name: 'Restored' })).ok).toBe(true);

    const packageDirBeforeUninstall = (await service.snapshot()).installed.find((plugin) => plugin.name === 'hello-conecode')!.packageDir;
    await service.uninstall('default', 'hello-conecode', false);
    expect(fs.existsSync(packageDirBeforeUninstall)).toBe(false);
    state = await service.snapshot();
    expect(state.installed.some((plugin) => plugin.name === 'hello-conecode')).toBe(false);
    const contributions = await service.contributions('default', 'hello-conecode');
    expect(contributions).toEqual({ tools: [], commands: [], skills: [] });
  }, 60_000);
});
