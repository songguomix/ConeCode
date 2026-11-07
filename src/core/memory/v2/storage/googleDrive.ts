// Google Drive cloud provider (renderer side).
//
// The OAuth refresh token and Google client secret never enter the renderer:
// the Electron main process owns them and exposes only the narrow operations
// below. Structured state is stored as one JSON file in Drive's hidden
// appDataFolder, with an ETag-conditional update for basic multi-device safety.
// This is a real remote store, not a renamed local cache.

import type {
  CloudUsage, GoogleDriveStatus, Memory2State, MemoryChange, MemoryQuery,
  SearchHit, StorageHealth,
} from '../types';
import { normalizeRecord } from '../model';
import { decryptRecord, encryptRecord } from '../security';
import {
  emptyState, notSupported, type MemoryStorageProvider, type PushResult, type RemoteChanges,
} from './interface';

export interface GoogleDriveBridge {
  status(): Promise<GoogleDriveStatus>;
  configure(opts: { clientId?: string; clientSecret?: string }): Promise<GoogleDriveStatus>;
  connect(opts?: { clientId?: string; clientSecret?: string }): Promise<{ ok: boolean; status?: GoogleDriveStatus; error?: string }>;
  disconnect(): Promise<boolean>;
  health(): Promise<StorageHealth>;
  search(tenantId: string, query: MemoryQuery): Promise<SearchHit[]>;
  remoteChanges(tenantId: string, since: number, limit?: number): Promise<RemoteChanges>;
  pushChanges(tenantId: string, changes: MemoryChange[]): Promise<PushResult>;
  backup(tenantId: string): Promise<string | null>;
  restore(tenantId: string): Promise<boolean>;
  restoreSnapshot(tenantId: string): Promise<Memory2State | null>;
  putObject(tenantId: string, key: string, content: string): Promise<boolean>;
  getObject(tenantId: string, key: string): Promise<string | null>;
  usage(tenantId: string): Promise<CloudUsage | null>;
  devices(tenantId: string): Promise<{ deviceId: string; lastSeenAt: number }[]>;
  revokeDevice(tenantId: string, deviceId: string): Promise<boolean>;
  deleteTenantData(tenantId: string): Promise<boolean>;
}

export class GoogleDriveStorageProvider implements MemoryStorageProvider {
  readonly kind = 'cloud' as const;
  readonly label = 'Google Drive (appDataFolder)';
  readonly supportsSync = true;
  private config: { tenantId: string; encryption: 'transport' | 'server-at-rest' | 'e2e'; e2ePassphrase: string };
  private bridge: GoogleDriveBridge | null;

  constructor(bridge: GoogleDriveBridge | null, config: { tenantId: string; encryption: 'transport' | 'server-at-rest' | 'e2e'; e2ePassphrase: string }) {
    this.bridge = bridge;
    this.config = { ...config };
  }

  updateConfig(config: { tenantId: string; encryption: 'transport' | 'server-at-rest' | 'e2e'; e2ePassphrase: string }): void {
    this.config = { ...config };
  }

  async init(): Promise<void> { /* no connection until health/sync */ }

  async health(): Promise<StorageHealth> {
    if (!this.bridge) {
      return { ok: false, kind: 'cloud', configured: false, message: 'Google Drive bridge is unavailable in this runtime' };
    }
    return this.bridge.health();
  }

  async load(): Promise<Memory2State> { return notSupported('bulk load on Google Drive'); }
  async save(_state: Memory2State): Promise<void> { return notSupported('bulk save on Google Drive'); }

  async search(query: MemoryQuery): Promise<SearchHit[]> {
    // Under E2E the main process only holds ciphertext; the local decrypted
    // cache is the searchable copy, exactly like the REST provider.
    if (this.config.encryption === 'e2e' || !this.bridge) return [];
    return this.bridge.search(this.config.tenantId, query);
  }

  async remoteChanges(since: number, limit = 200): Promise<RemoteChanges> {
    if (!this.bridge) return { changes: [], cursor: since, error: 'Google Drive bridge is unavailable' };
    const remote = await this.bridge.remoteChanges(this.config.tenantId, since, limit);
    if (remote.error) return remote;
    const changes: MemoryChange[] = [];
    for (const change of remote.changes) {
      let record = change.record ? normalizeRecord(change.record) : null;
      if (record && this.config.encryption === 'e2e') {
        try {
          record = await decryptRecord(record, this.config.e2ePassphrase);
        } catch (e: any) {
          return { changes: [], cursor: since, error: `E2E decryption failed: ${e?.message ?? String(e)}` };
        }
      }
      changes.push({ ...change, record });
    }
    return { changes, cursor: remote.cursor };
  }

  async pushChanges(changes: MemoryChange[]): Promise<PushResult> {
    if (!this.bridge) return { ok: false, acceptedChangeIds: [], cursor: 0, conflicts: [], error: 'Google Drive bridge is unavailable' };
    const e2e = this.config.encryption === 'e2e';
    const outbound: MemoryChange[] = [];
    try {
      for (const change of changes) {
        if (!change.record) { outbound.push(change); continue; }
        const record = e2e ? await encryptRecord(change.record, this.config.e2ePassphrase) : change.record;
        outbound.push({ ...change, record });
      }
    } catch (e: any) {
      return { ok: false, acceptedChangeIds: [], cursor: 0, conflicts: [], error: `E2E encryption failed: ${e?.message ?? String(e)}` };
    }
    const result = await this.bridge.pushChanges(this.config.tenantId, outbound);
    if (!e2e) return result;
    const conflicts = [];
    for (const conflict of result.conflicts) {
      const remote = conflict.remote?.content?.startsWith('e2e:v1:')
        ? await decryptRecord(conflict.remote, this.config.e2ePassphrase).catch(() => conflict.remote)
        : conflict.remote;
      const local = conflict.local?.content?.startsWith('e2e:v1:')
        ? await decryptRecord(conflict.local, this.config.e2ePassphrase).catch(() => conflict.local)
        : conflict.local;
      conflicts.push({ ...conflict, remote, local });
    }
    return { ...result, conflicts };
  }

  async backup(): Promise<string | null> {
    return this.bridge ? this.bridge.backup(this.config.tenantId) : null;
  }

  async restore(): Promise<boolean> {
    return this.bridge ? this.bridge.restore(this.config.tenantId) : false;
  }

  async restoreSnapshot(): Promise<Memory2State | null> {
    if (!this.bridge) return null;
    const remote = await this.bridge.restoreSnapshot(this.config.tenantId);
    if (!remote) return null;
    const state = emptyState();
    return {
      ...state,
      records: remote.records ?? [],
      changes: remote.changes ?? [],
      sync: { ...state.sync, cloudCursor: 0, pushCursor: 0 },
    };
  }

  async putObject(key: string, content: string): Promise<boolean> {
    return this.bridge ? this.bridge.putObject(this.config.tenantId, key, content) : false;
  }

  async getObject(key: string): Promise<string | null> {
    return this.bridge ? this.bridge.getObject(this.config.tenantId, key) : null;
  }

  async usage(): Promise<CloudUsage | null> {
    return this.bridge ? this.bridge.usage(this.config.tenantId) : null;
  }

  async devices(): Promise<{ deviceId: string; lastSeenAt: number }[]> {
    return this.bridge ? this.bridge.devices(this.config.tenantId) : [];
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    return this.bridge ? this.bridge.revokeDevice(this.config.tenantId, deviceId) : false;
  }

  async deleteTenantData(): Promise<boolean> {
    return this.bridge ? this.bridge.deleteTenantData(this.config.tenantId) : false;
  }
}
