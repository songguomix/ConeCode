import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { FileMemory2Store, type Memory2SecretCodec } from './memory2.store';
import { emptyState } from '../src/core/memory/v2/storage/interface';
import { createRecord } from '../src/core/memory/v2/model';
import { MemoryService } from '../src/core/memory/v2/service';
import { LocalStorageProvider } from '../src/core/memory/v2/storage/local';
import { CompositeStorageProvider } from '../src/core/memory/v2/storage/composite';

const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const base64Codec: Memory2SecretCodec = {
  encrypt: (plain) => Buffer.from(`encrypted:${plain}`).toString('base64'),
  decrypt: (cipher) => {
    const decoded = Buffer.from(cipher, 'base64').toString('utf-8');
    if (!decoded.startsWith('encrypted:')) throw new Error('bad payload');
    return decoded.slice('encrypted:'.length);
  },
};

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('FileMemory2Store', () => {
  it('keeps object keys inside the objects directory', () => {
    const dataDir = tempDir('conecode-memory2-');
    const store = new FileMemory2Store(dataDir, tempDir('conecode-home-'));
    expect(store.putObject('../../escape.txt', 'x')).toBe(false);
    expect(store.getObject('../../escape.txt')).toBeNull();
    expect(store.putObject('/absolute.txt', 'x')).toBe(false);
    expect(store.putObject('dream/project/wiki/topic.md', 'ok')).toBe(true);
    expect(store.getObject('dream/project/wiki/topic.md')).toBe('ok');
    expect(fs.existsSync(path.join(dataDir, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'objects', 'dream', 'project', 'wiki', 'topic.md'))).toBe(true);

    expect(store.putObject('dream/project/history/topic-1700000000000.md', 'old')).toBe(true);
    expect(store.listObjects('dream/project')).toEqual(
      expect.arrayContaining(['dream/project/wiki/topic.md', 'dream/project/history/topic-1700000000000.md'])
    );
    expect(store.deleteObject('dream/project/history/topic-1700000000000.md')).toBe(true);
    expect(store.getObject('dream/project/history/topic-1700000000000.md')).toBeNull();
    expect(store.deleteObject('../outside.md')).toBe(false);
    expect(store.listObjects('../')).toEqual([]);
  });

  it('persists atomically and reloads the same records', () => {
    const dataDir = tempDir('conecode-memory2-');
    const store = new FileMemory2Store(dataDir, tempDir('conecode-home-'));
    const state = emptyState();
    state.records = [createRecord({
      content: 'The release build must be signed before upload',
      type: 'constraint',
      layer: 'global',
      status: 'confirmed',
      origin: 'user',
    }, { id: 'm1', deviceId: 'dev-a', now: 1 })];
    expect(store.save(state)).toBe(true);
    const loaded = store.load();
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0].content).toContain('signed before upload');
    expect(loaded.schema).toBe(2);
  });

  it('survives an app restart through the real file-backed provider', async () => {
    const dataDir = tempDir('conecode-memory2-');
    const home = tempDir('conecode-home-');
    const fileStore = new FileMemory2Store(dataDir, home);

    const first = new MemoryService({
      storage: new CompositeStorageProvider(new LocalStorageProvider(fileStore.bridge(() => '/repo/persist')), null),
      makeId: () => `persist-${Math.random().toString(36).slice(2)}`,
      deviceId: fileStore.deviceId(),
      now: () => 1_800_000_000_000,
      trackWorkingMemory: false,
    });
    await first.init();
    first.setProject('/repo/persist', fileStore.projectId('/repo/persist'));
    await first.saveMemory({
      content: 'A restart must not lose the file-backed memory',
      type: 'constraint',
      layer: 'project',
      projectId: first.getProjectId(),
      status: 'confirmed',
      origin: 'user',
    });

    // New provider + new service, as after quitting and relaunching.
    const second = new MemoryService({
      storage: new CompositeStorageProvider(new LocalStorageProvider(fileStore.bridge(() => '/repo/persist')), null),
      makeId: () => `persist2-${Math.random().toString(36).slice(2)}`,
      deviceId: fileStore.deviceId(),
      now: () => 1_800_000_000_000,
      trackWorkingMemory: false,
    });
    await second.init();
    second.setProject('/repo/persist', fileStore.projectId('/repo/persist'));
    const hits = await second.searchMemory({ text: 'restart file-backed memory', scope: 'all' });
    expect(hits.map((h) => h.record.content)).toContain('A restart must not lose the file-backed memory');
  });

  it('encrypts cloud credentials at rest and decrypts them on load', () => {
    const dataDir = tempDir('conecode-memory2-');
    const store = new FileMemory2Store(dataDir, tempDir('conecode-home-'), base64Codec);
    const state = emptyState();
    state.cloud.authToken = 'super-secret-token';
    state.cloud.e2ePassphrase = 'client-passphrase';
    expect(store.save(state)).toBe(true);

    const raw = fs.readFileSync(path.join(dataDir, 'memory2.json'), 'utf-8');
    expect(raw).not.toContain('super-secret-token');
    expect(raw).not.toContain('client-passphrase');
    expect(raw).toContain('enc:v1:');

    const loaded = store.load();
    expect(loaded.cloud.authToken).toBe('super-secret-token');
    expect(loaded.cloud.e2ePassphrase).toBe('client-passphrase');
  });

  it('keeps a stable device id and backs up/restores the store', () => {
    const dataDir = tempDir('conecode-memory2-');
    const store = new FileMemory2Store(dataDir, tempDir('conecode-home-'));
    const id = store.deviceId();
    expect(store.deviceId()).toBe(id);

    const state = emptyState();
    state.records = [createRecord({
      content: 'A backup must survive a restore',
      type: 'project_fact',
      layer: 'global',
    }, { id: 'm2', deviceId: id, now: 2 })];
    store.save(state);
    expect(store.backup().ok).toBe(true);

    const empty = emptyState();
    store.save(empty);
    expect(store.load().records).toHaveLength(0);
    const restored = store.restore();
    expect(restored.ok).toBe(true);
    expect(restored.state?.records).toHaveLength(1);
  });

  it('reads legacy memory.json and memory files without modifying them', () => {
    const userData = tempDir('conecode-userdata-');
    const home = tempDir('conecode-home-');
    const root = tempDir('conecode-repo-');
    const dataDir = path.join(userData, 'data', 'memory2');
    fs.mkdirSync(path.join(userData, 'data'), { recursive: true });
    const legacyPath = path.join(userData, 'data', 'memory.json');
    const legacy = JSON.stringify([{ id: 'old1', kind: 'workflow', text: 'Run tests first', scope: 'global' }]);
    fs.writeFileSync(legacyPath, legacy);
    fs.mkdirSync(path.join(home, '.conecode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.conecode', 'CLAUDE.md'), '## Memory\n\n- Prefer small commits\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Project\n\n- Keep main thin\n');

    const store = new FileMemory2Store(dataDir, home);
    const before = fs.readFileSync(legacyPath, 'utf-8');
    const snapshot = store.legacySnapshot(root);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.files.some((f) => f.content.includes('Prefer small commits'))).toBe(true);
    expect(snapshot.files.some((f) => f.content.includes('Keep main thin'))).toBe(true);
    expect(fs.readFileSync(legacyPath, 'utf-8')).toBe(before);
  });

  it.skipIf(!hasGit())('derives the same project id from the same git remote on two machines', () => {
    const store = new FileMemory2Store(tempDir('conecode-memory2-'), tempDir('conecode-home-'));
    const repoA = tempDir('conecode-repo-a-');
    const repoB = tempDir('conecode-repo-b-');
    for (const [repo, remote] of [
      [repoA, 'git@github.com:example/shared-project.git'],
      [repoB, 'https://github.com/example/shared-project.git'],
    ] as const) {
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo, stdio: 'ignore' });
    }
    expect(store.projectId(repoA)).toBe(store.projectId(repoB));
  });
});
