import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ArtifactStore } from '../src/store/artifacts.js';
import { SessionStore } from '../src/store/store.js';

it('refuses artifact symlinks that leave the evidence root, including database-backed reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cua-artifact-boundary-'));
  const store = new SessionStore(':memory:');
  try {
    const root = join(dir, 'artifacts');
    await mkdir(root);
    await writeFile(join(dir, 'private.txt'), 'private content');
    await symlink(join(dir, 'private.txt'), join(root, 'escaped.txt'));
    const artifacts = new ArtifactStore(root, store);
    await expect(artifacts.readByPath(join(root, 'escaped.txt'))).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    const record = store.saveArtifact({ kind: 'text', path: join(root, 'escaped.txt'), sha256: 'unused', meta: {} });
    await expect(artifacts.readById(record.id)).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    const safe = await artifacts.save({ kind: 'text', extension: '.txt', bytes: Buffer.from('safe') });
    expect((await artifacts.readById(safe.id)).bytes.toString()).toBe('safe');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
