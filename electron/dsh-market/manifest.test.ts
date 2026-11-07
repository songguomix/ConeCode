import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeCompatibility,
  evaluateDshRequirements,
  loadBundlePatches,
  readPackageManifest,
  resolvePackageEntry,
  type RawPackageManifest,
} from './manifest';
import { DSH_BASELINE } from '../../src/core/dsh-market/types';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-dsh-manifest-'));
  dirs.push(dir);
  return dir;
}

function writePackage(root: string, manifest: RawPackageManifest, files: Record<string, string>): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('DSH requirement evaluation', () => {
  it('uses engines.dsh alone when present, with prereleases included', () => {
    const manifest: RawPackageManifest = {
      name: 'a',
      version: '1.0.0',
      engines: { dsh: '>=0.2.2-0 <0.3.0' },
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0' },
    };
    const result = evaluateDshRequirements(manifest, '0.2.2-rc.1');
    expect(result.authoredRange).toBe('>=0.2.2-0 <0.3.0');
    expect(result.authoredKeys).toEqual(['engines.dsh']);
    expect(result.requirements).toEqual({});
  });

  it('falls back to every DSH peer and includes prerelease ranges', () => {
    const manifest: RawPackageManifest = {
      name: 'a',
      version: '1.0.0',
      peerDependencies: {
        '@deepseek-ai/dsh-tools': '^0.2.1-rc.1',
        '@deepseek-ai/dsh-skill': '^0.2.0-rc.2',
        unrelated: '^0.0.1',
      },
    };
    const result = evaluateDshRequirements(manifest, '0.2.2-rc.1');
    expect(result.requirements).toEqual({});
    expect(result.authoredKeys).toEqual(['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-skill']);
  });

  it('keeps the exact unmet peer range', () => {
    const manifest: RawPackageManifest = {
      name: 'dsh-find-plugin',
      version: '0.4.0',
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6 || ^0.1.7-alpha.1' },
    };
    const result = evaluateDshRequirements(manifest, '0.2.2-rc.1');
    expect(result.requirements).toEqual({ '@deepseek-ai/dsh-tools': '^0.1.0-rc.6 || ^0.1.7-alpha.1' });
  });

  it('treats malformed engines.dsh as a hard error', () => {
    expect(() => evaluateDshRequirements({ name: 'a', version: '1.0.0', engines: { dsh: 42 } }, '0.2.2-rc.1'))
      .toThrow('engines.dsh must be a string');
  });
});

describe('bundle patch loading', () => {
  it('applies patch files in declared order and overrides by id', () => {
    const root = tempDir();
    writePackage(root, {
      name: 'demo',
      version: '1.0.0',
      dsh: { bundle: { patch: ['./a.yml', './b.yml'] } },
    }, {
      'index.js': 'export function apply() {}',
      'a.yml': `- insert:\n    - id: demo-row\n      name: demo\n      config:\n        first: 1\n`,
      'b.yml': `- id: demo-row\n  config:\n    second: 2\n`,
    });
    const manifest = readPackageManifest(root);
    const loaded = loadBundlePatches(root, manifest);
    expect(loaded.files).toHaveLength(2);
    expect(loaded.rows).toHaveLength(1);
    expect(loaded.rows[0].id).toBe('demo-row');
    expect(loaded.rows[0].config).toEqual({ second: 2 });
  });

  it('rejects a patch path escaping the package', () => {
    const root = tempDir();
    writePackage(root, {
      name: 'demo',
      version: '1.0.0',
      dsh: { bundle: { patch: '../escape.yml' } },
    }, { 'index.js': '', 'escape.yml': '[]' });
    expect(() => loadBundlePatches(root, readPackageManifest(root))).toThrow('escapes the package');
  });

  it('rejects packages without a dsh.bundle declaration', () => {
    const root = tempDir();
    writePackage(root, { name: 'lib', version: '1.0.0' }, { 'index.js': '' });
    expect(() => loadBundlePatches(root, readPackageManifest(root))).toThrow('no dsh.bundle');
  });

  it('rejects an empty patch document instead of treating it as an empty layer', () => {
    const root = tempDir();
    writePackage(root, {
      name: 'demo',
      version: '1.0.0',
      dsh: { bundle: { patch: './empty.yml' } },
    }, { 'index.js': '', 'empty.yml': '# only a comment\n' });
    expect(() => loadBundlePatches(root, readPackageManifest(root))).toThrow('top-level YAML array');
  });
});

