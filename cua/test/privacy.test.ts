import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/store/store.js';

describe('SQLite storage permissions', () => {
  it.skipIf(process.platform === 'win32')('creates private database files and tightens legacy files without changing existing parent permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cua-privacy-'));
    await chmod(dir, 0o755);
    const dbPath = join(dir, 'private', 'runtime.db');
    const first = new SessionStore(dbPath);
    let second: SessionStore | undefined;
    try {
      expect((await stat(join(dir, 'private'))).mode & 0o777).toBe(0o700);
      for (const path of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
        expect(existsSync(path)).toBe(true);
        expect((await stat(path)).mode & 0o077).toBe(0);
        await chmod(path, 0o644);
      }
      second = new SessionStore(dbPath);
      for (const path of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      expect((await stat(dir)).mode & 0o777).toBe(0o755);
    } finally {
      second?.close();
      first.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
