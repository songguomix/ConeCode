import { describe, expect, it, vi } from 'vitest';
import { GoogleDriveStorageProvider, type GoogleDriveBridge } from './storage/googleDrive';
import { createRecord } from './model';
import { emptyState } from './storage/interface';
import type { MemoryChange, MemoryRecord } from './types';

function record(): MemoryRecord {
  return createRecord({
    content: 'Drive E2E secret decision',
    type: 'technical_decision',
    layer: 'global',
    status: 'confirmed',
    origin: 'user',
  }, { id: 'drive-1', deviceId: 'dev-a', now: 1 });
}

function bridge(): GoogleDriveBridge {
  const state = emptyState();
  return {
    status: vi.fn(async () => ({ configured: true, connected: true, clientIdSet: true, source: 'saved' as const })),
    configure: vi.fn(async () => ({ configured: true, connected: true, clientIdSet: true, source: 'saved' as const })),
    connect: vi.fn(async () => ({ ok: true })),
    disconnect: vi.fn(async () => true),
    health: vi.fn(async () => ({ ok: true, kind: 'cloud' as const, configured: true, message: 'Google Drive · test' })),
    search: vi.fn(async () => [{
      record: record(), score: 2, source: 'cloud' as const, matchedTerms: ['drive'], reasons: ['drive search'],
    }]),
    remoteChanges: vi.fn(async () => ({ changes: [] as MemoryChange[], cursor: 0 })),
    pushChanges: vi.fn(async () => ({ ok: true, acceptedChangeIds: ['c1'], cursor: 1, conflicts: [] })),
    backup: vi.fn(async () => 'backup.json'),
    restore: vi.fn(async () => true),
    restoreSnapshot: vi.fn(async () => ({ ...state, records: [record()], changes: [] })),
    putObject: vi.fn(async () => true),
    getObject: vi.fn(async () => 'object'),
    usage: vi.fn(async () => ({ records: 1, changes: 0, objects: 0, bytes: 10, devices: [] })),
    devices: vi.fn(async () => [{ deviceId: 'dev-a', lastSeenAt: 1 }]),
    revokeDevice: vi.fn(async () => true),
    deleteTenantData: vi.fn(async () => true),
  };
}

describe('GoogleDriveStorageProvider', () => {
  it('passes through health/search in transport mode', async () => {
    const b = bridge();
    const provider = new GoogleDriveStorageProvider(b, { tenantId: 't1', encryption: 'transport', e2ePassphrase: '' });
    expect((await provider.health()).ok).toBe(true);
    const hits = await provider.search({ text: 'drive', scope: 'all' });
    expect(hits[0].source).toBe('cloud');
    expect(b.search).toHaveBeenCalledWith('t1', { text: 'drive', scope: 'all' });
  });

  it('encrypts before push and decrypts after pull under E2E', async () => {
    const b = bridge();
    const provider = new GoogleDriveStorageProvider(b, { tenantId: 't1', encryption: 'e2e', e2ePassphrase: 'shared' });
    const rec = record();
    await provider.pushChanges([{
      seq: 1, changeId: 'c1', memoryId: rec.id, op: 'create', record: rec, at: 1, deviceId: 'dev-a', projectId: null,
    }]);
    const pushed = vi.mocked(b.pushChanges).mock.calls[0][1][0];
    expect(pushed.record?.content).toMatch(/^e2e:v1:/);
    expect(pushed.record?.content).not.toContain('secret decision');

    vi.mocked(b.remoteChanges).mockResolvedValueOnce({ changes: [pushed], cursor: 1 });
    const pulled = await provider.remoteChanges(0);
    expect(pulled.changes[0].record?.content).toBe('Drive E2E secret decision');
    expect(await provider.search({ text: 'secret', scope: 'all' })).toEqual([]);
  });

  it('maps a Drive snapshot restore into a local state', async () => {
    const b = bridge();
    const provider = new GoogleDriveStorageProvider(b, { tenantId: 't1', encryption: 'transport', e2ePassphrase: '' });
    const snapshot = await provider.restoreSnapshot();
    expect(snapshot?.records[0].id).toBe('drive-1');
    expect(snapshot?.sync.cloudCursor).toBe(0);
    expect(await provider.backup()).toBe('backup.json');
  });
});
