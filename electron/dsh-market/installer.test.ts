import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PackageInstaller } from './installer';
import { MarketStateStore } from './state';
import { RuntimeHost } from './runtime-host';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-installer-'));
  dirs.push(dir);
  return dir;
}

const example = path.join(process.cwd(), 'examples', 'native-plugins', 'hello-conecode');

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('native package lifecycle', () => {
  it('prepares, swaps in, loads and removes a bundled native plugin without npm', async () => {
    const root = tempDir();
    const state = new MarketStateStore(root);
    state.ensureProfileDirs('default');
    const installer = new PackageInstaller(state);
    const prepared = await installer.prepare({
      profileId: 'default',
      requestId: 'req-1',
      name: 'hello-conecode',
      version: '1.0.0',
      source: { type: 'bundled-example', path: example },
      onLog: () => {},
      signal: new AbortController().signal,
    });
    expect(prepared.format).toBe('native');
    expect(prepared.rows).toHaveLength(1);
    expect(prepared.integrity).toMatch(/^sha256-/);

    const swapped = installer.swapIn(prepared);
    expect(fs.existsSync(path.join(swapped.finalDir, 'conecode.plugin.json'))).toBe(true);
    expect(fs.existsSync(prepared.stagingDir)).toBe(false);

    const host = new RuntimeHost();
    await host.start();
    const stateLoaded = await host.load({
      id: prepared.name,
      name: prepared.name,
      title: prepared.name,
      format: 'native',
      packageDir: swapped.finalDir,
      nativeEntryPath: prepared.rows[0].entryPath.replace(prepared.stagingDir, swapped.finalDir),
      rows: [],
      enabled: true,
    });
    expect(stateLoaded.status).toBe('loaded');
    const result = await host.invokeTool(prepared.name, 'native', 'hello_conecode', { name: 'Grace' });
    expect(result.ok).toBe(true);
    await host.unload(prepared.name);
    await host.dispose();

    fs.rmSync(swapped.finalDir, { recursive: true, force: true });
    expect(fs.existsSync(swapped.finalDir)).toBe(false);
  }, 30_000);

  it('restores a previous directory when a swap is explicitly rolled back', async () => {
    const root = tempDir();
    const state = new MarketStateStore(root);
    state.ensureProfileDirs('default');
    const installer = new PackageInstaller(state);
    const prepared = await installer.prepare({
      profileId: 'default',
      requestId: 'req-2',
      name: 'hello-conecode',
      version: '1.0.0',
      source: { type: 'bundled-example', path: example },
      onLog: () => {},
      signal: new AbortController().signal,
    });
    const swapped = installer.swapIn(prepared);
    const marker = path.join(swapped.finalDir, 'only-in-new-version.txt');
    fs.writeFileSync(marker, 'new');
    const prepared2 = await installer.prepare({
      profileId: 'default',
      requestId: 'req-3',
      name: 'hello-conecode',
      version: '1.0.0',
      source: { type: 'bundled-example', path: example },
      onLog: () => {},
      signal: new AbortController().signal,
    });
    const swapped2 = installer.swapIn(prepared2);
    expect(swapped2.backupDir).toBeTruthy();
    expect(fs.existsSync(path.join(swapped2.finalDir, 'only-in-new-version.txt'))).toBe(false);
    installer.restore(swapped2.finalDir, swapped2.backupDir!);
    expect(fs.existsSync(path.join(swapped2.finalDir, 'only-in-new-version.txt'))).toBe(true);
  }, 30_000);
});
