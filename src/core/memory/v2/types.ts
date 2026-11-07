// Memory 2.0 — canonical data model.
//
// Everything in this file is data only: no I/O, no Electron, no provider calls.
// The whole engine is built on these shapes so local storage, cloud storage,
// the sync engine and the UI all speak exactly the same language.
//
// Design note: the legacy system (src/core/memory/memory.ts) had one flat list
// of ~60 short strings with a `kind` and a `hits` counter. That cannot express
// "this decision replaced that one", "this fact was inferred, not stated", or
// "this was deleted on another device". Every field below exists because of a
// concrete capability the flat model could not support.

/** The five layers. `global`/`project` are scopes AND layers; isolation is enforced in retrieval. */
export type MemoryLayer = 'global' | 'project' | 'episodic' | 'semantic' | 'working';

/** What a record *is*, independent of where it lives. */
export type MemoryType =
  | 'user_fact'
  | 'project_fact'
  | 'architecture'
  | 'technical_decision'
  | 'decision_reason'
  | 'constraint'
  | 'task_result'
  | 'progress'
  | 'todo'
  | 'success_experience'
  | 'failure_experience'
  | 'known_bug'
  | 'reusable_knowledge';

/** Confirmed = the user said it. Inferred = the agent concluded it. Never blur these. */
export type MemoryStatus = 'confirmed' | 'inferred' | 'pending' | 'superseded' | 'archived';

/** Where a record came from — the basis for trust and for source tracing. */
export type MemoryOrigin = 'user' | 'extracted' | 'manual' | 'migration' | 'tool' | 'sync';

export type SyncStatus = 'local' | 'pending' | 'synced' | 'conflict';

export type RelationKind =
  | 'related'
  | 'supersedes'
  | 'derived_from'
  | 'caused_by'
  | 'solves'
  | 'part_of'
  | 'conflicts_with';

export interface MemoryRelation {
  targetId: string;
  kind: RelationKind;
  note?: string;
}

/** An immutable snapshot kept whenever a record changes. Enables history + undo. */
export interface MemoryVersion {
  version: number;
  title: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  tags: string[];
  relatedMemoryIds: string[];
  why?: string;
  at: number;
  deviceId: string;
  reason: string;
}

export interface MemoryRecord {
  /** Stable UUID. Never regenerated during sync — this is the idempotency key. */
  id: string;
  title: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  /** null only for `global`. Every other layer is bound to exactly one project. */
  projectId: string | null;
  tags: string[];
  /** 0..1. Drives ranking and delete/overwrite protection. */
  importance: number;
  /** 0..1. Explicit facts > agent inferences. */
  confidence: number;
  status: MemoryStatus;
  origin: MemoryOrigin;
  sourceSessionId?: string;
  sourceEventId?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  relatedMemoryIds: string[];
  relations: MemoryRelation[];
  /** Short evidence / decision rationale. */
  why?: string;
  /** Unclassifiable migrated content lands here for later triage. */
  needsTriage?: boolean;
  history: MemoryVersion[];
  /** Set when this record is one side of an unresolved multi-device conflict. */
  conflictWith?: string;

  // ---- sync envelope ----------------------------------------------------
  deviceId: string;
  syncStatus: SyncStatus;
  contentHash: string;
  /** Tombstone. A deleted record is never hard-removed from the change log. */
  deletedAt: number | null;
}

/** Append-only change log entry. `seq` is the sync cursor. */
export interface MemoryChange {
  seq: number;
  changeId: string;
  memoryId: string;
  op: 'create' | 'update' | 'delete' | 'conflict';
  record: MemoryRecord | null;
  at: number;
  deviceId: string;
  projectId: string | null;
}

/** An unresolved conflict keeps BOTH versions and waits for a human decision. */
export interface MemoryConflict {
  id: string;
  memoryId: string;
  local: MemoryRecord;
  remote: MemoryRecord;
  base?: MemoryRecord;
  detectedAt: number;
  resolved: boolean;
}

export type StorageKind = 'local' | 'cloud' | 'memory';

export interface StorageHealth {
  ok: boolean;
  kind: StorageKind;
  message: string;
  latencyMs?: number;
  /** Set by cloud providers so the UI never displays a fabricated success. */
  configured: boolean;
}

export interface CloudConfig {
  enabled: boolean;
  /**
   * `rest` / `custom` use the documented REST gateway; `google-drive` uses
   * Google Drive's hidden appDataFolder through OAuth.
   */
  provider: 'rest' | 'custom' | 'google-drive';
  baseUrl: string;
  /** Bearer token. Stored locally, never logged, masked in the UI. */
  authToken: string;
  /** Public OAuth client id for Google Drive. The client secret lives only in the main process vault. */
  googleClientId?: string;
  /** User/tenant namespace. The server enforces this boundary. */
  tenantId: string;
  autoSync: boolean;
  syncIntervalMs: number;
  /** 'transport' | 'server-at-rest' | 'e2e'. See security.ts for the honest trade-off. */
  encryption: 'transport' | 'server-at-rest' | 'e2e';
  /** Client-held passphrase for E2E. Never transmitted; empty means E2E is not usable. */
  e2ePassphrase: string;
  /** Refuse plain http except loopback (development). */
  tlsOnly: boolean;
}

