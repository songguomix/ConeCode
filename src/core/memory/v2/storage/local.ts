// Local Provider — local-first, offline-capable, fast reads.
//
// Persists through the Electron main process (atomic temp-file + rename, see
// electron/memory2.store.ts). The renderer keeps a loaded working set; a commit
// writes the whole state atomically. Search is local BM25, so an offline Agent
// keeps working with zero network dependency.

import type { Memory2State, MemoryQuery, SearchHit, StorageHealth } from '../types';
import { searchRecords } from '../retrieval';
import {
  emptyState, notSupported, type Memory2Bridge, type MemoryStorageProvider,
  type PushResult, type RemoteChanges,
} from './interface';

export class LocalStorageProvider implements MemoryStorageProvider {
  readonly kind = 'local' as const;
  readonly label = 'Local (Electron userData / atomic JSON + Markdown)';
  readonly supportsSync = false;
  private cache: Memory2State = emptyState();
  private bridge: Memory2Bridge | null;
  private ready = false;
  private loadOk = false;

  constructor(bridge: Memory2Bridge | null) { this.bridge = bridge; }

  /** True only when a real on-disk store loaded successfully (not the in-memory fallback). */
  get durable(): boolean { return !!this.bridge && this.loadOk; }

  async init(): Promise<void> {
    if (this.bridge) {
      try {
        const loaded = await this.bridge.load();
        this.cache = loaded && loaded.schema === 2 ? loaded : emptyState();
        this.loadOk = true;
        this.ready = true;
        return;
      } catch {
        // A disk failure must not stop the Agent. Fall back to in-memory; the
        // caller sees durable=false and keeps the legacy panel instead of
        // silently presenting an empty Memory 2.0 store.
      }
    }
    this.cache = emptyState();
    this.loadOk = false;
    this.ready = true;
  }

  async health(): Promise<StorageHealth> {
    return {
      ok: this.ready,
      kind: 'local',
      configured: this.durable,
      message: this.durable ? 'Local persistent store is available' : 'In-memory fallback (no Electron bridge)',
    };
  }

  async load(): Promise<Memory2State> { return this.cache; }

  async save(state: Memory2State): Promise<void> {
    if (this.bridge) {
      // Surface write failures instead of silently reporting success. The
      // in-memory cache advances only after the atomic disk write succeeds.
      const ok = await this.bridge.save(state);
      if (!ok) throw new Error('local memory commit failed');
    }
    this.cache = state;
  }

  async search(query: MemoryQuery): Promise<SearchHit[]> {
    return searchRecords(this.cache.records, query, { source: 'local' });
  }

  async remoteChanges(): Promise<RemoteChanges> { return notSupported('remoteChanges on local storage'); }
  async pushChanges(): Promise<PushResult> { return notSupported('pushChanges on local storage'); }

  async putObject(key: string, content: string): Promise<boolean> {
    return this.bridge ? this.bridge.putObject(key, content) : false;
  }
  async getObject(key: string): Promise<string | null> {
    return this.bridge ? this.bridge.getObject(key) : null;
  }

  async backup(): Promise<string | null> {
    if (!this.bridge) return null;
    const result = await this.bridge.backup();
    return result.ok ? result.path ?? 'backup' : null;
  }

  async restore(): Promise<boolean> {
    if (!this.bridge) return false;
    const result = await this.bridge.restore();
    if (result.ok && result.state) this.cache = result.state;
    return result.ok;
  }

  deviceId(): Promise<string> {
    return this.bridge ? this.bridge.deviceId() : Promise.resolve('renderer-fallback');
  }

  legacySnapshot(): ReturnType<Memory2Bridge['legacySnapshot']> {
    return this.bridge
      ? this.bridge.legacySnapshot()
      : Promise.resolve({ entries: [], files: [] });
  }

  projectId(rootPath: string): Promise<string> {
    return this.bridge ? this.bridge.projectId(rootPath) : Promise.resolve('');
  }
}
