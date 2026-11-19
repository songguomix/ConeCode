import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
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

    // A staging probe may pass while activation at the final path fails.
    const activate = vi.spyOn(service.runtime, 'load').mockResolvedValueOnce({
      id: 'hello-conecode', status: 'load-failed', error: 'final path failed',
    });
    try {
      await expect(service.install('default', 'hello-conecode', '1.0.0')).rejects.toThrow('final path failed');
      expect((await service.snapshot()).installed).toEqual([]);
    } finally {
      activate.mockRestore();
    }

    const installed = await service.install('default', 'hello-conecode', '1.0.0');
    expect(installed.status).toBe('loaded');
    expect(installed.format).toBe('native');
    expect(installed.contributions.tools.map((tool) => tool.name)).toEqual(['hello_conecode']);

    const tool = await service.invokeTool('default', 'hello-conecode', 'hello_conecode', { name: 'Ada' });
    expect(tool.ok).toBe(true);
    expect((tool.value as any).message).toContain('Ada');
    const command = await service.invokeCommand('default', 'hello-conecode', 'hello', 'ConeCode');
    expect(command.ok).toBe(true);
    await service.saveConfig('default', installed.id, { native: { greeting: 'Welcome' } });
    expect((await service.invokeTool('default', installed.id, 'hello_conecode', { name: 'Ada' })).value)
      .toMatchObject({ message: 'Welcome, Ada!' });

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
    expect((await service.invokeTool('default', 'hello-conecode', 'hello_conecode', { name: 'Restored' })).value)
      .toMatchObject({ message: 'Welcome, Restored!' });
    service.createProfile('separate');
    await service.switchProfile('separate');
    await expect(service.invokeTool('default', installed.id, 'hello_conecode', {})).rejects.toThrow('no longer active');
    await expect(service.setEnabled('default', installed.id, false)).rejects.toThrow('no longer active');
    await expect(service.saveConfig('default', installed.id, {})).rejects.toThrow('no longer active');
    await expect(service.contributions('default', installed.id)).rejects.toThrow('no longer active');
    await service.switchProfile('default');

    const packageDirBeforeUninstall = (await service.snapshot()).installed.find((plugin) => plugin.name === 'hello-conecode')!.packageDir;
    await service.uninstall('default', 'hello-conecode', false);
    expect(fs.existsSync(packageDirBeforeUninstall)).toBe(false);
    state = await service.snapshot();
    expect(state.installed.some((plugin) => plugin.name === 'hello-conecode')).toBe(false);
    const contributions = await service.contributions('default', 'hello-conecode');
    expect(contributions).toEqual({ tools: [], commands: [], skills: [] });
  }, 60_000);

  it('imports a linked native folder and preserves both versions if rollback activation fails', async () => {
    function packageAt(version: string, greeting: string): string {
      const source = path.join(tempRoot(), 'native');
      fs.cpSync(path.join(process.cwd(), 'examples', 'native-plugins', 'hello-conecode'), source, { recursive: true });
      const manifestFile = path.join(source, 'conecode.plugin.json');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, version }));
      const entry = path.join(source, 'index.mjs');
      const code = fs.readFileSync(entry, 'utf8').replace(": 'Hello';", ': defaultGreeting;');
      fs.writeFileSync(entry, `import defaultGreeting from './greeting.mjs';\n${code}`);
      fs.writeFileSync(path.join(source, 'greeting.mjs'), `export default ${JSON.stringify(greeting)};\n`);
      return source;
    }
    const original = await service.installLocal('default', packageAt('1.0.0', 'Old version'));
    const source = packageAt('1.1.0', 'New version');
    const linked = path.join(tempRoot(), 'linked');
    fs.symlinkSync(source, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service.inspectLocalPlugin(linked)).resolves.toMatchObject({ version: { version: '1.1.0' } });
    const updated = await service.installLocal('default', linked);
    expect(updated.entry).toBe(original.entry);
    const greet = async () => (await service.invokeTool('default', updated.id, 'hello_conecode', { name: 'Ada' })).value;
    expect(await greet()).toMatchObject({ message: 'New version, Ada!' });
    const backup = updated.backups.find((item) => item.version === original.version)!;
    // Old installations recorded only the backup directory, version and digest.
    service.state.patchPlugin('default', updated.id, { backups: [{ ...backup, installation: undefined }] });
    const activate = vi.spyOn(service.runtime, 'load').mockResolvedValueOnce({
      id: updated.id, status: 'load-failed', error: 'target activation failed',
    });
    try {
      await expect(service.rollback('default', updated.id, original.version)).rejects.toThrow('target activation failed');
    } finally {
      activate.mockRestore();
    }
    expect(fs.existsSync(backup.directory)).toBe(true);
    expect(service.state.installedByMarketId('default', updated.id)?.version).toBe(updated.version);
    expect(await greet()).toMatchObject({ message: 'New version, Ada!' });
    const rolledBack = await service.rollback('default', updated.id, original.version);
    expect(rolledBack.entry).toBe(original.entry);
    expect(rolledBack.manifestRaw.version).toBe(original.version);
    expect(rolledBack.integrity).toBe(original.integrity);
    expect(await greet()).toMatchObject({ message: 'Old version, Ada!' });
    expect((await service.rollback('default', updated.id, updated.version)).requestedSpec).toBe(updated.requestedSpec);
    await service.uninstall('default', updated.id);
  }, 30_000);

  it('keeps the last refresh error with its cached catalog across restarts', async () => {
    const directory = tempRoot();
    const file = path.join(directory, 'catalog.json');
    fs.copyFileSync('resources/dsh-market/catalog.json', file);
    const source = await service.addLocalSource(directory);
    fs.writeFileSync(file, 'invalid json');
    const [failed] = (await service.refreshSources(source.id)).filter((item) => item.id === source.id);
    expect(failed).toMatchObject({ stale: true, cachedEntries: source.cachedEntries, lastError: 'Catalog file is not valid JSON' });
    await service.state.flush();
    await service.runtime.shutdown();
    service = new DshMarketService({ rootDir: root, appPath: process.cwd(), versions: { app: 'test', electron: 'unknown' } });
    expect((await service.snapshot()).sources.find((item) => item.id === source.id)).toMatchObject(failed);
  });

  it('cancels oversized streamed catalogs before buffering the remaining chunks', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(chunk); },
      cancel,
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    try {
      const source = await service.addRemoteSource('https://catalog.example.test/large.json');
      expect(source.lastError).toContain('12.0 MiB limit');
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the cancelled install locked until cleanup without stopping other packages', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const prepare = vi.spyOn(service.installer, 'prepare').mockImplementationOnce(async (options) => {
      await wait;
      expect(options.signal.aborted).toBe(true);
      throw new Error('Cancelled');
    });
    const killAll = vi.spyOn(service.installer, 'killAll');
    try {
      const first = service.install('default', 'hello-conecode', '1.0.0');
      await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
      const running = service.state.operations().find((operation) => operation.pluginId === 'hello-conecode' && operation.phase === 'installing')!;
      service.cancel(running.requestId);
      await expect(service.install('default', 'hello-conecode', '1.0.0')).rejects.toThrow('already running');
      expect(killAll).not.toHaveBeenCalled();
      const rejected = expect(first).rejects.toThrow('Cancelled');
      release();
      await rejected;
      expect((await service.install('default', 'hello-conecode')).status).toBe('loaded');
      await service.uninstall('default', 'hello-conecode');
    } finally {
      release();
      prepare.mockRestore();
      killAll.mockRestore();
    }
  });
});