export interface CloudUsage {
  records: number;
  changes: number;
  objects: number;
  bytes: number;
  devices: { deviceId: string; lastSeenAt: number }[];
  accountEmail?: string;
  quotaUsed?: number;
  quotaLimit?: number;
}

export interface GoogleDriveStatus {
  /** OAuth client credentials are available (environment or saved). */
  configured: boolean;
  connected: boolean;
  email?: string;
  /** Public OAuth client id, when one is configured. */
  clientId?: string;
  clientIdSet: boolean;
  source: 'env' | 'saved' | 'none';
  error?: string;
}

export const DEFAULT_CLOUD_CONFIG: CloudConfig = {
  enabled: false,
  provider: 'rest',
  baseUrl: '',
  authToken: '',
  googleClientId: '',
  tenantId: 'default',
  autoSync: true,
  syncIntervalMs: 60_000,
  encryption: 'transport',
  e2ePassphrase: '',
  tlsOnly: true,
};

export interface SyncState {
  /** Last applied cloud change seq. Incremental sync resumes from here. */
  cloudCursor: number;
  /** Last pushed local change seq. */
  pushCursor: number;
  lastSyncAt: number | null;
  lastError: string | null;
  deviceId: string;
  /** Change ids already applied — makes every pull idempotent. */
  appliedChangeIds: string[];
  pendingChanges: number;
  conflicts: MemoryConflict[];
  inFlight: boolean;
  /** Offline edits queued locally while the cloud was unreachable. */
  offlineQueueLength: number;
}

export const DEFAULT_SYNC_STATE: SyncState = {
  cloudCursor: 0,
  pushCursor: 0,
  lastSyncAt: null,
  lastError: null,
  deviceId: '',
  appliedChangeIds: [],
  pendingChanges: 0,
  conflicts: [],
  inFlight: false,
  offlineQueueLength: 0,
};

/** A ranked retrieval hit. Provenance is mandatory — results must be traceable. */
export interface SearchHit {
  record: MemoryRecord;
  score: number;
  /** 'local' | 'cloud' — hybrid retrieval keeps this even after merging. */
  source: StorageKind;
  matchedTerms: string[];
  /** Why this hit was returned, for the UI and for debugging ranking. */
  reasons: string[];
}

export interface MemoryQuery {
  text: string;
  /** 'all' | 'project' | 'global' | 'local' | 'cloud' */
  scope?: 'all' | 'project' | 'global' | 'local' | 'cloud';
  projectId?: string | null;
  layers?: MemoryLayer[];
  types?: MemoryType[];
  statuses?: MemoryStatus[];
  tags?: string[];
  importanceMin?: number;
  confidenceMin?: number;
  from?: number;
  to?: number;
  sourceSessionId?: string;
  includeDeleted?: boolean;
  /** Expand along the relation graph (e.g. network module -> its historical bugs). */
  includeRelated?: boolean;
  relatedDepth?: number;
  limit?: number;
}

/** Persisted app state for the v2 store (one atomic file). */
export interface Memory2State {
  schema: 2;
  records: MemoryRecord[];
  changes: MemoryChange[];
  sync: SyncState;
  cloud: CloudConfig;
  /** Migration markers — make migration idempotent and non-destructive. */
  migration: {
    legacyDone: boolean;
    filesDone: boolean;
    sourceHashes: string[];
    at: number | null;
    report?: MigrationReport;
  };
  settings: {
    enabled: boolean;
    maxContextChars: number;
    autoExtract: boolean;
    /** Persist the current task as a working-memory row. */
    trackWorkingMemory: boolean;
    workingMemoryTTL: number;
  };
}

export interface MigrationReport {
  legacyEntries: number;
  fileLines: number;
  imported: number;
  skippedDuplicates: number;
  /** Project-scoped entries belonging to a different workspace: kept in the old store, never imported here. */
  skippedOtherProject: number;
  /** Project-scoped entries seen while no project is open. */
  skippedNoProject: number;
  needsTriage: number;
  sourceHash: string;
  backupPath: string | null;
  verified: boolean;
  at: number;
}

export const EMPTY_MEMORY2_STATE: Memory2State = {
  schema: 2,
  records: [],
  changes: [],
  sync: { ...DEFAULT_SYNC_STATE },
  cloud: { ...DEFAULT_CLOUD_CONFIG },
  migration: { legacyDone: false, filesDone: false, sourceHashes: [], at: null },
  settings: { enabled: true, maxContextChars: 6000, autoExtract: true, trackWorkingMemory: true, workingMemoryTTL: 24 * 3600_000 },
};

export const MEMORY_LAYERS: MemoryLayer[] = ['global', 'project', 'episodic', 'semantic', 'working'];
export const MEMORY_TYPES: MemoryType[] = [
  'user_fact', 'project_fact', 'architecture', 'technical_decision', 'decision_reason',
  'constraint', 'task_result', 'progress', 'todo', 'success_experience',
  'failure_experience', 'known_bug', 'reusable_knowledge',
];
export const MEMORY_STATUSES: MemoryStatus[] = ['confirmed', 'inferred', 'pending', 'superseded', 'archived'];
