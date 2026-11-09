import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store resolves its directory from Electron's userData path; point that at a temp dir.
const userData = { dir: '' };
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }));

const FILE = 'conversations.json';

async function loadStore() {
  vi.resetModules();
  return import('./database');
}

function dataFile(name = FILE): string {
  return path.join(userData.dir, 'data', name);
}

beforeEach(() => {
  userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-db-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(userData.dir, { recursive: true, force: true });
});

describe('crash-safe JSON persistence', () => {
  it('leaves the previous version readable when a save dies mid-write', async () => {
    const store = await loadStore();
    store.writeJSON(FILE, [{ id: 'a' }]);
    const before = fs.readFileSync(dataFile(), 'utf-8');

    // A full disk / kill -9 during the payload write: part of the new bytes reach the file
    // descriptor and then the write throws.
    const realWrite = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      target: fs.PathOrFileDescriptor,
      payload: string | NodeJS.ArrayBufferView,
    ) => {
      if (typeof payload === 'string' && payload.includes('"b"')) {
        realWrite(target as never, '{"trunc');
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      }
      return realWrite(target as never, payload as never) as never;
    }) as typeof fs.writeFileSync);

    expect(() => store.writeJSON(FILE, [{ id: 'b' }])).toThrow();
    vi.restoreAllMocks();

    expect(store.readJSON(FILE, [])).toEqual([{ id: 'a' }]);
    expect(fs.readFileSync(dataFile(), 'utf-8')).toBe(before);
  });

  it('recovers the last good version from the rotated backup when the file is truncated', async () => {
    const store = await loadStore();
    store.writeJSON(FILE, [{ id: 'a' }]);
    store.writeJSON(FILE, [{ id: 'b' }]);

    // Disk-level corruption of the primary (power loss on a non-journaling filesystem).
    fs.writeFileSync(dataFile(), '{"truncated');

    expect(store.readJSON(FILE, [])).toEqual([{ id: 'a' }]);
  });

  it('commits atomically: primary is valid JSON, previous version kept, no temp files left', async () => {
    const store = await loadStore();
    store.writeJSON(FILE, [{ id: 'a' }]);
    store.writeJSON(FILE, [{ id: 'a' }, { id: 'b' }]);

    expect(fs.readdirSync(path.join(userData.dir, 'data')).sort()).toEqual([
      'conversations.json',
      'conversations.json.bak',
    ]);
    expect(JSON.parse(fs.readFileSync(dataFile(), 'utf-8'))).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(JSON.parse(fs.readFileSync(`${dataFile()}.bak`, 'utf-8'))).toEqual([{ id: 'a' }]);
  });

  it('never resurrects deleted data from the backup', async () => {
    const store = await loadStore();
    store.writeJSON(FILE, [{ id: 'a' }]);
    store.writeJSON(FILE, [{ id: 'b' }]);

    expect(store.deleteJSON(FILE)).toBe(true);
    expect(store.readJSON(FILE, [])).toEqual([]);
    expect(fs.existsSync(`${dataFile()}.bak`)).toBe(false);
  });
});
