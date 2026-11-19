import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarketCatalog } from '../../src/core/dsh-market/types';
import { DshMarketService } from './market-service';

const roots: string[] = [];
const services: DshMarketService[] = [];

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-market-install-'));
  roots.push(dir);
  return dir;
}

function market(appPath = process.cwd()): DshMarketService {
  const service = new DshMarketService({
    rootDir: temp(), appPath, versions: { app: 'test', electron: process.versions.electron || 'node' },
  });
  services.push(service);
  return service;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const service of services.splice(0)) {
    await service.runtime.shutdown();
    await service.state.flush();
  }
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// The exact registry packages are required. This can also run from a warmed npm cache with npm_config_offline=true.
describe.skipIf(process.env.DSH_MARKET_INSTALL_E2E !== '1')('market installation through npm and Git', () => {
  it('accepts a matching catalog checksum and rejects a mismatch before probing the package', async () => {
    const app = temp();
    const catalogDir = path.join(app, 'resources', 'dsh-market');
    fs.mkdirSync(catalogDir, { recursive: true });
    const catalog = JSON.parse(fs.readFileSync('resources/dsh-market/catalog.json', 'utf8')) as MarketCatalog;
    const version = catalog.plugins.find((entry) => entry.name === 'dsh-plugin-error-radar')!.versions[0];
    const trueDigest = version.integrity;
    version.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
    fs.writeFileSync(path.join(catalogDir, 'catalog.json'), JSON.stringify(catalog));

    const unsafe = market(app);
    const probe = vi.spyOn(unsafe.runtime, 'probe');
    await expect(unsafe.install('default', 'dsh-plugin-error-radar', version.version, { allowScripts: true }))
      .rejects.toThrow('Package integrity mismatch');
    expect(probe).not.toHaveBeenCalled();
    expect((await unsafe.snapshot()).installed).toHaveLength(0);

    const valid = market();
    const installed = await valid.install('default', 'dsh-plugin-error-radar', version.version);
    expect(installed.integrity).toBe(trueDigest);
    expect(installed.requestedSpec).toBe(`dsh-plugin-error-radar@${version.version}`);
    expect((await valid.invokeCommand('default', installed.name, 'radar', '')).ok).toBe(true);
    await valid.uninstall('default', installed.name);
  }, 120_000);

  it('installs the previewed Git commit from a subdirectory even after the branch advances', async () => {
    const repo = temp();
    const url = 'https://example.test/conecode/plugin';
    const subdir = 'packages/demo';
    const plugin = path.join(repo, subdir);
    fs.mkdirSync(plugin, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'ConeCode test');
    git('config', 'user.email', 'test@example.test');
    git('config', 'commit.gpgsign', 'false');
    function commit(version: string): string {
      fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
        name: 'conecode-git-regression', version, exports: './index.mjs', dsh: { bundle: { patch: './patch.yml' } },
      }));
      fs.writeFileSync(path.join(plugin, 'index.mjs'), 'export function apply() {}\n');
      fs.writeFileSync(path.join(plugin, 'patch.yml'), '- insert:\n    - id: git-regression\n      name: conecode-git-regression\n');
      git('add', '.');
      git('commit', '-qm', version);
      return git('rev-parse', 'HEAD');
    }
    const firstCommit = commit('1.0.0');
    git('tag', '-a', 'stable', '-m', 'Annotated release');
    vi.stubEnv('GIT_CONFIG_COUNT', '3');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${pathToFileURL(repo).href}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', url);
    vi.stubEnv('GIT_CONFIG_KEY_1', `url.${pathToFileURL(repo).href}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_1', `${url}.git`);
    vi.stubEnv('GIT_CONFIG_KEY_2', 'protocol.file.allow');
    vi.stubEnv('GIT_CONFIG_VALUE_2', 'always');
    const service = market();
    const preview = await service.inspectRepository(url, 'main', subdir);
    expect(preview.commit).toBe(firstCommit);
    expect((await service.inspectRepository(url, 'stable', subdir)).commit).toBe(firstCommit);
    expect(commit('1.1.0')).not.toBe(firstCommit);
    await expect(service.installRepository('default', url, 'main', subdir)).rejects.toThrow('exact lowercase 40-character commit');
    const installed = await service.installRepository('default', preview.url, preview.commit, preview.subdir);
    expect(installed).toMatchObject({ version: '1.0.0', status: 'loaded', source: { commit: firstCommit, subdir } });
  }, 120_000);

  it('applies a patch-only layer to a subpath-only bundle across enable, rollback and uninstall', async () => {
    const service = market();
    const source = temp();
    const example = path.resolve('examples/dsh-plugins/hello-dsh');
    const manifest = JSON.parse(fs.readFileSync(path.join(example, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ ...manifest, exports: { './host': './host.mjs' } }));
    const code = fs.readFileSync(path.join(example, 'index.mjs'), 'utf8').replace(
      '  ctx.commands.register', "  if (config.greeting === 'invalid') throw new Error('invalid greeting');\n  ctx.commands.register",
    );
    fs.writeFileSync(path.join(source, 'host.mjs'), code);
    fs.writeFileSync(path.join(source, 'cordis.patch.yml'), JSON.stringify([
      { insert: [{ id: 'hello', name: manifest.name + '/host', config: { greeting: 'Original' } }] },
    ]));
    const base = await service.installLocal('default', source);
    const run = async () => (await service.invokeCommand('default', base.id, 'hello_dsh', 'DSH')).rendered;
    expect(await run()).toContain('Original');
    const layer = temp();
    function writeLayer(version: string, greeting: string) {
      fs.writeFileSync(path.join(layer, 'package.json'), JSON.stringify({
        name: 'greeting-override', version, dsh: { bundle: { patch: './patch.json' } },
      }));
      fs.writeFileSync(path.join(layer, 'patch.json'), JSON.stringify([{ id: 'hello', config: { greeting } }]));
    }
    writeLayer('1.0.0', 'First');
    const override = await service.installLocal('default', layer);
    expect(override.rows).toHaveLength(0);
    expect(await run()).toContain('First');
    await service.setEnabled('default', override.id, false);
    expect(await run()).toContain('Original');
    await service.setEnabled('default', override.id, true);
    expect(await run()).toContain('First');
    writeLayer('1.1.0', 'invalid');
    await expect(service.installLocal('default', layer)).rejects.toThrow('invalid greeting');
    expect(await run()).toContain('First');
    writeLayer('1.2.0', 'Second');
    await service.installLocal('default', layer);
    expect(await run()).toContain('Second');
    await service.rollback('default', override.id, '1.0.0');
    expect(await run()).toContain('First');
    await service.uninstall('default', override.id);
    expect(await run()).toContain('Original');
  }, 120_000);

  it('updates and rolls back a DSH plugin installed from checksum-verified archives', async () => {
    const service = market();
    const plugin = 'dsh-plugin-health';
    const first = await service.install('default', plugin, '3.0.4');
    expect(first.status).toBe('loaded');
    await service.setEnabled('default', plugin, false);
    const updated = await service.install('default', plugin, '3.0.5');
    expect(updated.status).toBe('disabled');
    expect(updated.integrity).not.toBe(first.integrity);
    const rolledBack = await service.rollback('default', plugin, first.version);
    expect(rolledBack).toMatchObject({ version: first.version, status: 'disabled', integrity: first.integrity });
    await service.setEnabled('default', plugin, true);
    expect((await service.invokeTool('default', plugin, 'plugin_health', { json: true })).ok).toBe(true);
    await service.uninstall('default', plugin);
  }, 120_000);
});
