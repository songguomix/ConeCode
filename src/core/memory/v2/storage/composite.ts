// Composite provider: Local-first + Cloud Sync + Hybrid Retrieval.
//
// One interface for the whole engine. Local is the source of truth for reads and
// writes; cloud is queried *in addition* only when configured and reachable.
// A cloud failure degrades to local silently (but is recorded) — retrieval must
// never block the Agent.

import type { Memory2State, MemoryQuery, SearchHit, StorageHealth } from '../types';
import { mergeHybrid } from '../retrieval';
import type { MemoryStorageProvider, PushResult, RemoteChanges } from './interface';

export interface HybridHealth {
  local: StorageHealth;
  cloud: StorageHealth | null;
  cloudAvailable: boolean;
  mode: 'local-only' | 'hybrid';
}

export class CompositeStorageProvider implements MemoryStorageProvider {
  readonly kind = 'local' as const;
  readonly label = 'Hybrid storage (local-first + cloud)';
  readonly supportsSync: boolean;
  readonly local: MemoryStorageProvider;
  cloud: MemoryStorageProvider | null;
  private lastCloudError: string | null = null;

  constructor(local: MemoryStorageProvider, cloud: MemoryStorageProvider | null = null) {
    this.local = local;
    this.cloud = cloud;
    this.supportsSync = !!cloud?.supportsSync;
  }

  setCloud(cloud: MemoryStorageProvider | null): void {
    this.cloud = cloud;
    (this as { supportsSync: boolean }).supportsSync = !!cloud?.supportsSync;
  }

  async init(): Promise<void> {
    await this.local.init();
    if (this.cloud) await this.cloud.init().catch(() => {});
  }

  async health(): Promise<StorageHealth> {
    const h = await this.hybridHealth();
    return {
      ok: h.local.ok,
      kind: 'local',
      configured: h.local.configured,
      message: `${h.mode}: local ${h.local.ok ? 'ok' : 'down'}, cloud ${h.cloudAvailable ? 'ok' : (h.cloud?.message ?? 'not configured')}`,
    };
  }

  async hybridHealth(): Promise<HybridHealth> {
    const local = await this.local.health();
    const cloud = this.cloud ? await this.cloud.health() : null;
    const cloudAvailable = !!cloud?.ok && !!cloud.configured;
    this.lastCloudError = cloud && !cloud.ok ? cloud.message : null;
    return { local, cloud, cloudAvailable, mode: cloudAvailable ? 'hybrid' : 'local-only' };
  }

  get cloudError(): string | null { return this.lastCloudError; }

  async load(): Promise<Memory2State> { return this.local.load(); }
  async save(state: Memory2State): Promise<void> { await this.local.save(state); }

  /** Hybrid: local BM25 + cloud server-side search, merged and re-ranked. */
  async search(query: MemoryQuery): Promise<SearchHit[]> {
    // 'cloud' must never be answered from the local cache: the UI labels the
    // source, and returning local rows there would be a false provenance claim.
    const localHits = query.scope === 'cloud' ? [] : await this.local.search(query);
    if (!this.cloud || query.scope === 'local') return localHits;
    const cloudQuery: MemoryQuery = { ...query, scope: query.scope === 'cloud' ? 'all' : query.scope };
    try {
      let cloudHits = await this.cloud.search(cloudQuery);
      // A cloud result must always carry its own project/version provenance.
      cloudHits = cloudHits.map((h) => ({
        ...h,
        source: 'cloud' as const,
        reasons: [...h.reasons, `cloud ${h.record.projectId ?? 'global'} v${h.record.version}`],
      }));
      if (query.scope === 'cloud') return cloudHits;
      return mergeHybrid(localHits, cloudHits, query);
    } catch (e: any) {
      this.lastCloudError = e?.message ?? 'cloud search failed';
      // Automatic fallback: cloud unavailability must not break the Agent.
      return localHits;
    }
  }

  async remoteChanges(since: number, limit?: number): Promise<RemoteChanges> {
    if (!this.cloud) return { changes: [], cursor: since };
    return this.cloud.remoteChanges(since, limit);
  }

  async pushChanges(changes: Parameters<MemoryStorageProvider['pushChanges']>[0]): Promise<PushResult> {
    if (!this.cloud) {
      return { ok: false, acceptedChangeIds: [], cursor: 0, conflicts: [], error: 'cloud not configured' };
    }
    return this.cloud.pushChanges(changes);
  }

  async putObject(key: string, content: string): Promise<boolean> {
    const ok = await this.local.putObject(key, content);
    if (this.cloud) void this.cloud.putObject(key, content).catch(() => false);
    return ok;
  }
  async getObject(key: string): Promise<string | null> {
    return (await this.local.getObject(key)) ?? (this.cloud ? this.cloud.getObject(key) : null);
  }
  async backup(): Promise<string | null> { return this.local.backup(); }
  async restore(): Promise<boolean> { return this.local.restore(); }
}
