import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemoryService } from './service';
import { CompositeStorageProvider } from './storage/composite';
import { InMemoryStorageProvider } from './storage/inMemory';
import { CloudStorageProvider } from './storage/cloud';
import { emptyState } from './storage/interface';
import type { CloudConfig } from './types';

const TOKEN = 'integration-token';
const PORT = 20_000 + Math.floor(Math.random() * 20_000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;
let dataDir = '';

async function waitForServer(timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/health`, {
        headers: { Authorization: `Bearer ${TOKEN}`, 'X-Tenant-Id': 'test', 'X-Device-Id': 'probe' },
      });
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('memory cloud did not start in time');
}

function config(): CloudConfig {
  return {
    enabled: true,
    provider: 'rest',
    baseUrl: BASE_URL,
    authToken: TOKEN,
    tenantId: 'test',
    autoSync: false,
    syncIntervalMs: 60_000,
    encryption: 'transport',
    e2ePassphrase: '',
    tlsOnly: false,
  };
}

async function device(deviceId: string, overrides: Partial<CloudConfig> = {}) {
  const local = new InMemoryStorageProvider({ kind: 'local', initial: emptyState() });
  const composite = new CompositeStorageProvider(local, null);
  let n = 0;
  const service = new MemoryService({
    storage: composite,
    makeId: () => `${deviceId}-${++n}`,
    deviceId,
    now: () => Date.now(),
    trackWorkingMemory: false,
    cloudFactory: (cfg, id) => new CloudStorageProvider({ config: cfg, deviceId: id, timeoutMs: 3000 }),
  });
  await service.init();
  service.setProject('/repo/cloud', 'proj-cloud');
  const { health } = await service.configureCloud({ ...config(), ...overrides });
  expect(health.ok).toBe(true);
  return { service, local, composite };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-memory-cloud-'));
  server = spawn(process.execPath, [path.resolve('server/memory-cloud/server.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MEMORY_CLOUD_TOKEN: TOKEN,
      MEMORY_CLOUD_DIR: dataDir,
      MEMORY_CLOUD_TENANTS: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    if (/error|refus/i.test(text)) console.error('[memory-cloud-test]', text.trim());
  });
  await waitForServer();
}, 20_000);

afterAll(async () => {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (dataDir) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('real cloud memory service', () => {
  it('saves, searches, syncs, resolves conflicts and tombstones across two devices', async () => {
    const a = await device('cloud-device-a');
    const b = await device('cloud-device-b');

    const record = await a.service.saveMemory({
      content: 'Cloud-synced decision: PostgreSQL stores structured memory, object storage keeps exports',
      type: 'technical_decision',
      layer: 'project',
      projectId: 'proj-cloud',
      status: 'confirmed',
      origin: 'user',
    });
    const aSync = await a.service.syncMemory();
    expect(aSync.report.ok).toBe(true);
    expect(aSync.report.pushed).toBe(1);

    const bSync = await b.service.syncMemory();
    expect(bSync.report.ok).toBe(true);
    expect(b.service.getState().records.map((r) => r.id)).toContain(record.id);

    // Cloud-side full-text search is a real remote query, not a local scan.
    const remoteHits = await b.composite.cloud!.search({
      text: 'PostgreSQL structured', projectId: 'proj-cloud', scope: 'all',
    });
    expect(remoteHits.length).toBeGreaterThan(0);
    expect(remoteHits[0].source).toBe('cloud');
    const otherProjectHits = await b.composite.cloud!.search({
      text: 'PostgreSQL structured', projectId: 'proj-other', scope: 'all',
    });
    expect(otherProjectHits).toEqual([]);
    const punctuationHits = await b.composite.cloud!.search({
      text: '？？？', projectId: 'proj-cloud', scope: 'all',
    });
    expect(punctuationHits).toEqual([]);

    // B edits and syncs back to A.
    await b.service.updateMemory(record.id, { content: 'Cloud-synced decision: PostgreSQL + S3/R2, never object storage for transactions' });
    await b.service.syncMemory();
    await a.service.syncMemory();
    expect(a.service.getState().records.find((r) => r.id === record.id)?.content).toContain('S3/R2');

    // Concurrent edit -> conflict with both sides preserved.
    await a.service.updateMemory(record.id, { content: 'A side: PostgreSQL is the source of truth' });
    await a.service.syncMemory();
    await b.service.updateMemory(record.id, { content: 'B side: S3 is the source of truth' });
    const conflictSync = await b.service.syncMemory();
    expect(conflictSync.report.conflicts).toBeGreaterThanOrEqual(1);
    const conflict = b.service.getConflicts()[0];
    expect(conflict).toBeTruthy();
    expect([conflict.local.content, conflict.remote.content].join(' ')).toContain('PostgreSQL');
    expect([conflict.local.content, conflict.remote.content].join(' ')).toContain('S3');

    await b.service.resolveConflict(conflict.id, 'keep_remote');
    await b.service.syncMemory();
    await a.service.syncMemory();
    expect(a.service.getState().records.find((r) => r.id === record.id)?.content).toContain('PostgreSQL is the source of truth');

    // Tombstone survives the round trip and never resurrects.
    await a.service.deleteMemory(record.id);
    await a.service.syncMemory();
    await b.service.syncMemory();
    expect(b.service.getState().records.find((r) => r.id === record.id)?.deletedAt).not.toBeNull();
    await b.service.syncMemory();
    expect(b.service.getState().records.find((r) => r.id === record.id)?.deletedAt).not.toBeNull();

    const usage = await a.service.getCloudUsage();
    expect(usage?.records).toBeGreaterThanOrEqual(1);
    const devices = await a.service.getCloudDevices();
    expect(devices.map((d) => d.deviceId)).toEqual(expect.arrayContaining(['cloud-device-a', 'cloud-device-b']));
  }, 30_000);

  it('syncs E2E ciphertext, decrypts on a device with the same passphrase, and disables server search', async () => {
    const passphrase = 'shared-client-passphrase';
    const c = await device('e2e-device-c', { encryption: 'e2e', e2ePassphrase: passphrase });
    const d = await device('e2e-device-d', { encryption: 'e2e', e2ePassphrase: passphrase });

    const record = await c.service.saveMemory({
      content: 'E2E-only fact: the recovery key is rotated every quarter',
      type: 'constraint',
      layer: 'project',
      projectId: 'proj-cloud',
      status: 'confirmed',
      origin: 'user',
    });
    await c.service.syncMemory();

    // The cloud holds ciphertext, not the plaintext fact.
    const feed = await fetch(`${BASE_URL}/changes?since=0&limit=500`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Tenant-Id': 'test', 'X-Device-Id': 'probe' },
    }).then((r) => r.json());
    const rawChange = (feed.changes ?? []).find((change: any) => change.memoryId === record.id);
    expect(rawChange?.record?.content).toMatch(/^e2e:v1:/);
    expect(rawChange?.record?.content).not.toContain('recovery key');

    const sync = await d.service.syncMemory();
    expect(sync.report.ok).toBe(true);
    const onD = d.service.getState().records.find((r) => r.id === record.id);
    expect(onD?.content).toContain('recovery key is rotated');

    // E2E means server-side plaintext search is impossible — the provider must
    // return no cloud hits and local decrypted search must still work.
    const cloudHits = await d.composite.cloud!.search({ text: 'recovery key', projectId: 'proj-cloud', scope: 'all' });
    expect(cloudHits).toEqual([]);
    const localHits = await d.service.searchMemory({ text: 'recovery key', scope: 'all' });
    expect(localHits.length).toBeGreaterThan(0);

    // A device with the wrong passphrase cannot read the record. It must not
    // apply ciphertext over its local cache either.
    const wrong = await device('e2e-device-wrong', { encryption: 'e2e', e2ePassphrase: 'wrong-passphrase' });
    const wrongSync = await wrong.service.syncMemory();
    expect(wrongSync.report.ok).toBe(false);
    expect(wrongSync.report.error).toMatch(/E2E decryption failed/i);
    expect(wrong.service.getState().records.find((r) => r.id === record.id)).toBeUndefined();
  }, 30_000);

  it('reports the actual connection error instead of faking success', async () => {
    const provider = new CloudStorageProvider({
      config: { ...config(), baseUrl: 'http://127.0.0.1:1' },
      deviceId: 'probe',
      timeoutMs: 800,
    });
    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.configured).toBe(true);
    expect(health.message).toMatch(/fail|refus|timed out|ECONNREFUSED/i);
  });

  it('requires the bearer token', async () => {
    const response = await fetch(`${BASE_URL}/changes?since=0`, {
      headers: { Authorization: 'Bearer wrong', 'X-Tenant-Id': 'test', 'X-Device-Id': 'probe' },
    });
    expect(response.status).toBe(401);
  });

  it('deletes only the confirmed tenant’s cloud data', async () => {
    const provider = new CloudStorageProvider({ config: config(), deviceId: 'probe', timeoutMs: 3000 });
    const usageBefore = await provider.usage();
    expect((usageBefore?.records ?? 0)).toBeGreaterThan(0);
    expect(await provider.deleteTenantData()).toBe(true);
    const usageAfter = await provider.usage();
    expect(usageAfter?.records ?? 0).toBe(0);
  });
});
