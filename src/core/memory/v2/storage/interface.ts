// Unified Memory Storage Interface.
//
// Business logic (service, extractor, sync engine) never talks to a file, a
// database or an HTTP client directly. It talks to this interface. Local and
// cloud are therefore interchangeable from the engine's point of view, and a
// PostgreSQL / S3 / R2 gateway only has to implement the documented REST
// contract — no vendor is baked into the Memory Engine.

import type {
  CloudConfig, CloudUsage, Memory2State, MemoryChange, MemoryConflict,
  MemoryQuery, MemoryRecord, SearchHit, StorageHealth, StorageKind, SyncState,
} from '../types';

export interface Memory2Meta {
  sync: SyncState;
  cloud: CloudConfig;
  migration: Memory2State['migration'];
  settings: Memory2State['settings'];
}

export interface PushResult {
  ok: boolean;
  /** Change ids the server accepted — used for idempotency and cursor advance. */
  acceptedChangeIds: string[];
  cursor: number;
  conflicts: MemoryConflict[];
  error?: string;
}

export interface RemoteChanges {
  changes: MemoryChange[];
  cursor: number;
  error?: string;
}

export interface MemoryStorageProvider {
  readonly kind: StorageKind;
  readonly label: string;
  /** Cloud providers implement incremental endpoints; local ones do not. */
  readonly supportsSync: boolean;

  init(): Promise<void>;
  health(): Promise<StorageHealth>;

  /** Local: the whole atomic state. Cloud: not supported (never bulk-download). */
  load(): Promise<Memory2State>;
  save(state: Memory2State): Promise<void>;

  /** Local: BM25 over the loaded records. Cloud: real server-side query. */
  search(query: MemoryQuery): Promise<SearchHit[]>;

  /** Cloud only: incremental change feed since a cursor. */
  remoteChanges(since: number, limit?: number): Promise<RemoteChanges>;
  /** Cloud only: push a batch of local changes. */
  pushChanges(changes: MemoryChange[]): Promise<PushResult>;

  /** Markdown / attachments / backups — object data, never transactional state. */
  putObject(key: string, content: string): Promise<boolean>;
  getObject(key: string): Promise<string | null>;

  /** Never destructively clear old memory; backup returns the written path. */
  backup(): Promise<string | null>;
  restore(): Promise<boolean>;

  /** Optional cloud capabilities. Providers that do not implement them return null/false. */
  usage?(): Promise<CloudUsage | null>;
  devices?(): Promise<{ deviceId: string; lastSeenAt: number }[]>;
  revokeDevice?(deviceId: string): Promise<boolean>;
  deleteTenantData?(): Promise<boolean>;
  /** Snapshot-style providers (Google Drive) can return a full state for restore. */
  restoreSnapshot?(): Promise<Memory2State | null>;

  close?(): Promise<void>;
}

/** Bridge exposed by Electron's preload. Optional so tests can omit it. */
export interface Memory2Bridge {
  load(): Promise<Memory2State>;
  save(state: Memory2State): Promise<boolean>;
  backup(): Promise<{ ok: boolean; path?: string }>;
  restore(): Promise<{ ok: boolean; state?: Memory2State }>;
  putObject(key: string, content: string): Promise<boolean>;
  getObject(key: string): Promise<string | null>;
  deviceId(): Promise<string>;
  /** Read a legacy memory.json + memory files without modifying them. */
  legacySnapshot(): Promise<{ entries: any[]; files: { path: string; scope: string; content: string }[] }>;
  /** Resolve/create a stable per-project UUID stored in <root>/.conecode/. */
  projectId(rootPath: string): Promise<string>;
}

export function notSupported(method: string): never {
  throw new Error(`${method} is not supported by this storage provider`);
}

export function emptyState(): Memory2State {
  return {
    schema: 2,
    records: [],
    changes: [],
    sync: {
      cloudCursor: 0, pushCursor: 0, lastSyncAt: null, lastError: null,
      deviceId: '', appliedChangeIds: [], pendingChanges: 0, conflicts: [],
      inFlight: false, offlineQueueLength: 0,
    },
    cloud: {
      enabled: false, provider: 'rest', baseUrl: '', authToken: '', googleClientId: '',
      tenantId: 'default', autoSync: true, syncIntervalMs: 60_000,
      encryption: 'transport', e2ePassphrase: '', tlsOnly: true,
    },
    migration: { legacyDone: false, filesDone: false, sourceHashes: [], at: null },
    settings: { enabled: true, maxContextChars: 6000, autoExtract: true, trackWorkingMemory: true, workingMemoryTTL: 24 * 3600_000 },
  };
}

export function mergeMetaIntoState(state: Memory2State, meta: Partial<Memory2Meta>): Memory2State {
  return {
    ...state,
    sync: meta.sync ?? state.sync,
    cloud: meta.cloud ?? state.cloud,
    migration: meta.migration ?? state.migration,
    settings: meta.settings ?? state.settings,
  };
}

export function metaOf(state: Memory2State): Memory2Meta {
  return { sync: state.sync, cloud: state.cloud, migration: state.migration, settings: state.settings };
}

/** Whether a provider result is a *real* connection, not a stubbed success. */
export function isRealCloud(provider: MemoryStorageProvider | null, health: StorageHealth | null): boolean {
  return !!provider && provider.supportsSync && !!health?.ok && !!health.configured;
}

export function recordById(state: Memory2State, id: string): MemoryRecord | null {
  return state.records.find((r) => r.id === id) ?? null;
}
