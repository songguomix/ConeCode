import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketStateStore } from './state';
import type { InstalledPlugin } from '../../src/core/dsh-market/types';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-state-'));
  dirs.push(dir);
  return dir;
}

function plugin(profileId: string, name = 'demo'): InstalledPlugin {
  return {
    id: name,
    name,
    title: name,
    version: '1.0.0',
    format: 'dsh',
    profileId,
    enabled: true,
    status: 'loaded',
    requestedSpec: `${name}@1.0.0`,
    resolvedSpec: `${name}@1.0.0`,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    packageDir: '/tmp/package',
    entry: '/tmp/package/index.js',
    manifestRaw: { name, version: '1.0.0' },
    rows: [],
    compatibility: { state: 'unverified', authoredRange: null, authoredKeys: [], requirements: {}, reasons: [], missing: [], exempted: false },
    contributions: { tools: [], commands: [], skills: [] },
    backups: [],
    lastError: null,
    restartRequired: false,
    clientUnsupported: false,
    dataKept: true,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('market state persistence', () => {
  it('creates a default profile and survives a restart', async () => {
    const root = tempDir();
    const store = new MarketStateStore(root);
    store.updatePlugin('default', plugin('default'));
    store.setSources([{ id: 's', title: 'Source', kind: 'remote', location: 'https://example.com/c.json', enabled: true, lastSyncAt: null, lastError: null, cachedEntries: 0, stale: false }]);
    await store.flush();

    const reopened = new MarketStateStore(root);
    expect(reopened.activeProfileId()).toBe('default');
    expect(reopened.installed().map((item) => item.name)).toEqual(['demo']);
    expect(reopened.sources()).toHaveLength(1);
  });

  it('marks interrupted operations as failed after a restart', async () => {
    const root = tempDir();
    const first = new MarketStateStore(root);
    first.recordOperation({
      requestId: 'op-1',
      pluginId: 'demo',
      profileId: 'default',
      kind: 'install',
      phase: 'installing',
      message: 'Installing',
      startedAt: new Date().toISOString(),
    });
    await first.flush();
    const reopened = new MarketStateStore(root);
    const operation = reopened.operations()[0];
    expect(operation.phase).toBe('failed');
    expect(operation.error).toBe('interrupted');
  });

  it('persists exact-version exemptions and writes profile directories', async () => {
    const root = tempDir();
    const store = new MarketStateStore(root);
    store.ensureProfileDirs('default');
    store.setExemption('default', 'plugin@1.0.0', '0.2.2-rc.1', true);
    await store.flush();
    const reopened = new MarketStateStore(root);
    expect(reopened.exemptionVersions('default', 'plugin@1.0.0')).toEqual(['0.2.2-rc.1']);
    expect(fs.existsSync(reopened.pluginsDir('default'))).toBe(true);
    expect(fs.existsSync(reopened.logsDir('default'))).toBe(true);
  });

  it('rejects a plugin record whose profile does not match its owner', async () => {
    const root = tempDir();
    const store = new MarketStateStore(root);
    store.createProfile('work');
    expect(() => store.updatePlugin('work', plugin('default'))).toThrow('profile mismatch');
  });
});
