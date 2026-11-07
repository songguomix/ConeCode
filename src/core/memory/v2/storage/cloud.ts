// Cloud Provider — vendor-neutral REST client.
//
// It talks to ANY endpoint implementing the contract in
// docs/memory-2.0-cloud.md. A PostgreSQL deployment handles structured records,
// relations and sync cursors; S3/R2-compatible object storage handles Markdown,
// attachments and backups. Neither is hard-coded here: this client only needs a
// conforming HTTP gateway, an auth token and a tenant id.
//
// No fake success: health() performs a real network round-trip and reports the
// actual error when the endpoint is missing, unreachable or unauthorised.

import type {
  CloudConfig, CloudUsage, Memory2State, MemoryChange, MemoryQuery, SearchHit, StorageHealth,
} from '../types';
import { normalizeRecord } from '../model';
import { decryptRecord, encryptRecord, validateCloudTransport } from '../security';
import {
  notSupported, type MemoryStorageProvider, type PushResult, type RemoteChanges,
} from './interface';

export type { CloudUsage } from '../types';

export class CloudStorageProvider implements MemoryStorageProvider {
  readonly kind = 'cloud' as const;
  readonly label = 'Cloud REST provider';
  readonly supportsSync = true;
  private config: CloudConfig;
  private deviceId: string;
  private timeoutMs: number;
  private lastError: string | null = null;
  /** Injectable for tests; defaults to the platform fetch. */
  private fetchImpl: typeof fetch;

