import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DriveMemoryStore } from './memory-drive';
import type { Memory2SecretCodec } from './memory2.store';
import { contentHashOf, createRecord } from '../src/core/memory/v2/model';
import type { MemoryChange, MemoryRecord } from '../src/core/memory/v2/types';

const codec: Memory2SecretCodec = {
  encrypt: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
  decrypt: (cipher) => {
    const value = Buffer.from(cipher, 'base64').toString('utf-8');
    if (!value.startsWith('enc:')) throw new Error('bad secret');
    return value.slice(4);
  },
};

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-drive-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

interface FakeFile {
  id: string;
  name: string;
  content: string;
  etag: string;
  size: number;
  modifiedTime: string;
}

function fakeDrive() {
  const files = new Map<string, FakeFile>();
  let next = 1;
  let etagCounter = 1;
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers as HeadersInit | undefined);

    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      return Response.json({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/oauth2/v2/userinfo') {
      return Response.json({ email: 'drive@example.com' });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/drive/v3/about') {
      return Response.json({
        user: { displayName: 'Drive User', emailAddress: 'drive@example.com' },
        storageQuota: { limit: '1000000000', usage: '1234' },
      });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/drive/v3/files' && method === 'GET') {
      return Response.json({ files: [...files.values()].map((f) => ({ id: f.id, name: f.name, size: String(f.size), modifiedTime: f.modifiedTime })) });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/drive/v3/files' && method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      const id = `file-${next++}`;
      const file: FakeFile = {
        id, name: String(body.name || 'unnamed'), content: '',
        etag: `etag-${etagCounter++}`, size: 0, modifiedTime: new Date().toISOString(),
      };
      files.set(id, file);
      return Response.json({ id });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/upload/drive/v3/files/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop() || '');
      const file = files.get(id);
      if (!file) return new Response('not found', { status: 404 });
      const ifMatch = headers.get('if-match');
      if (ifMatch && ifMatch !== file.etag) return new Response('precondition failed', { status: 412 });
      file.content = String(init.body || '');
      file.size = Buffer.byteLength(file.content);
      file.etag = `etag-${etagCounter++}`;
      file.modifiedTime = new Date().toISOString();
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', ETag: file.etag } });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/drive/v3/files/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop() || '');
      const file = files.get(id);
      if (!file) return new Response('not found', { status: 404 });
      if (method === 'DELETE') {
        files.delete(id);
        return new Response(null, { status: 204 });
      }
      if (url.searchParams.get('alt') === 'media') {
        return new Response(file.content, { status: 200, headers: { ETag: file.etag, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: file.id, name: file.name, modifiedTime: file.modifiedTime }), {
        status: 200, headers: { 'Content-Type': 'application/json', ETag: file.etag },
      });
    }
    return new Response(`unhandled ${method} ${url}`, { status: 500 });
  };

  const openExternal = async (authUrl: string) => {
    const parsed = new URL(authUrl);
    const redirect = parsed.searchParams.get('redirect_uri');
    const state = parsed.searchParams.get('state');
    if (!redirect || !state) throw new Error('bad auth url');
    // Simulate the browser hitting the loopback callback.
    await fetch(`${redirect}?code=test-code&state=${encodeURIComponent(state)}`);
  };

  return { fetchImpl, openExternal, files };
}

function record(id = 'm1', content = 'Google Drive stores the memory snapshot', deviceId = 'dev-a'): MemoryRecord {
  return createRecord({
    content,
    type: 'constraint',
    layer: 'global',
    status: 'confirmed',
    origin: 'user',
  }, { id, deviceId, now: 1 });
}

function change(record: MemoryRecord, seq = 1, changeId = 'c1', op: MemoryChange['op'] = 'create'): MemoryChange {
  return { seq, changeId, memoryId: record.id, op, record, at: 1, deviceId: record.deviceId, projectId: null };
}

async function connectedStore(dataDir: string) {
  const fake = fakeDrive();
  const store = new DriveMemoryStore({
    dataDir,
    secrets: codec,
    fetchImpl: fake.fetchImpl as typeof fetch,
    openExternal: fake.openExternal,
    timeoutMs: 3000,
  });
  const result = await store.connect({ clientId: 'client-id', clientSecret: 'client-secret' });
  expect(result.ok).toBe(true);
  return { store, fake };
}

describe('Google Drive memory provider', () => {
  it('completes the loopback OAuth flow and stores tokens encrypted', async () => {
    const dataDir = tempDir();
    const { store } = await connectedStore(dataDir);
    const status = store.status();
    expect(status.connected).toBe(true);
    expect(status.email).toBe('drive@example.com');
    expect(status.configured).toBe(true);
    const raw = fs.readFileSync(path.join(dataDir, 'memory-drive-auth.json'), 'utf-8');
    expect(raw).not.toContain('refresh-token');
    expect(raw).not.toContain('client-secret');
    const health = await store.health();
    expect(health.ok).toBe(true);
    expect(health.message).toContain('drive@example.com');
  });

  it('pushes, searches, backs up, restores and deletes tenant state', async () => {
    const dataDir = tempDir();
    const { store } = await connectedStore(dataDir);
    const pushed = await store.pushChanges('tenant-a', [change(record())]);
    expect(pushed.ok).toBe(true);
    expect(pushed.acceptedChangeIds).toContain('c1');

    const pulled = await store.remoteChanges('tenant-a', 0);
    expect(pulled.changes).toHaveLength(1);
    const hits = await store.search('tenant-a', { text: 'snapshot', scope: 'all' });
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('cloud');

    const backup = await store.backup('tenant-a');
    expect(backup).toContain('conecode-memory2-backup');
    const restored = await store.restoreSnapshot('tenant-a');
    expect(restored?.records.map((r) => r.id)).toContain('m1');

    const usage = await store.usage('tenant-a');
    expect(usage?.records).toBe(1);
    expect(usage?.devices.map((d) => d.deviceId)).toContain('dev-a');
    expect(usage?.accountEmail).toBe('drive@example.com');

    // Tenant isolation: another namespace has no record and no change feed.
    expect((await store.search('tenant-b', { text: 'snapshot', scope: 'all' }))).toEqual([]);
    expect((await store.remoteChanges('tenant-b', 0)).changes).toEqual([]);

    expect(await store.deleteTenantData('tenant-a')).toBe(true);
    expect((await store.remoteChanges('tenant-a', 0)).changes).toEqual([]);
  });

  it('detects concurrent same-version edits instead of overwriting them', async () => {
    const dataDir = tempDir();
    const { store } = await connectedStore(dataDir);
    const v1 = record();
    await store.pushChanges('tenant-a', [change(v1, 1, 'c1')]);

    const a = { ...v1, version: 2, content: 'A side decision', updatedAt: 2 };
    a.contentHash = contentHashOf(a);
    await store.pushChanges('tenant-a', [change(a, 2, 'c2a', 'update')]);

    const b = { ...v1, version: 2, content: 'B side decision', updatedAt: 2, deviceId: 'dev-b' };
    b.contentHash = contentHashOf(b);
    const conflict = await store.pushChanges('tenant-a', [change(b, 2, 'c2b', 'update')]);
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.conflicts[0].local.content).toContain('B side');
    expect(conflict.conflicts[0].remote.content).toContain('A side');

    const remote = await store.remoteChanges('tenant-a', 0);
    expect(remote.changes.some((c) => c.changeId === 'c2b')).toBe(false);
    expect(remote.changes.some((c) => c.changeId === 'c2a')).toBe(true);
  });
});