describe('entry resolution', () => {
  it('uses exports[.] import/default before main', () => {
    const root = tempDir();
    writePackage(root, {
      name: 'demo',
      version: '1.0.0',
      main: './fallback.js',
      exports: { '.': { import: './lib/index.js', default: './lib/index.js' } },
    }, { 'fallback.js': '', 'lib/index.js': '' });
    expect(resolvePackageEntry(root)).toBe(fs.realpathSync(path.join(root, 'lib/index.js')));
  });

  it('resolves exported subpaths and keeps them inside the package', () => {
    const root = tempDir();
    writePackage(root, {
      name: 'demo',
      version: '1.0.0',
      exports: { '.': './index.js', './client': './client.js' },
    }, { 'index.js': '', 'client.js': '' });
    expect(resolvePackageEntry(root, './client')).toBe(fs.realpathSync(path.join(root, 'client.js')));
  });
});

describe('compatibility matrix', () => {
  const environment = {
    appVersion: 'test',
    electronVersion: '42',
    nodeVersion: '24.19.0',
    platform: 'darwin',
    arch: 'arm64',
  };

  it('reports a matching range as unverified until a fresh execution record exists', () => {
    const manifest: RawPackageManifest = {
      name: 'dsh-plugin-guide',
      version: '0.4.5',
      engines: { dsh: '>=0.2.2-0 <0.3.0', node: '>=24.9.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    };
    const base = computeCompatibility({
      manifest,
      baseline: DSH_BASELINE,
      nodeVersion: environment.nodeVersion,
      platform: environment.platform,
      arch: environment.arch,
      missingHostServices: [],
      verifications: {},
      exemptions: [],
      environment,
    });
    expect(base.state).toBe('unverified');

    const verified = computeCompatibility({
      manifest,
      baseline: DSH_BASELINE,
      nodeVersion: environment.nodeVersion,
      platform: environment.platform,
      arch: environment.arch,
      missingHostServices: [],
      verifications: {
        'dsh-plugin-guide@0.4.5': {
          name: 'dsh-plugin-guide',
          version: '0.4.5',
          baseline: DSH_BASELINE.version,
          baselineCommit: DSH_BASELINE.commit,
          layerVersion: '1.0.0',
          environment,
          state: 'verified',
          verifiedCapabilities: ['skill:register', 'skill:get'],
          missingCapabilities: [],
          evidence: [{ kind: 'skill', summary: 'read the registered skill body' }],
          recordedAt: new Date().toISOString(),
        },
      },
      exemptions: [],
      environment,
    });
    expect(verified.state).toBe('verified');
  });

  it('reports an exact incompatible range and accepts a matching exemption as partial', () => {
    const manifest: RawPackageManifest = {
      name: 'dsh-find-plugin',
      version: '0.4.0',
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    };
    const incompatible = computeCompatibility({
      manifest,
      baseline: DSH_BASELINE,
      nodeVersion: environment.nodeVersion,
      platform: environment.platform,
      arch: environment.arch,
      missingHostServices: [],
      verifications: {},
      exemptions: [],
      environment,
    });
    expect(incompatible.state).toBe('incompatible');
    expect(incompatible.requirements).toHaveProperty('@deepseek-ai/dsh-tools');

    const exempted = computeCompatibility({
      manifest,
      baseline: DSH_BASELINE,
      nodeVersion: environment.nodeVersion,
      platform: environment.platform,
      arch: environment.arch,
      missingHostServices: [],
      verifications: {},
      exemptions: [`dsh-find-plugin@0.4.0@${DSH_BASELINE.version}`],
      environment,
    });
    expect(exempted.state).toBe('partial');
    expect(exempted.exempted).toBe(true);
  });

  it('marks a real client half as partial and names the missing capability', () => {
    const manifest: RawPackageManifest = {
      name: 'ui-plugin',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    };
    const result = computeCompatibility({
      manifest,
      baseline: DSH_BASELINE,
      nodeVersion: environment.nodeVersion,
      platform: environment.platform,
      arch: environment.arch,
      missingHostServices: ['agents'],
      verifications: {},
      exemptions: [],
      environment,
    });
    expect(result.state).toBe('partial');
    expect(result.missing).toEqual(expect.arrayContaining(['web-client', 'host-service:agents']));
  });
});
