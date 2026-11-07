import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertInside,
  buildInstallSpec,
  normalizeUserInputUrl,
  pluginDirectoryName,
  validateExactVersion,
  validateGitUrl,
  validatePackageName,
  validateProfileId,
  validateRegistryUrl,
} from './security';

describe('install spec validation', () => {
  it('accepts and pins npm, git and local sources', () => {
    expect(buildInstallSpec('dsh-plugin-health', '3.0.5', { type: 'npm' }).spec).toBe('dsh-plugin-health@3.0.5');
    expect(buildInstallSpec('@scope/plugin', '1.2.3', { type: 'npm' }).spec).toBe('@scope/plugin@1.2.3');
    const git = buildInstallSpec('demo', '1.0.0', {
      type: 'git',
      url: 'https://github.com/acme/demo',
      commit: 'a'.repeat(40),
    });
    expect(git.spec).toBe(`git+https://github.com/acme/demo.git#${'a'.repeat(40)}`);
    const monorepo = buildInstallSpec('demo', '1.0.0', {
      type: 'git',
      url: 'https://github.com/acme/mono',
      commit: 'b'.repeat(40),
      subdir: 'packages/demo',
    });
    expect(monorepo.spec).toBe(`git+https://github.com/acme/mono.git#${'b'.repeat(40)}&path:/packages/demo`);
    expect(() => buildInstallSpec('demo', '1.0.0', { type: 'git', url: 'https://github.com/acme/mono', commit: 'b'.repeat(40), subdir: '../escape' })).toThrow('subdirectory');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-security-'));
    expect(buildInstallSpec('demo', '1.0.0', { type: 'local', path: dir }).spec).toBe(`file:${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects package names that can become arguments or paths', () => {
    for (const name of ['-g', '../evil', 'pkg;rm -rf /', 'UPPER', '@scope', 'a b']) {
      expect(() => validatePackageName(name)).toThrow();
    }
  });

  it('rejects ranges where an exact version is required', () => {
    for (const version of ['latest', '^1.2.3', '1.x', '1.2.3 || 2.0.0']) {
      expect(() => validateExactVersion(version)).toThrow();
    }
  });

  it('rejects unpinned or credential-bearing git URLs', () => {
    expect(() => validateGitUrl('https://github.com/acme/demo#main')).toThrow('40-character');
    expect(() => validateGitUrl(`https://user:pass@github.com/acme/demo#${'a'.repeat(40)}`)).toThrow('credentials');
    expect(() => validateGitUrl(`git@github.com:acme/demo.git#${'a'.repeat(40)}`)).toThrow();
  });

  it('limits registries to https or loopback http', () => {
    expect(validateRegistryUrl('https://registry.npmjs.org')).toBe('https://registry.npmjs.org');
    expect(() => validateRegistryUrl('http://registry.npmjs.org')).toThrow('https');
    expect(validateRegistryUrl('http://localhost:4873')).toBe('http://localhost:4873');
    expect(() => validateRegistryUrl('https://user:pass@registry.npmjs.org')).toThrow('credentials');
  });

  it('normalizes only safe catalog URLs', () => {
    expect(normalizeUserInputUrl('https://example.com/a.json#frag')).toBe('https://example.com/a.json');
    expect(() => normalizeUserInputUrl('file:///tmp/catalog.json')).toThrow();
    expect(() => normalizeUserInputUrl('https://user:pass@example.com/a.json')).toThrow('credentials');
  });
});

describe('path and identity helpers', () => {
  it('uses stable, collision-resistant directory names', () => {
    const a = pluginDirectoryName('@scope/demo');
    const b = pluginDirectoryName('@scope/demo');
    const c = pluginDirectoryName('@scope/demo2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('rejects profile ids that cannot be used as directories', () => {
    expect(validateProfileId('work-1')).toBe('work-1');
    for (const id of ['../x', 'Upper', '', 'a'.repeat(33), 'a/b']) expect(() => validateProfileId(id)).toThrow();
  });

  it('asserts paths stay inside a real root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-root-'));
    const inside = path.join(root, 'a');
    fs.mkdirSync(inside);
    expect(assertInside(root, inside, 'test')).toBe(fs.realpathSync(inside));
    expect(() => assertInside(root, path.join(root, '..', 'escape'), 'test')).toThrow('inside');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
