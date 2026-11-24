import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const userData = { dir: '' };

const FILE = 'conversations.json';

async function loadStore() {
  vi.resetModules();
  const store = await import('./database');
  store.configureStorageDirectory(path.join(userData.dir, 'data'));
  return store;
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
  it('clones only the selected rows and isolates nested data from callers', async () => {
    const store = await loadStore();
    const rows = [{ id: 'active', calls: ['read_file'] }, { id: 'other', calls: ['search'] }];
    store.writeJSON(FILE, rows);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const selected = store.selectJSON(FILE, [] as typeof rows, (items) => items.filter((item) => item.id === 'active'));
    expect(clone).toHaveBeenCalledTimes(1);
    expect(clone.mock.calls[0][0]).toEqual([rows[0]]);
    selected[0].calls.push('list_dir');
    expect(store.readJSON(FILE, [])).toEqual(rows);
  });

  it('appends without cloning the history and isolates new and duplicate results', async () => {
    const store = await loadStore();
    const history = [{ id: 'old', calls: ['search'] }];
    store.writeJSON(FILE, history);
    const row = { id: 'new', calls: ['read_file'] };
    const clone = vi.spyOn(globalThis, 'structuredClone');

    const added = store.appendUniqueJSON<typeof row>(FILE, (item) => item.id === row.id, () => row);
    expect(clone.mock.calls.map(([value]) => value)).toEqual([row, row]);
    expect(JSON.parse(fs.readFileSync(dataFile(), 'utf-8'))).toEqual([...history, row]);
    expect(JSON.parse(fs.readFileSync(dataFile() + '.bak', 'utf-8'))).toEqual(history);
    row.calls.push('input changed');
    added.calls.push('result changed');

    const createDuplicate = vi.fn(() => ({ id: row.id, calls: [] }));
    const duplicate = store.appendUniqueJSON<typeof row>(FILE, (item) => item.id === row.id, createDuplicate);
    expect(createDuplicate).not.toHaveBeenCalled();
    expect(duplicate).toEqual({ id: 'new', calls: ['read_file'] });
    duplicate.calls.push('duplicate changed');
    expect(store.readJSON(FILE, [])).toEqual([...history, { id: 'new', calls: ['read_file'] }]);
    expect(JSON.parse(fs.readFileSync(dataFile() + '.bak', 'utf-8'))).toEqual(history);
  });

  it.each(['replace', 'append'])('leaves the previous version readable after a failed %s', async (operation) => {
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

    expect(() => {
      if (operation === 'replace') store.writeJSON(FILE, [{ id: 'b' }]);
      else store.appendUniqueJSON(FILE, (item: Readonly<{ id: string }>) => item.id === 'b', () => ({ id: 'b' }));
    }).toThrow();
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