  constructor(opts: {
    config: CloudConfig;
    deviceId: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.config = { ...opts.config };
    this.deviceId = opts.deviceId;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  updateConfig(config: CloudConfig): void { this.config = { ...config }; }

  get currentConfig(): CloudConfig { return { ...this.config }; }
  get error(): string | null { return this.lastError; }

  async init(): Promise<void> { /* no connection is opened until health()/sync */ }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.authToken}`,
      'X-Tenant-Id': this.config.tenantId,
      'X-Device-Id': this.deviceId,
    };
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const check = validateCloudTransport(this.config);
    if (!check.ok) throw new Error(check.error);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url(path), {
        ...init,
        headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
      this.lastError = null;
      return await response.json() as T;
    } catch (e: any) {
      this.lastError = e?.name === 'AbortError' ? `request timed out after ${this.timeoutMs}ms` : (e?.message ?? String(e));
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<StorageHealth> {
    const started = Date.now();
    const configured = !!(this.config.baseUrl && this.config.authToken);
    const check = validateCloudTransport(this.config);
    if (!check.ok) {
      return { ok: false, kind: 'cloud', configured, message: check.error ?? 'not configured' };
    }
    try {
      const result = await this.request<{ ok: boolean; service?: string; version?: number }>('/health');
      // A 200 from an unrelated server is NOT a valid memory cloud.
      if (!result?.ok || !result?.service) {
        return { ok: false, kind: 'cloud', configured, message: 'endpoint responded but is not a ConeCode memory service' };
      }
      return {
        ok: true, kind: 'cloud', configured, latencyMs: Date.now() - started,
        message: `${result.service} v${result.version ?? '?'} · tenant ${this.config.tenantId}`,
      };
    } catch (e: any) {
      return { ok: false, kind: 'cloud', configured, message: e?.message ?? 'connection failed' };
    }
  }

  /** Cloud provider never bulk-downloads memory at task start. */
  async load(): Promise<Memory2State> { return notSupported('bulk load on cloud storage'); }
  async save(_state: Memory2State): Promise<void> { return notSupported('bulk save on cloud storage'); }

  async search(query: MemoryQuery): Promise<SearchHit[]> {
    // Honest limitation: an E2E server holds ciphertext and cannot run plaintext
    // full-text/semantic queries. Callers fall back to the local decrypted cache.
    if (this.config.encryption === 'e2e') return [];
    const body = await this.request<{ hits: any[] }>('/search', {
      method: 'POST',
      body: JSON.stringify({ tenantId: this.config.tenantId, query }),
    });
    const hits: SearchHit[] = [];
    for (const h of body.hits ?? []) {
      const record = normalizeRecord(h.record);
      if (!record) continue;
      hits.push({
        record,
        score: Number(h.score) || 0,
        source: 'cloud',
        matchedTerms: Array.isArray(h.matchedTerms) ? h.matchedTerms : [],
        reasons: [...(Array.isArray(h.reasons) ? h.reasons : []), 'cloud full-text'],
      });
    }
    return hits;
  }

  async remoteChanges(since: number, limit = 200): Promise<RemoteChanges> {
    const q = new URLSearchParams({ since: String(since), limit: String(limit) });
    try {
      const body = await this.request<{ changes: any[]; cursor: number }>(`/changes?${q.toString()}`);
      const changes: MemoryChange[] = [];
      for (const c of body.changes ?? []) {
        let record = c.record ? normalizeRecord(c.record) : null;
        if (record && this.config.encryption === 'e2e') {
          try {
            record = await decryptRecord(record, this.config.e2ePassphrase);
          } catch (e: any) {
            // Never apply ciphertext over a local plaintext cache. A wrong or
            // missing passphrase is a configuration error, not a record.
            return {
              changes: [],
              cursor: since,
              error: `E2E decryption failed: ${e?.message ?? String(e)}`,
            };
          }
        }
        changes.push({ ...c, record });
      }
      return { changes, cursor: Number(body.cursor) || since };
    } catch (e: any) {
      return { changes: [], cursor: since, error: e?.message ?? 'pull failed' };
    }
  }

  async pushChanges(changes: MemoryChange[]): Promise<PushResult> {
    const e2e = this.config.encryption === 'e2e';
    const outbound = [];
    try {
      for (const change of changes) {
        if (!change.record) { outbound.push(change); continue; }
        const record = e2e ? await encryptRecord(change.record, this.config.e2ePassphrase) : change.record;
        outbound.push({ ...change, record });
      }
    } catch (e: any) {
      return { ok: false, acceptedChangeIds: [], cursor: 0, conflicts: [], error: `E2E encryption failed: ${e?.message ?? String(e)}` };
    }
    try {
      const body = await this.request<{
        ok: boolean; acceptedChangeIds: string[]; cursor: number; conflicts: any[];
      }>('/changes', {
        method: 'POST',
        body: JSON.stringify({ tenantId: this.config.tenantId, deviceId: this.deviceId, changes: outbound, encrypted: e2e }),
      });
      const conflicts = [];
      for (const c of body.conflicts ?? []) {
        let remote = normalizeRecord(c.remote) ?? c.remote;
        let local = normalizeRecord(c.local) ?? c.local;
        if (e2e) {
          if (remote?.content?.startsWith('e2e:v1:')) {
            remote = await decryptRecord(remote, this.config.e2ePassphrase).catch(() => remote);
          }
          if (local?.content?.startsWith('e2e:v1:')) {
            local = await decryptRecord(local, this.config.e2ePassphrase).catch(() => local);
          }
        }
        conflicts.push({ ...c, remote, local });
      }
      return {
        ok: !!body.ok,
        acceptedChangeIds: body.acceptedChangeIds ?? [],
        cursor: Number(body.cursor) || 0,
        conflicts,
      };
    } catch (e: any) {
      return { ok: false, acceptedChangeIds: [], cursor: 0, conflicts: [], error: e?.message ?? 'push failed' };
    }
  }

  /** Decrypt E2E records after pulling them into the local cache. */
  async decryptRemoteRecords(records: any[]): Promise<any[]> {
    if (this.config.encryption !== 'e2e') return records;
    return Promise.all(records.map((r) => decryptRecord(normalizeRecord(r) ?? r, this.config.e2ePassphrase).catch(() => r)));
  }

  async putObject(key: string, content: string): Promise<boolean> {
    try {
      const result = await this.request<{ ok: boolean }>(`/objects/${encodeURIComponent(key)}`, {
        method: 'PUT', body: JSON.stringify({ content }),
      });
      return !!result.ok;
    } catch { return false; }
  }

  async getObject(key: string): Promise<string | null> {
    try {
      const result = await this.request<{ content: string | null }>(`/objects/${encodeURIComponent(key)}`);
      return result.content ?? null;
    } catch { return null; }
  }

  async usage(): Promise<CloudUsage | null> {
    try {
      const u = await this.request<any>('/usage');
      return {
        records: Number(u.records) || 0,
        changes: Number(u.changes) || 0,
        objects: Number(u.objects) || 0,
        bytes: Number(u.bytes) || 0,
        devices: Array.isArray(u.devices) ? u.devices : [],
      };
    } catch { return null; }
  }

  async devices(): Promise<{ deviceId: string; lastSeenAt: number }[]> {
    try {
      const result = await this.request<{ devices?: any[]; revoked?: string[] }>('/devices');
      const revoked = new Set(Array.isArray(result.revoked) ? result.revoked : []);
      return (result.devices ?? [])
        .filter((d) => d && typeof d.deviceId === 'string' && !revoked.has(d.deviceId))
        .map((d) => ({ deviceId: d.deviceId, lastSeenAt: Number(d.lastSeenAt) || 0 }));
    } catch { return []; }
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    try {
      const result = await this.request<{ ok: boolean }>('/devices/revoke', {
        method: 'POST', body: JSON.stringify({ deviceId }),
      });
      return !!result.ok;
    } catch { return false; }
  }

  async deleteTenantData(): Promise<boolean> {
    try {
      const result = await this.request<{ ok: boolean }>('/tenant/delete', {
        method: 'POST',
        body: JSON.stringify({ confirm: this.config.tenantId }),
      });
      return !!result.ok;
    } catch { return false; }
  }

  async backup(): Promise<string | null> {
    try {
      const result = await this.request<{ ok: boolean; key?: string }>('/backup', { method: 'POST', body: '{}' });
      return result.ok ? result.key ?? 'cloud-backup' : null;
    } catch { return null; }
  }

  async restore(): Promise<boolean> {
    try {
      const result = await this.request<{ ok: boolean }>('/restore', { method: 'POST', body: '{}' });
      return !!result.ok;
    } catch { return false; }
  }
}
