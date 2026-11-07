// In-memory provider: the reference implementation of the storage interface.
// Used by tests, by the renderer when no Electron bridge exists, and as a
// stand-in for a cloud endpoint when testing sync without a network.

import type {
  Memory2State, MemoryChange, MemoryConflict, MemoryQuery, SearchHit, StorageHealth, StorageKind,
} from '../types';
import { normalizeRecord } from '../model';
import { searchRecords } from '../retrieval';
import { emptyState, notSupported, type MemoryStorageProvider, type PushResult, type RemoteChanges } from './interface';

export interface InMemoryOptions {
  kind?: StorageKind;
  supportsSync?: boolean;
  initial?: Memory2State;
  /** Simulate an outage for offline / fallback tests. */
  failHealth?: boolean;
  failPush?: boolean;
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export class InMemoryStorageProvider implements MemoryStorageProvider {
  readonly kind: StorageKind;
  readonly label: string;
  readonly supportsSync: boolean;
  private state: Memory2State;
  private backupState: Memory2State | null = null;
  private objects = new Map<string, string>();
  private remoteLog: MemoryChange[] = [];
  private remoteCursor = 0;
  private accepted = new Set<string>();
  failHealth: boolean;
  failPush: boolean;
  saveCount = 0;

  constructor(opts: InMemoryOptions = {}) {
    this.kind = opts.kind ?? 'local';
    this.label = opts.kind === 'cloud' ? 'in-memory cloud (test double)' : 'in-memory local store';
    this.supportsSync = opts.supportsSync ?? opts.kind === 'cloud';
    this.state = clone(opts.initial ?? emptyState());
    this.failHealth = opts.failHealth ?? false;
    this.failPush = opts.failPush ?? false;
  }

  async init(): Promise<void> { /* nothing to open */ }

  async health(): Promise<StorageHealth> {
    if (this.failHealth) return { ok: false, kind: this.kind, message: 'simulated outage', configured: true };
    return { ok: true, kind: this.kind, message: `${this.label} ready`, configured: true };
  }

  async load(): Promise<Memory2State> {
    if (this.supportsSync && this.kind === 'cloud') notSupported('bulk load on cloud');
    return clone(this.state);
  }

  async save(state: Memory2State): Promise<void> {
    this.state = clone({
      ...state,
      records: state.records.map((r) => normalizeRecord(r)).filter((r): r is NonNullable<typeof r> => !!r),
    });
    this.saveCount++;
  }

  async search(query: MemoryQuery): Promise<SearchHit[]> {
    return searchRecords(this.state.records, query, { source: this.kind });
  }

  /** Test helper: inject a change as if it came from another device. */
  seedRemoteChange(change: MemoryChange): void {
    this.remoteCursor = Math.max(this.remoteCursor, change.seq);
    this.remoteLog.push(clone(change));
  }

  async remoteChanges(since: number, limit = 100): Promise<RemoteChanges> {
    if (!this.supportsSync) notSupported('remoteChanges on local storage');
    if (this.failHealth) return { changes: [], cursor: since, error: 'simulated outage' };
    const changes = this.remoteLog.filter((c) => c.seq > since).slice(0, limit);
    return { changes: clone(changes), cursor: Math.max(since, ...changes.map((c) => c.seq), this.remoteCursor) };
  }

  async pushChanges(changes: MemoryChange[]): Promise<PushResult> {
    if (!this.supportsSync) notSupported('pushChanges on local storage');
    if (this.failPush) return { ok: false, acceptedChangeIds: [], cursor: this.remoteCursor, conflicts: [], error: 'simulated push failure' };
    const acceptedChangeIds: string[] = [];
    const conflicts: MemoryConflict[] = [];
    for (const change of changes) {
      if (this.accepted.has(change.changeId)) { acceptedChangeIds.push(change.changeId); continue; }
      this.accepted.add(change.changeId);
      const current = this.state.records.find((r) => r.id === change.memoryId);
      if (current && change.record
        && current.version >= change.record.version
        && current.deviceId !== change.deviceId
        && current.contentHash !== change.record.contentHash) {
        conflicts.push({
          id: `cf-${change.changeId}`,
          memoryId: change.memoryId,
          local: clone(change.record),
          remote: clone(current),
          detectedAt: Date.now(),
          resolved: false,
        });
      } else if (change.record) {
        const index = this.state.records.findIndex((r) => r.id === change.memoryId);
        if (index >= 0) this.state.records[index] = clone(change.record);
        else this.state.records.push(clone(change.record));
      }
      this.remoteCursor++;
      this.remoteLog.push({ ...clone(change), seq: this.remoteCursor });
      acceptedChangeIds.push(change.changeId);
    }
    return { ok: true, acceptedChangeIds, cursor: this.remoteCursor, conflicts };
  }

  async putObject(key: string, content: string): Promise<boolean> { this.objects.set(key, content); return true; }
  async getObject(key: string): Promise<string | null> { return this.objects.get(key) ?? null; }

  async backup(): Promise<string | null> {
    this.backupState = clone(this.state);
    return `${this.label}:backup`;
  }
  async restore(): Promise<boolean> {
    if (!this.backupState) return false;
    this.state = clone(this.backupState);
    return true;
  }

  /** Test helper for verifying persistence without exposing internals. */
  snapshot(): Memory2State { return clone(this.state); }
}
