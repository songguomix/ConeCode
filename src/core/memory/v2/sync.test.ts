import { describe, expect, it } from 'vitest';
import { MemoryService } from './service';
import { CompositeStorageProvider } from './storage/composite';
import { InMemoryStorageProvider } from './storage/inMemory';
import { emptyState } from './storage/interface';

const NOW = 1_800_000_000_000;

async function device(cloud: InMemoryStorageProvider, deviceId: string) {
  const local = new InMemoryStorageProvider({ kind: 'local', initial: emptyState() });
  const composite = new CompositeStorageProvider(local, null);
  let n = 0;
  const service = new MemoryService({
    storage: composite,
    makeId: () => `${deviceId}-${++n}`,
    deviceId,
    now: () => NOW,
    cloudFactory: () => cloud,
    trackWorkingMemory: false,
  });
  await service.init();
  service.setProject('/repo/a', 'proj-a');
  await service.configureCloud({
    enabled: true,
    baseUrl: 'http://cloud.local',
    authToken: 'test-token',
    tlsOnly: false,
    autoSync: false,
    tenantId: 'test',
  });
  return { service, local, composite };
}

describe('MemorySyncEngine (two devices)', () => {
  it('pushes and pulls incremental changes, and deletion is a tombstone', async () => {
    const cloud = new InMemoryStorageProvider({ kind: 'cloud', supportsSync: true, initial: emptyState() });
    const a = await device(cloud, 'device-a');
    const b = await device(cloud, 'device-b');

    const record = await a.service.saveMemory({
      content: 'Use the preview dev server to verify static pages',
      type: 'architecture',
      layer: 'project',
      projectId: 'proj-a',
      status: 'confirmed',
      origin: 'user',
    });
    const firstSync = await a.service.syncMemory();
    expect(firstSync.report.ok).toBe(true);
    expect(firstSync.report.pushed).toBe(1);

    const bSync = await b.service.syncMemory();
    expect(bSync.report.pulled).toBe(1);
    expect(b.service.getState().records.map((r) => r.id)).toContain(record.id);

    // Replaying the same feed is idempotent.
    const bAgain = await b.service.syncMemory();
    expect(bAgain.report.applied).toBe(0);
    expect(b.service.getState().records.filter((r) => r.id === record.id)).toHaveLength(1);

    await a.service.deleteMemory(record.id);
    await a.service.syncMemory();
    await b.service.syncMemory();
    const onB = b.service.getState().records.find((r) => r.id === record.id);
    expect(onB?.deletedAt).not.toBeNull();

    // A second pull must not resurrect the deleted memory.
    await b.service.syncMemory();
    expect(b.service.getState().records.find((r) => r.id === record.id)?.deletedAt).not.toBeNull();
  });

  it('keeps both versions on a concurrent edit and resolves to a new synced version', async () => {
    const cloud = new InMemoryStorageProvider({ kind: 'cloud', supportsSync: true, initial: emptyState() });
    const a = await device(cloud, 'device-a');
    const b = await device(cloud, 'device-b');

    const record = await a.service.saveMemory({
      content: 'Retry count is three',
      type: 'constraint',
      layer: 'project',
      projectId: 'proj-a',
      status: 'confirmed',
      origin: 'user',
    });
    await a.service.syncMemory();
    await b.service.syncMemory();

    await a.service.updateMemory(record.id, { content: 'Retry count is five' });
    await a.service.syncMemory();

    await b.service.updateMemory(record.id, { content: 'Retry count is ten' });
    const bSync = await b.service.syncMemory();
    expect(bSync.report.conflicts).toBeGreaterThanOrEqual(1);
    const conflicts = b.service.getConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].local.content).toContain('ten');
    expect(conflicts[0].remote.content).toContain('five');

    // Keeping the remote (A's) version creates a new local version that pushes.
    await b.service.resolveConflict(conflicts[0].id, 'keep_remote');
    const resolved = b.service.getState().records.find((r) => r.id === record.id)!;
    expect(resolved.content).toContain('five');
    expect(resolved.version).toBe(3);
    expect(resolved.conflictWith).toBeUndefined();
    await b.service.syncMemory();

    await a.service.syncMemory();
    expect(a.service.getState().records.find((r) => r.id === record.id)?.content).toContain('five');
  });

  it('queues edits while the cloud is offline and resumes when it returns', async () => {
    const cloud = new InMemoryStorageProvider({ kind: 'cloud', supportsSync: true, initial: emptyState() });
    const a = await device(cloud, 'device-a');
    const b = await device(cloud, 'device-b');

    cloud.failHealth = true;
    const record = await a.service.saveMemory({
      content: 'Offline note: the release script needs the signing key',
      type: 'constraint',
      layer: 'project',
      projectId: 'proj-a',
      status: 'confirmed',
      origin: 'user',
    });
    const offline = await a.service.syncMemory();
    expect(offline.report.ok).toBe(false);
    expect(offline.report.offline).toBe(true);
    expect(a.service.getSyncStatus().pending).toBeGreaterThan(0);
    expect(a.service.getSyncStatus().offlineQueue).toBeGreaterThan(0);

    cloud.failHealth = false;
    const online = await a.service.syncMemory();
    expect(online.report.ok).toBe(true);
    expect(online.report.pushed).toBeGreaterThan(0);
    expect(a.service.getSyncStatus().pending).toBe(0);

    await b.service.syncMemory();
    expect(b.service.getState().records.map((r) => r.id)).toContain(record.id);
  });

  it('does not answer a cloud-only search from the local cache', async () => {
    const cloud = new InMemoryStorageProvider({ kind: 'cloud', supportsSync: true, initial: emptyState() });
    const a = await device(cloud, 'device-a');
    await a.service.saveMemory({
      content: 'A local-only fact must not be labelled cloud',
      type: 'constraint',
      layer: 'project',
      projectId: 'proj-a',
      status: 'confirmed',
      origin: 'user',
    });
    const hits = await a.service.searchMemory({ text: 'local-only fact', scope: 'cloud' });
    expect(hits).toEqual([]);
  });

  it('falls back to local retrieval when the cloud is unavailable', async () => {
    const cloud = new InMemoryStorageProvider({ kind: 'cloud', supportsSync: true, initial: emptyState() });
    const a = await device(cloud, 'device-a');
    await a.service.saveMemory({
      content: 'The local fallback must keep working without network',
      type: 'constraint',
      layer: 'project',
      projectId: 'proj-a',
      status: 'confirmed',
      origin: 'user',
    });
    cloud.failHealth = true;
    const hits = await a.service.searchMemory({ text: 'fallback network', scope: 'all' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe('local');
  });
});
